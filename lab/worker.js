// Web Worker: toàn bộ tải model + chạy AI nằm ở đây để giao diện không bị treo.
// Âm thanh KHÔNG rời thiết bị: chỉ có file model được tải từ Hugging Face.
import { CONFIG } from './config.js';
import {
  getStatus, deleteModel, downloadModel, readModelBuffer, sha256Hex, classifyError,
} from './modelstore.js';
import { planBlocks, blockWeight } from './lib.js';
import { StereoSTFT, planMdxChunks, hannWeights } from './mdx.js';

const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);
const log = (m) => post('log', { m });
const heapMb = () => {
  try { return Math.round(performance.memory.usedJSHeapSize / 1048576); } catch { return null; }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const modelOf = (key) => CONFIG.models[key] || CONFIG.models[CONFIG.defaultModel];

let ort = null;
let Demucs = null;
let libInfo = {};
const hashes = {};

function isMemoryError(e) {
  const s = `${e && e.name} ${e && e.message}`;
  return /RangeError|out of memory|allocation failed|bad_alloc|memory access out of bounds|Aborted\(|OOM/i.test(s);
}

async function loadLibs(threadsOpt, needDemucs) {
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

  if (needDemucs && !Demucs) {
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

async function checkGpu(ep) {
  if (ep !== 'webgpu') return;
  if (!self.navigator.gpu) throw Object.assign(new Error('Thiết bị/trình duyệt không có WebGPU.'), { kind: 'nogpu' });
  const ad = await self.navigator.gpu.requestAdapter();
  if (!ad) throw Object.assign(new Error('Không lấy được WebGPU adapter.'), { kind: 'nogpu' });
  ort.env.webgpu = ort.env.webgpu || {};
  ort.env.webgpu.powerPreference = 'high-performance';
}

async function readAndHash(model, stage) {
  stage('read-model');
  const t = performance.now();
  const buf = await readModelBuffer(model, CONFIG.modelCacheName);
  const readMs = Math.round(performance.now() - t);
  if (!hashes[model.key]) {
    stage('hash-model');
    hashes[model.key] = await sha256Hex(buf);
    log(`SHA-256 ${model.key}: ${hashes[model.key]}`);
  }
  return { buf, readMs };
}

// ---------- HTDemucs (demucs-web) ----------
async function attemptDemucs(ep, job, model, wantProgress, stage) {
  const { left, right, blockSec } = job;
  const sr = CONFIG.sampleRate;
  const N = left.length;
  await checkGpu(ep);
  const { buf, readMs } = await readAndHash(model, stage);

  const cur = { k: 0, n: 1, last: performance.now() };
  const segMs = [];
  const processor = new Demucs({
    ort,
    sessionOptions: {
      executionProviders: [ep], enableCpuMemArena: false, enableMemPattern: false, graphOptimizationLevel: 'basic',
    },
    onProgress: (info) => {
      const now = performance.now();
      segMs.push(now - cur.last); cur.last = now;
      const inBlock = info && typeof info.progress === 'number' ? info.progress : 0;
      wantProgress({ progress: (cur.k + inBlock) / cur.n, block: cur.k + 1, blocks: cur.n });
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
    cur.k = k; cur.last = performance.now();
    const res = await processor.separate(left.slice(blk.a, blk.b), right.slice(blk.a, blk.b));
    const len = blk.b - blk.a;
    const ramp = blk.rampIn > 0 || blk.rampOut > 0;
    const { vocals, drums, bass, other } = res;
    for (let i = 0; i < len; i++) {
      const w = ramp ? blockWeight(blk, blk.a + i) : 1;
      const j = blk.a + i;
      vL[j] += w * vocals.left[i]; vR[j] += w * vocals.right[i];
      iL[j] += w * (drums.left[i] + bass.left[i] + other.left[i]);
      iR[j] += w * (drums.right[i] + bass.right[i] + other.right[i]);
    }
    const h = heapMb(); if (h && h > peakHeap) peakHeap = h;
    wantProgress({ progress: (k + 1) / plan.length, block: k + 1, blocks: plan.length });
    await tick();
  }
  return {
    out: { vL, vR, iL, iR },
    timing: { ep, readMs, loadMs, sepMs: Math.round(performance.now() - tSep), segMs, blocks: plan.length, heapAfterLoad, peakHeap, modelHash: hashes[model.key] },
  };
}

// ---------- MDX-Net (UVR) qua ONNX Runtime Web trực tiếp ----------
async function attemptMdx(ep, job, model, wantProgress, stage) {
  const { left, right } = job;
  const N = left.length;
  const { nFft, hop, dimF, dimT } = model.mdx;
  await checkGpu(ep);
  const { buf, readMs } = await readAndHash(model, stage);

  stage(`load-model(${ep})`);
  const tLoad = performance.now();
  const session = await ort.InferenceSession.create(new Uint8Array(buf), {
    executionProviders: [ep], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false,
  });
  const loadMs = Math.round(performance.now() - tLoad);
  const heapAfterLoad = heapMb();
  const inName = session.inputNames[0], outName = session.outputNames[0];
  log(`Nạp MDX (${ep}) xong trong ${loadMs} ms; input=${inName} output=${outName}`);

  const stft = new StereoSTFT(nFft, hop, dimF, dimT);
  const plan = planMdxChunks(N, hop, dimT, nFft);
  const { chunk, trim, step, K, accLen } = plan;
  const win = hannWeights(chunk);
  const accL = new Float32Array(accLen), accR = new Float32Array(accLen), wsum = new Float32Array(accLen);
  const cl = new Float32Array(chunk), cr = new Float32Array(chunk);
  const specIn = new Float32Array(4 * dimF * dimT);
  const yl = new Float32Array(chunk), yr = new Float32Array(chunk);

  stage(`separate(${ep})`);
  const tSep = performance.now();
  const segMs = [];
  let peakHeap = heapAfterLoad || 0;
  for (let k = 0; k < K; k++) {
    const t0 = performance.now();
    const s0 = k * step; // vị trí trong tín hiệu đã đệm (trim mẫu 0 ở đầu)
    // cắt chunk từ [left | right] với đệm 0 ở hai đầu
    cl.fill(0); cr.fill(0);
    const a = Math.max(0, s0 - trim), b = Math.min(N, s0 - trim + chunk);
    if (b > a) { cl.set(left.subarray(a, b), a - (s0 - trim)); cr.set(right.subarray(a, b), a - (s0 - trim)); }

    stft.forward(cl, cr, specIn);
    for (let c = 0; c < 4; c++) for (let f = 0; f < 3; f++) specIn.fill(0, (c * dimF + f) * dimT, (c * dimF + f + 1) * dimT); // như UVR: bỏ 3 bin thấp nhất
    const out = await session.run({ [inName]: new ort.Tensor('float32', specIn, [1, 4, dimF, dimT]) });
    const y = out[outName];
    stft.inverse(y.data, yl, yr);
    if (y.dispose) y.dispose();

    for (let i = 0; i < chunk; i++) {
      const w = win[i], j = s0 + i;
      accL[j] += w * yl[i]; accR[j] += w * yr[i]; wsum[j] += w;
    }
    segMs.push(performance.now() - t0);
    const h = heapMb(); if (h && h > peakHeap) peakHeap = h;
    wantProgress({ progress: (k + 1) / K, block: k + 1, blocks: K });
    await tick();
  }
  try { await session.release(); } catch { /* */ }
  const sepMs = Math.round(performance.now() - tSep);

  const vL = new Float32Array(N), vR = new Float32Array(N);
  for (let i = 0; i < N; i++) { const j = i + trim; const w = wsum[j] > 1e-9 ? wsum[j] : 1; vL[i] = accL[j] / w; vR[i] = accR[j] / w; }
  const iL = new Float32Array(N), iR = new Float32Array(N);
  for (let i = 0; i < N; i++) { iL[i] = left[i] - vL[i]; iR[i] = right[i] - vR[i]; }
  return {
    out: { vL, vR, iL, iR },
    timing: { ep, readMs, loadMs, sepMs, segMs, blocks: K, heapAfterLoad, peakHeap, modelHash: hashes[model.key] },
  };
}

async function separate(job) {
  const t0 = performance.now();
  const model = modelOf(job.model);
  const stage = (s) => post('stage', { stage: s, heapMb: heapMb() });
  stage('load-libs');
  await loadLibs(job.threads, model.kind === 'demucs');
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
      const run = model.kind === 'mdx' ? attemptMdx : attemptDemucs;
      const { out, timing } = await run(ep, job, model, wantProgress, stage);
      timing.failures = failures;
      timing.totalMs = Math.round(performance.now() - t0);
      timing.lib = libInfo;
      timing.model = model.key;
      post('result', { timing, vL: out.vL, vR: out.vR, iL: out.iL, iR: out.iR },
        [out.vL.buffer, out.vR.buffer, out.iL.buffer, out.iR.buffer]);
      return;
    } catch (e) {
      const mem = isMemoryError(e);
      failures.push({ ep, kind: e.kind || (mem ? 'memory' : 'error'), message: String((e && e.message) || e), name: e && e.name });
      log(`Backend ${ep} thất bại: ${failures[failures.length - 1].message}`);
    }
  }
  post('error', {
    stage: 'separate', failures, kind: failures.some((f) => f.kind === 'memory') ? 'memory' : 'error',
    message: failures.map((f) => `${f.ep}: ${f.message}`).join(' | '),
  });
}

self.onmessage = async (e) => {
  const m = e.data;
  const model = modelOf(m.model);
  try {
    if (m.type === 'status') {
      post('status', { model: model.key, status: await getStatus(model, CONFIG.modelCacheName) });
    } else if (m.type === 'delete') {
      await deleteModel(model, CONFIG.modelCacheName);
      post('status', { model: model.key, status: await getStatus(model, CONFIG.modelCacheName) });
    } else if (m.type === 'download') {
      let last = 0;
      try {
        const r = await downloadModel(model, CONFIG.modelCacheName, {
          onProgress: (loaded, total, estimated) => {
            const now = performance.now();
            if (now - last > 150 || loaded >= total) { last = now; post('dl-progress', { loaded, total, estimated }); }
          },
        });
        post('dl-done', { model: model.key, result: r });
      } catch (err) {
        const c = classifyError(err);
        post('dl-error', { kind: c.kind, message: c.message });
      }
      post('status', { model: model.key, status: await getStatus(model, CONFIG.modelCacheName) });
    } else if (m.type === 'separate') {
      await separate(m);
    }
  } catch (err) {
    const c = classifyError(err);
    post('error', { stage: m.type, kind: err.kind || c.kind, message: c.message || String(err) });
  }
};

post('ready');
