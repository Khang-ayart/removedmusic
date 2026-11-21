// Web Worker: toàn bộ tải model + chạy AI nằm ở đây để giao diện không bị treo.
// Âm thanh KHÔNG rời thiết bị: chỉ có file model được tải từ Hugging Face.
import { CONFIG } from './config.js';
import {
  getStatus, deleteModel, downloadModel, readModelBuffer, sha256Hex, classifyError,
} from './modelstore.js';
import { planBlocks, blockWeight } from './lib.js';

const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);
const log = (m) => post('log', { m });
const heapMb = () => {
  try { return Math.round(performance.memory.usedJSHeapSize / 1048576); } catch { return null; }
};
const tick = () => new Promise((r) => setTimeout(r, 0));

let ort = null;
let Demucs = null;
let libInfo = {};
let modelHash = null;

function isMemoryError(e) {
  const s = `${e && e.name} ${e && e.message}`;
  return /RangeError|out of memory|allocation failed|bad_alloc|memory access out of bounds|Aborted\(|OOM/i.test(s);
}

async function loadLibs(threadsOpt) {
  if (!ort) {
    const t = performance.now();
    const m = await import(CONFIG.ortUrl);
    ort = m.InferenceSession ? m : (m.default || m);
    libInfo.ortMs = Math.round(performance.now() - t);
    libInfo.ortVersion = CONFIG.ortVersion;
    try {
      const orig = ort.InferenceSession.create.bind(ort.InferenceSession);
      ort.InferenceSession.create = (...a) => {
        log('ORT.create executionProviders=' + JSON.stringify(a[1] && a[1].executionProviders));
        return orig(...a);
      };
    } catch { /* không bọc được thì bỏ qua */ }
  }
  ort.env.wasm.wasmPaths = CONFIG.ortBase;
  const isolated = self.crossOriginIsolated === true;
  const hw = self.navigator.hardwareConcurrency || 4;
  ort.env.wasm.numThreads = isolated && threadsOpt !== '1' ? Math.min(4, hw) : 1;
  ort.env.wasm.proxy = false; // đã ở trong worker
  libInfo.wasmThreads = ort.env.wasm.numThreads;
  libInfo.crossOriginIsolated = isolated;

  if (!Demucs) {
    const errs = [];
    for (const url of CONFIG.demucsUrls) {
      try {
        const t = performance.now();
        const mod = await import(url);
        Demucs = mod.DemucsProcessor || (mod.default && mod.default.DemucsProcessor);
        if (!Demucs) throw new Error('Không thấy DemucsProcessor trong module');
        libInfo.demucsFrom = url;
        libInfo.demucsMs = Math.round(performance.now() - t);
        break;
      } catch (e) {
        errs.push(`${url}: ${e.message}`);
        log('Nạp demucs-web thất bại: ' + errs[errs.length - 1]);
      }
    }
    if (!Demucs) {
      const err = new Error('Không nạp được thư viện demucs-web. ' + errs.join(' | '));
      err.kind = 'lib';
      throw err;
    }
  }
}

async function attempt(ep, job, wantProgress) {
  const { left, right, blockSec } = job;
  const sr = CONFIG.sampleRate;
  const N = left.length;
  const stage = (s) => post('stage', { stage: s, heapMb: heapMb() });

  if (ep === 'webgpu') {
    if (!self.navigator.gpu) throw Object.assign(new Error('Thiết bị/trình duyệt không có WebGPU.'), { kind: 'nogpu' });
    const ad = await self.navigator.gpu.requestAdapter();
    if (!ad) throw Object.assign(new Error('Không lấy được WebGPU adapter.'), { kind: 'nogpu' });
    ort.env.webgpu = ort.env.webgpu || {};
    ort.env.webgpu.powerPreference = 'high-performance';
  }

  stage('read-model');
  let tRead = performance.now();
  const buf = await readModelBuffer(CONFIG.model, CONFIG.modelCacheName);
  const readMs = Math.round(performance.now() - tRead);
  if (!modelHash) {
    stage('hash-model');
    modelHash = await sha256Hex(buf);
    log('SHA-256 model: ' + modelHash);
  }

  const cur = { k: 0, n: 1, last: performance.now() };
  const segMs = [];
  const processor = new Demucs({
    ort,
    sessionOptions: {
      executionProviders: [ep],
      enableCpuMemArena: false,
      enableMemPattern: false,
      graphOptimizationLevel: 'basic',
    },
    onProgress: (info) => {
      const now = performance.now();
      segMs.push(now - cur.last);
      cur.last = now;
      const inBlock = info && typeof info.progress === 'number' ? info.progress : 0;
      wantProgress({ progress: (cur.k + inBlock) / cur.n, block: cur.k + 1, blocks: cur.n, seg: info && info.currentSegment, segs: info && info.totalSegments });
    },
    onLog: (phase, msg) => log(`[demucs ${phase}] ${msg}`),
  });

  stage(`load-model(${ep})`);
  const tLoad = performance.now();
  await processor.loadModel(buf);
  const loadMs = Math.round(performance.now() - tLoad);
  const heapAfterLoad = heapMb();
  log(`Nạp model (${ep}) xong trong ${loadMs} ms`);

  const plan = blockSec > 0
    ? planBlocks(N, Math.round(blockSec * sr), Math.round(CONFIG.overlapSec * sr))
    : planBlocks(N, N, 0);
  cur.n = plan.length;

  const vL = new Float32Array(N), vR = new Float32Array(N);
  const iL = new Float32Array(N), iR = new Float32Array(N);
  stage(`separate(${ep})`);
  const tSep = performance.now();
  let peakHeap = heapAfterLoad || 0;

  for (let k = 0; k < plan.length; k++) {
    const blk = plan[k];
    cur.k = k;
    cur.last = performance.now();
    const res = await processor.separate(left.slice(blk.a, blk.b), right.slice(blk.a, blk.b));
    const len = blk.b - blk.a;
    const ramp = blk.rampIn > 0 || blk.rampOut > 0;
    const { vocals, drums, bass, other } = res;
    for (let i = 0; i < len; i++) {
      const w = ramp ? blockWeight(blk, blk.a + i) : 1;
      const j = blk.a + i;
      vL[j] += w * vocals.left[i];
      vR[j] += w * vocals.right[i];
      iL[j] += w * (drums.left[i] + bass.left[i] + other.left[i]);
      iR[j] += w * (drums.right[i] + bass.right[i] + other.right[i]);
    }
    const h = heapMb();
    if (h && h > peakHeap) peakHeap = h;
    wantProgress({ progress: (k + 1) / plan.length, block: k + 1, blocks: plan.length });
    await tick();
  }
  const sepMs = Math.round(performance.now() - tSep);

  return {
    out: { vL, vR, iL, iR },
    timing: { ep, readMs, loadMs, sepMs, segMs, blocks: plan.length, heapAfterLoad, peakHeap, modelHash },
  };
}

async function separate(job) {
  const t0 = performance.now();
  post('stage', { stage: 'load-libs', heapMb: heapMb() });
  await loadLibs(job.threads);
  const order = job.backend === 'auto' ? ['webgpu', 'wasm'] : [job.backend];
  const failures = [];
  let lastPost = 0;
  const wantProgress = (p) => {
    const now = performance.now();
    if (now - lastPost < 150 && p.progress < 1) return;
    lastPost = now;
    post('progress', p);
  };
  for (const ep of order) {
    try {
      const { out, timing } = await attempt(ep, job, wantProgress);
      timing.failures = failures;
      timing.totalMs = Math.round(performance.now() - t0);
      timing.lib = libInfo;
      post('result', { timing, vL: out.vL, vR: out.vR, iL: out.iL, iR: out.iR },
        [out.vL.buffer, out.vR.buffer, out.iL.buffer, out.iR.buffer]);
      return;
    } catch (e) {
      const mem = isMemoryError(e);
      failures.push({ ep, kind: e.kind || (mem ? 'memory' : 'error'), message: String(e && e.message || e), name: e && e.name });
      log(`Backend ${ep} thất bại: ${failures[failures.length - 1].message}`);
    }
  }
  post('error', { stage: 'separate', failures, kind: failures.some((f) => f.kind === 'memory') ? 'memory' : 'error',
    message: failures.map((f) => `${f.ep}: ${f.message}`).join(' | ') });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'status') {
      post('status', { status: await getStatus(CONFIG.model, CONFIG.modelCacheName) });
    } else if (m.type === 'delete') {
      await deleteModel(CONFIG.model, CONFIG.modelCacheName);
      post('status', { status: await getStatus(CONFIG.model, CONFIG.modelCacheName) });
    } else if (m.type === 'download') {
      let last = 0;
      try {
        const r = await downloadModel(CONFIG.model, CONFIG.modelCacheName, {
          onProgress: (loaded, total, estimated) => {
            const now = performance.now();
            if (now - last > 150 || loaded >= total) { last = now; post('dl-progress', { loaded, total, estimated }); }
          },
        });
        post('dl-done', { result: r });
      } catch (err) {
        const c = classifyError(err);
        post('dl-error', { kind: c.kind, message: c.message });
      }
      post('status', { status: await getStatus(CONFIG.model, CONFIG.modelCacheName) });
    } else if (m.type === 'separate') {
      await separate(m);
    }
  } catch (err) {
    const c = classifyError(err);
    post('error', { stage: m.type, kind: err.kind || c.kind, message: c.message || String(err) });
  }
};

post('ready');
