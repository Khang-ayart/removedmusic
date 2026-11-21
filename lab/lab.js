import { CONFIG } from './config.js';
import {
  formatBytes, fmtDur, percentile, encodeWav, stemStats, reconstructionSnrDb, lrCorrelation,
} from './lib.js';
import { storageInfo } from './modelstore.js';

const $ = (id) => document.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 0));
const SR = CONFIG.sampleRate;

const report = {
  app: 'removedmusic-lab',
  startedAt: new Date().toISOString(),
  model: { id: CONFIG.model.id, url: CONFIG.model.url },
  env: {}, hf: null, download: null, reuse: null, separate: null, quality: null,
  mem: [], errors: [], crashedPrevious: null, events: [],
};

// ---------- tiện ích ----------
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  $('log').textContent += line + '\n';
  report.events.push(line);
  if (report.events.length > 150) report.events.shift();
}
function renderReport() {
  const r = { ...report };
  $('report').value = JSON.stringify(r, null, 2);
}
function fail(stage, kind, message, extra) {
  report.errors.push({ stage, kind, message, ...extra, at: new Date().toISOString() });
  log(`LỖI [${stage}/${kind}] ${message}`);
  renderReport();
}

// Phát hiện lần chạy trước bị dừng đột ngột (thường là hết RAM / hệ thống đóng tab).
const RUN_KEY = 'mrr_lab_run';
function setRun(o) { try { localStorage.setItem(RUN_KEY, JSON.stringify({ ...o, ts: Date.now() })); } catch { /* */ } }
function clearRun() { try { localStorage.removeItem(RUN_KEY); } catch { /* */ } }
(function checkCrash() {
  try {
    const prev = JSON.parse(localStorage.getItem(RUN_KEY) || 'null');
    if (prev && prev.status === 'running') {
      report.crashedPrevious = prev;
      const n = $('crashNotice');
      n.hidden = false;
      n.textContent = `⚠️ Lần chạy trước bị dừng đột ngột ở bước "${prev.stage}" ` +
        `(${new Date(prev.ts).toLocaleTimeString()}). Nhiều khả năng hết bộ nhớ hoặc hệ thống đã đóng tab. ` +
        'Hãy thử "Chia khối 20 giây", "Chỉ xử lý 60 giây đầu", hoặc đóng bớt app khác.';
      clearRun();
    }
  } catch { /* */ }
})();

// ---------- service worker + cross-origin isolation ----------
async function setupSW() {
  if (!('serviceWorker' in navigator)) { log('Trình duyệt không hỗ trợ service worker.'); return; }
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    if (!self.crossOriginIsolated && !sessionStorage.getItem('mrr_coi_reload')) {
      sessionStorage.setItem('mrr_coi_reload', '1');
      if (navigator.serviceWorker.controller) location.reload();
      else navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    }
  } catch (e) {
    log('Đăng ký service worker lỗi: ' + e.message);
  }
}

// ---------- kiểm tra môi trường ----------
function setRows(rows) {
  const tb = $('envTable').querySelector('tbody');
  tb.textContent = '';
  for (const [k, v, st] of rows) {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = k;
    const b = document.createElement('td');
    const d = document.createElement('span'); d.className = 'dot ' + (st || '');
    b.append(d, document.createTextNode(String(v)));
    tr.append(a, b); tb.append(tr);
  }
}

async function checkEnv() {
  const rows = [];
  const env = {};
  const add = (k, v, st) => { rows.push([k, v, st]); env[k] = v; };
  add('Trình duyệt', navigator.userAgent.replace(/\s+/g, ' ').slice(0, 120), '');
  add('Số lõi CPU', `${navigator.hardwareConcurrency || '?'} lõi`, '');
  add('RAM (ước lượng)', navigator.deviceMemory ? `≥ ${navigator.deviceMemory} GB (làm tròn, tối đa 8)` : 'không biết', navigator.deviceMemory && navigator.deviceMemory < 4 ? 'warn' : '');
  add('Cross-origin isolated', self.crossOriginIsolated ? 'Có (WASM đa luồng được)' : 'Không (WASM chỉ 1 luồng → chậm)', self.crossOriginIsolated ? 'ok' : 'warn');
  add('PWA (đã cài)', matchMedia('(display-mode: standalone)').matches ? 'Đang chạy ở chế độ app' : 'Đang ở tab trình duyệt', '');
  add('Service worker', navigator.serviceWorker && navigator.serviceWorker.controller ? 'Đang hoạt động' : 'Chưa kiểm soát trang', navigator.serviceWorker && navigator.serviceWorker.controller ? 'ok' : 'warn');
  add('Mạng', `${navigator.onLine ? 'online' : 'offline'}${navigator.connection ? ' · ' + (navigator.connection.effectiveType || '') + (navigator.connection.saveData ? ' · tiết kiệm dữ liệu BẬT' : '') : ''}`, navigator.onLine ? 'ok' : 'bad');

  // WebGPU
  if (!navigator.gpu) {
    add('WebGPU', 'Không có → sẽ chạy bằng CPU (WASM)', 'warn');
  } else {
    try {
      const ad = await navigator.gpu.requestAdapter();
      if (!ad) add('WebGPU', 'API có nhưng không có adapter → CPU', 'warn');
      else {
        let info = ad.info;
        if (!info && ad.requestAdapterInfo) { try { info = await ad.requestAdapterInfo(); } catch { /* */ } }
        const desc = info ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ') : 'adapter OK';
        add('WebGPU', desc || 'adapter OK', 'ok');
        add('GPU maxBufferSize', formatBytes(ad.limits.maxBufferSize), ad.limits.maxBufferSize < 256 * 1048576 ? 'warn' : '');
        add('GPU maxStorageBinding', formatBytes(ad.limits.maxStorageBufferBindingSize), '');
        add('GPU shader-f16', ad.features.has('shader-f16') ? 'có' : 'không', '');
      }
    } catch (e) { add('WebGPU', 'Lỗi: ' + e.message, 'bad'); }
  }

  const s = await storageInfo();
  if (s.quota != null) {
    const free = s.quota - s.usage;
    add('Bộ nhớ lưu trữ trống', `${formatBytes(free)} (đã dùng ${formatBytes(s.usage)} / ${formatBytes(s.quota)})`, free < CONFIG.model.approxBytes * 1.3 ? 'bad' : 'ok');
  }
  add('Lưu trữ bền (persist)', s.persisted == null ? 'không biết' : s.persisted ? 'Có (hệ thống không tự xoá model)' : 'Chưa (sẽ xin sau khi tải)', s.persisted ? 'ok' : '');
  setRows(rows);
  report.env = env;
  renderReport();
}

// ---------- worker ----------
let worker = null;
let state = { busy: null, dlStart: 0, sepStart: 0, sepCtx: null };

function startWorker() {
  if (worker) worker.terminate();
  worker = new Worker('./worker.js' + location.search, { type: 'module' });
  worker.onmessage = onWorker;
  worker.onerror = (e) => {
    fail('worker', 'load', 'Worker lỗi: ' + (e.message || 'không nạp được worker.js'));
    endBusy();
  };
  worker.postMessage({ type: 'status' });
}

function endBusy() {
  state.busy = null;
  $('btnDownload').disabled = false;
  $('btnCancelDl').hidden = true;
  $('btnCancel').hidden = true;
  $('dlBar').hidden = true;
  $('sepBar').hidden = true;
  updateSeparateEnabled();
  clearRun();
}

let modelCached = false;
function updateSeparateEnabled() {
  $('btnSeparate').disabled = !(modelCached && $('fileInput').files[0] && !state.busy);
}

const STAGE_TEXT = {
  'load-libs': 'Đang nạp thư viện AI…',
  'read-model': 'Đang đọc model từ bộ nhớ thiết bị…',
  'hash-model': 'Đang xác minh model (SHA-256)…',
  'load-model(webgpu)': 'Đang nạp model lên GPU…',
  'load-model(wasm)': 'Đang nạp model vào CPU (có thể mất vài chục giây)…',
  'separate(webgpu)': 'Đang tách bằng GPU…',
  'separate(wasm)': 'Đang tách bằng CPU…',
};

function onWorker(ev) {
  const m = ev.data;
  switch (m.type) {
    case 'ready': break;
    case 'log': log(m.m); break;
    case 'status': onStatus(m.status); break;
    case 'dl-progress': {
      const { loaded, total, estimated } = m;
      $('dlBar').hidden = false;
      $('dlBar').value = Math.min(1, loaded / total);
      const el = (performance.now() - state.dlStart) / 1000;
      const speed = loaded / el;
      const eta = speed > 0 ? (total - loaded) / speed : NaN;
      $('dlText').textContent = `${formatBytes(loaded)} / ${estimated ? '~' : ''}${formatBytes(total)} · ${(speed * 8 / 1e6).toFixed(1)} Mbps · còn ~${fmtDur(eta * 1000)}`;
      break;
    }
    case 'dl-done': {
      const r = m.result;
      report.download = {
        bytes: r.bytes, ms: Math.round(performance.now() - state.dlStart), mbps: +r.mbps.toFixed(1),
        persisted: r.persisted, finishedAt: new Date().toISOString(),
      };
      $('dlText').textContent = `✅ Tải xong ${formatBytes(r.bytes)} trong ${fmtDur(report.download.ms)} (${report.download.mbps} Mbps). Đã lưu vào bộ nhớ thiết bị.`;
      log(`Tải model xong: ${formatBytes(r.bytes)}, ${fmtDur(report.download.ms)}; persist=${r.persisted}`);
      endBusy(); renderReport(); checkEnv();
      break;
    }
    case 'dl-error': {
      fail('download', m.kind, m.message);
      $('dlText').textContent = '❌ ' + m.message;
      endBusy();
      break;
    }
    case 'stage': {
      setRun({ status: 'running', stage: m.stage });
      $('sepText').textContent = STAGE_TEXT[m.stage] || m.stage;
      if (m.stage.startsWith('separate(')) state.sepStart = performance.now();
      if (m.heapMb != null) report.mem.push({ at: m.stage, workerJsHeapMb: m.heapMb });
      break;
    }
    case 'progress': {
      $('sepBar').hidden = false;
      $('sepBar').value = m.progress;
      const el = (performance.now() - state.sepStart) / 1000;
      const eta = m.progress > 0.02 ? el / m.progress - el : NaN;
      $('sepText').textContent = `Đang tách… ${(m.progress * 100).toFixed(0)}% · khối ${m.block}/${m.blocks} · còn ~${fmtDur(eta * 1000)}`;
      break;
    }
    case 'result': onResult(m); break;
    case 'error': {
      fail(m.stage, m.kind, m.message, { failures: m.failures });
      const friendly = m.kind === 'memory'
        ? '❌ Hết bộ nhớ khi xử lý. Thử "Chia khối 20 giây", chỉ xử lý 60 giây đầu, hoặc đóng bớt ứng dụng khác.'
        : '❌ ' + m.message;
      $('sepText').textContent = friendly;
      endBusy();
      break;
    }
    default: break;
  }
}

function onStatus(s) {
  modelCached = !!s.cached;
  const st = $('modelState');
  if (s.cached) {
    st.textContent = `✅ Model đã có trên thiết bị (${formatBytes(s.bytes)}, tải ${new Date(s.ts).toLocaleString()}). Sẽ dùng lại, không tải nữa.`;
    $('btnDownload').textContent = '⬇️ Tải lại model';
    report.reuse = { cached: true, bytes: s.bytes, savedAt: new Date(s.ts).toISOString(), checkedAt: new Date().toISOString(), displayMode: matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser' };
  } else {
    st.textContent = `⬇️ Chưa có model. Lần đầu cần tải khoảng ${formatBytes(CONFIG.model.approxBytes)} (nên dùng Wi-Fi). Sau đó chỉ tải một lần.`;
    $('btnDownload').textContent = `⬇️ Tải model (~${formatBytes(CONFIG.model.approxBytes)})`;
    report.reuse = { cached: false, checkedAt: new Date().toISOString() };
  }
  updateSeparateEnabled();
  renderReport();
}

// ---------- model panel ----------
$('modelInfo').textContent = `${CONFIG.model.name} · nguồn: Hugging Face · ${CONFIG.model.license}`;

$('btnDownload').onclick = () => {
  const mb = Math.round(CONFIG.model.approxBytes / 1e6);
  if (!confirm(`Sẽ tải model khoảng ${mb} MB từ Hugging Face và lưu trên thiết bị. Chỉ tải một lần. Tiếp tục?`)) return;
  state.busy = 'download';
  state.dlStart = performance.now();
  $('btnDownload').disabled = true;
  $('btnCancelDl').hidden = false;
  $('dlBar').hidden = false; $('dlBar').value = 0;
  $('dlText').textContent = 'Đang kết nối…';
  worker.postMessage({ type: 'download' });
};
$('btnCancelDl').onclick = () => {
  log('Người dùng huỷ tải.');
  startWorker(); endBusy();
  $('dlText').textContent = 'Đã huỷ. Chưa có gì được lưu.';
};
$('btnDelete').onclick = () => {
  if (confirm('Xoá model đã lưu? Lần sau sẽ phải tải lại.')) worker.postMessage({ type: 'delete' });
};
$('btnCheckHF').onclick = async () => {
  const t0 = performance.now();
  $('dlText').textContent = 'Đang kiểm tra Hugging Face…';
  try {
    const ctl = new AbortController();
    const r = await fetch(CONFIG.model.url, { headers: { Range: 'bytes=0-1023' }, signal: ctl.signal, mode: 'cors', credentials: 'omit' });
    const cr = r.headers.get('content-range');
    const total = cr ? Number(cr.split('/')[1]) : Number(r.headers.get('content-length')) || null;
    ctl.abort();
    report.hf = { ok: r.ok, status: r.status, ms: Math.round(performance.now() - t0), totalBytes: total, rangeSupported: r.status === 206, corsOk: true, url: r.url };
    $('dlText').textContent = r.ok
      ? `✅ Hugging Face truy cập được (HTTP ${r.status}, ${report.hf.ms} ms)${total ? ', dung lượng thật: ' + formatBytes(total) : ''}${r.status === 206 ? ', hỗ trợ tải tiếp (Range)' : ''}.`
      : `❌ HTTP ${r.status}`;
  } catch (e) {
    report.hf = { ok: false, error: e.message, online: navigator.onLine };
    $('dlText').textContent = navigator.onLine
      ? '❌ Không truy cập được Hugging Face (có thể bị chặn CORS hoặc mạng): ' + e.message
      : '❌ Thiết bị đang offline.';
  }
  log('HF check: ' + JSON.stringify(report.hf));
  renderReport();
};

// ---------- chọn file ----------
$('fileInput').onchange = () => {
  const f = $('fileInput').files[0];
  $('fileName').textContent = f ? `${f.name} · ${formatBytes(f.size)}` : 'Chưa chọn file';
  updateSeparateEnabled();
};

// ---------- tách ----------
let audio = null; // { orig:{l,r}, n, name, ... }

async function decodeInput(file, maxSec) {
  const t0 = performance.now();
  const ac = new (self.AudioContext || self.webkitAudioContext)();
  let dec;
  try {
    dec = await ac.decodeAudioData(await file.arrayBuffer());
  } finally { ac.close().catch(() => {}); }
  const srcSr = dec.sampleRate;
  const keep = maxSec > 0 ? Math.min(dec.length, Math.round(maxSec * srcSr)) : dec.length;
  const chL = dec.getChannelData(0).subarray(0, keep);
  const chR = (dec.numberOfChannels > 1 ? dec.getChannelData(1) : dec.getChannelData(0)).subarray(0, keep);
  let l, r;
  if (srcSr === SR) {
    l = chL.slice(); r = chR.slice();
  } else {
    const len = Math.ceil((keep * SR) / srcSr);
    const off = new OfflineAudioContext(2, len, SR);
    const b = off.createBuffer(2, keep, srcSr);
    b.copyToChannel(chL, 0); b.copyToChannel(chR, 1);
    const src = off.createBufferSource(); src.buffer = b; src.connect(off.destination); src.start();
    const out = await off.startRendering();
    l = out.getChannelData(0).slice(); r = out.getChannelData(1).slice();
  }
  return {
    l, r, n: l.length, decodeMs: Math.round(performance.now() - t0),
    srcSr, channels: dec.numberOfChannels, fullSec: dec.duration,
  };
}

$('btnSeparate').onclick = async () => {
  const file = $('fileInput').files[0];
  if (!file || state.busy) return;
  state.busy = 'separate';
  stopPlayback(true);
  $('results').hidden = true;
  $('btnSeparate').disabled = true;
  $('btnCancel').hidden = false;
  $('sepBar').hidden = false; $('sepBar').value = 0;
  $('sepText').textContent = 'Đang giải mã file âm thanh…';
  setRun({ status: 'running', stage: 'decode' });
  const opts = {
    backend: $('selBackend').value, threads: $('selThreads').value,
    blockSec: Number($('selBlock').value), maxSec: Number($('selLen').value),
  };
  try {
    audio = await decodeInput(file, opts.maxSec);
  } catch (e) {
    fail('decode', 'decode', 'Không đọc được file âm thanh: ' + e.message);
    $('sepText').textContent = '❌ Không giải mã được file này. Hãy dùng mp3/m4a/wav hợp lệ.';
    endBusy(); return;
  }
  audio.name = file.name; audio.size = file.size; audio.opts = opts;
  log(`Giải mã ${fmtDur(audio.decodeMs)}: ${(audio.n / SR).toFixed(1)} s @${SR}Hz (gốc ${audio.srcSr}Hz, ${audio.channels}ch)`);
  report.mem.push({ at: 'after-decode', ...(await memSample()) });

  const l = audio.l.slice(), r = audio.r.slice(); // bản gửi cho worker (giữ bản gốc để nghe A/B)
  state.sepCtx = { opts, t0: performance.now() };
  worker.postMessage({ type: 'separate', left: l, right: r, ...opts }, [l.buffer, r.buffer]);
};

$('btnCancel').onclick = () => {
  log('Người dùng huỷ xử lý.');
  startWorker(); endBusy();
  $('sepText').textContent = 'Đã huỷ.';
};

async function memSample() {
  const o = { deviceMemoryGB: navigator.deviceMemory || null };
  try { o.mainJsHeapMb = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch { /* */ }
  if (self.crossOriginIsolated && performance.measureUserAgentSpecificMemory) {
    try {
      const r = await Promise.race([performance.measureUserAgentSpecificMemory(), new Promise((_, j) => setTimeout(() => j(new Error('timeout')), 4000))]);
      o.uaMemoryMb = Math.round(r.bytes / 1048576);
    } catch { /* không hỗ trợ trên máy này */ }
  }
  return o;
}

let buffers = null; // AudioBuffer: orig, voc, inst
let stemRms = null;

async function onResult(m) {
  $('sepText').textContent = 'Đang đo chất lượng…';
  await tick();
  const { timing: t, vL, vR, iL, iR } = m;
  const o = audio;
  const processedSec = o.n / SR;

  // Số đo chất lượng
  const sOrig = stemStats(o.l, o.r);
  const sVoc = stemStats(vL, vR);
  const sInst = stemStats(iL, iR);
  const snr = reconstructionSnrDb(o.l, o.r, vL, vR, iL, iR);
  const corrVoc = lrCorrelation(vL, vR);
  const corrInst = lrCorrelation(iL, iR);
  const issues = [];
  if (sVoc.nonFinite || sInst.nonFinite) issues.push('Có giá trị NaN/Inf trong đầu ra');
  if (sVoc.rmsDb < -60) issues.push('Vocal gần như im lặng');
  if (sInst.rmsDb < -60) issues.push('Nhạc nền gần như im lặng');
  if (snr < 8) issues.push(`Vocal + nhạc nền không khớp bản gốc (SNR ${snr.toFixed(1)} dB)`);
  if (sVoc.clipped > 0 || sInst.clipped > 0) issues.push(`Có clipping (vocal ${sVoc.clipped}, nhạc nền ${sInst.clipped} mẫu)`);
  const dB = (x) => (Number.isFinite(x) ? x.toFixed(1) : String(x));
  report.quality = {
    origRmsDb: +dB(sOrig.rmsDb), vocalRmsDb: +dB(sVoc.rmsDb), instRmsDb: +dB(sInst.rmsDb),
    vocalPeakDb: +dB(sVoc.peakDb), instPeakDb: +dB(sInst.peakDb),
    reconstructionSnrDb: +dB(snr), vocalLRCorrelation: +corrVoc.toFixed(3), instLRCorrelation: +corrInst.toFixed(3),
    autoIssues: issues, listeningNotes: '(điền bằng tai: lẫn nhạc? méo? lỗi chỗ nối khối?)',
  };
  stemRms = { orig: sOrig.rms, voc: sVoc.rms, inst: sInst.rms };

  const seg = t.segMs || [];
  report.separate = {
    file: { name: o.name, sizeBytes: o.size, fullDurationSec: +o.fullSec.toFixed(1), sourceSampleRate: o.srcSr, channels: o.channels },
    options: o.opts, processedSec: +processedSec.toFixed(1), decodeMs: o.decodeMs,
    backendUsed: t.ep, wasmThreads: t.lib && t.lib.wasmThreads, crossOriginIsolated: t.lib && t.lib.crossOriginIsolated,
    readModelMs: t.readMs, loadModelMs: t.loadMs, separateMs: t.sepMs, totalMs: t.totalMs,
    realtimeFactor: +(processedSec / (t.sepMs / 1000)).toFixed(2),
    blocks: t.blocks,
    segmentMs: seg.length ? { n: seg.length, min: Math.round(Math.min(...seg)), median: Math.round(percentile(seg, 50)), p90: Math.round(percentile(seg, 90)), max: Math.round(Math.max(...seg)) } : null,
    workerHeapMb: { afterModelLoad: t.heapAfterLoad, peak: t.peakHeap },
    fallbackFailures: t.failures, modelSha256: t.modelHash, libs: t.lib,
  };
  report.mem.push({ at: 'after-separate', ...(await memSample()) });

  // Tạo AudioBuffer để nghe A/B
  const mk = (a, b) => {
    const buf = new AudioBuffer({ length: a.length, numberOfChannels: 2, sampleRate: SR });
    buf.copyToChannel(a, 0); buf.copyToChannel(b, 1); return buf;
  };
  buffers = { orig: mk(o.l, o.r), voc: mk(vL, vR), inst: mk(iL, iR) };
  buffers.raw = { vL, vR, iL, iR };

  // Bảng số đo
  const tb = $('metrics').querySelector('tbody'); tb.textContent = '';
  const rows = [
    ['Backend thực tế', `${t.ep === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WASM, ' + (t.lib.wasmThreads || 1) + ' luồng)'}${t.failures.length ? ' · đã fallback sau lỗi' : ''}`],
    ['Thời gian nạp model', fmtDur(t.loadMs)],
    ['Thời gian tách', `${fmtDur(t.sepMs)} cho ${processedSec.toFixed(0)} s nhạc`],
    ['Tốc độ', `${report.separate.realtimeFactor}× thời gian thực ${report.separate.realtimeFactor < 1 ? '(chậm hơn nghe nhạc)' : ''}`],
    ['Tổng thời gian', fmtDur(t.totalMs)],
    ['RAM JS worker (đỉnh)', t.peakHeap != null ? t.peakHeap + ' MB (chưa tính bộ nhớ WASM/GPU)' : 'không đo được'],
    ['Âm lượng gốc/vocal/nền', `${dB(sOrig.rmsDb)} / ${dB(sVoc.rmsDb)} / ${dB(sInst.rmsDb)} dBFS`],
    ['Vocal + nền ≈ gốc', `SNR ${dB(snr)} dB`],
    ['Lỗi tự phát hiện', issues.length ? issues.join('; ') : 'không có'],
  ];
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = k;
    const b = document.createElement('td'); b.textContent = v;
    tr.append(a, b); tb.append(tr);
  }
  $('results').hidden = false;
  $('sepText').textContent = `✅ Xong trong ${fmtDur(t.totalMs)} (${report.separate.realtimeFactor}× thời gian thực).`;
  log(`Kết quả: ${JSON.stringify(report.separate)}`);
  endBusy();
  renderReport();
}

// ---------- nghe A/B ----------
let pb = { ac: null, nodes: [], playing: false, offset: 0, startedAt: 0, mode: 'voc', timer: null };

function levelGain(k) {
  if (!$('chkLevel').checked || !stemRms) return 1;
  const g = stemRms.orig / (stemRms[k] || 1e-9);
  return Math.min(4, Math.max(0.25, g));
}
function applyMode(smooth) {
  for (const n of pb.nodes) {
    const target = n.k === pb.mode ? levelGain(n.k) : 0;
    if (smooth) n.g.gain.setTargetAtTime(target, pb.ac.currentTime, 0.015);
    else n.g.gain.value = target;
  }
}
function duration() { return buffers ? buffers.orig.duration : 0; }

function startPlayback() {
  if (!buffers) return;
  if (!pb.ac) pb.ac = new (self.AudioContext || self.webkitAudioContext)({ sampleRate: SR });
  pb.ac.resume();
  if (pb.offset >= duration() - 0.05) pb.offset = 0;
  pb.nodes = ['orig', 'voc', 'inst'].map((k) => {
    const s = pb.ac.createBufferSource(); s.buffer = buffers[k];
    const g = pb.ac.createGain();
    s.connect(g).connect(pb.ac.destination);
    s.start(0, pb.offset);
    return { k, s, g };
  });
  applyMode(false);
  pb.startedAt = pb.ac.currentTime - pb.offset;
  pb.playing = true;
  pb.nodes[0].s.onended = () => { if (pb.playing && pb.ac.currentTime - pb.startedAt >= duration() - 0.1) stopPlayback(true); };
  $('btnPlay').textContent = '⏸ Tạm dừng';
  clearInterval(pb.timer);
  pb.timer = setInterval(() => { $('seek').value = Math.round(((pb.ac.currentTime - pb.startedAt) / duration()) * 1000); }, 250);
}
function stopPlayback(reset) {
  if (pb.playing && pb.ac) pb.offset = pb.ac.currentTime - pb.startedAt;
  for (const n of pb.nodes) { try { n.s.onended = null; n.s.stop(); } catch { /* */ } n.s.disconnect(); n.g.disconnect(); }
  pb.nodes = []; pb.playing = false;
  clearInterval(pb.timer);
  if (reset) { pb.offset = 0; $('seek').value = 0; }
  $('btnPlay').textContent = '▶️ Phát';
}
$('btnPlay').onclick = () => (pb.playing ? stopPlayback(false) : startPlayback());
$('seek').oninput = () => {
  const was = pb.playing;
  if (was) stopPlayback(false);
  pb.offset = ($('seek').value / 1000) * duration();
  if (was) startPlayback();
};
document.querySelectorAll('.seg button').forEach((b) => {
  b.onclick = () => {
    pb.mode = b.dataset.mode;
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    if (pb.playing) applyMode(true);
  };
});
$('chkLevel').onchange = () => { if (pb.playing) applyMode(true); };

function downloadWav(l, r, name) {
  const blob = new Blob([encodeWav(l, r, SR)], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000); // không thu hồi ngay: một số trình duyệt Android cần thời gian
}
$('btnDlVoc').onclick = () => buffers && downloadWav(buffers.raw.vL, buffers.raw.vR, 'lab_vocal.wav');
$('btnDlInst').onclick = () => buffers && downloadWav(buffers.raw.iL, buffers.raw.iR, 'lab_instrumental.wav');

// ---------- báo cáo ----------
$('btnCopy').onclick = async () => {
  renderReport();
  try { await navigator.clipboard.writeText($('report').value); $('btnCopy').textContent = '✅ Đã sao chép'; }
  catch { $('report').select(); document.execCommand('copy'); $('btnCopy').textContent = '✅ Đã sao chép'; }
  setTimeout(() => { $('btnCopy').textContent = '📋 Sao chép'; }, 2000);
};
$('btnShare').onclick = async () => {
  renderReport();
  if (navigator.share) { try { await navigator.share({ title: 'Removed Music Lab report', text: $('report').value }); } catch { /* huỷ */ } }
  else $('btnCopy').click();
};
$('btnEnv').onclick = checkEnv;
addEventListener('beforeunload', () => { /* không xoá cờ chạy: để phát hiện crash */ });

// ---------- khởi động ----------
setupSW();
startWorker();
checkEnv();
renderReport();
