// Lưu trữ model TÁCH RIÊNG khỏi code ứng dụng.
// Dùng Cache Storage với tên riêng (config.modelCacheName). Service worker chỉ xoá cache
// có tiền tố "lab-app-", nên cập nhật HTML/CSS/JS không bao giờ xoá model người dùng đã tải.
// Chạy được trong cả Worker và trang chính.

export class ModelError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind; // network | http | quota | cancelled | truncated | corrupt | unknown
    this.cause = cause;
  }
}

export function classifyError(err) {
  if (err instanceof ModelError) return err;
  const name = err && err.name;
  if (name === 'AbortError') return new ModelError('cancelled', 'Đã huỷ tải model.', err);
  if (name === 'QuotaExceededError') {
    return new ModelError('quota', 'Không đủ dung lượng lưu trữ trên thiết bị để lưu model.', err);
  }
  if (name === 'TypeError' || /network|failed to fetch|load failed/i.test(String(err && err.message))) {
    return new ModelError('network', 'Mất kết nối khi tải model. Model chưa được lưu; hãy kết nối mạng và tải lại.', err);
  }
  return new ModelError('unknown', String((err && err.message) || err), err);
}

const metaKey = (model) => new Request(`${self.location.origin}/__mrr_meta/${model.id}`);

async function openCache(cfgName) { return caches.open(cfgName); }

export async function getStatus(model, cacheName) {
  const cache = await openCache(cacheName);
  const meta = await cache.match(metaKey(model));
  const has = await cache.match(model.url);
  if (!meta || !has) return { cached: false };
  try {
    const m = await meta.json();
    return { cached: true, ...m };
  } catch {
    return { cached: false };
  }
}

export async function deleteModel(model, cacheName) {
  const cache = await openCache(cacheName);
  const a = await cache.delete(model.url);
  const b = await cache.delete(metaKey(model));
  return a || b;
}

export async function storageInfo() {
  const out = {};
  try {
    const e = await navigator.storage.estimate();
    out.quota = e.quota; out.usage = e.usage;
  } catch { /* không hỗ trợ */ }
  try { out.persisted = await navigator.storage.persisted(); } catch { /* */ }
  return out;
}

// Tải model, ghi thẳng từ luồng vào cache (không giữ 172MB trong RAM).
export async function downloadModel(model, cacheName, { onProgress, signal } = {}) {
  const t0 = performance.now();
  const cache = await openCache(cacheName);

  // Kiểm tra dung lượng trống trước khi tải (nếu trình duyệt cho biết).
  const info = await storageInfo();
  if (info.quota && info.usage != null) {
    const free = info.quota - info.usage;
    if (free < model.approxBytes * 1.1) {
      throw new ModelError('quota',
        `Dung lượng trống khoảng ${Math.round(free / 1e6)} MB, không đủ cho model (~${Math.round(model.approxBytes / 1e6)} MB).`);
    }
  }

  let resp;
  try {
    resp = await fetch(model.url, { signal, mode: 'cors', credentials: 'omit' });
  } catch (e) {
    throw classifyError(e);
  }
  if (!resp.ok) throw new ModelError('http', `Máy chủ model trả về HTTP ${resp.status}.`);

  const headerLen = Number(resp.headers.get('content-length')) || 0;
  const encoded = !!resp.headers.get('content-encoding');
  const total = headerLen || model.approxBytes;
  let loaded = 0;
  const counter = new TransformStream({
    transform(chunk, ctl) {
      loaded += chunk.byteLength;
      if (onProgress) onProgress(loaded, total, !headerLen);
      ctl.enqueue(chunk);
    },
  });

  try {
    await cache.put(model.url, new Response(resp.body.pipeThrough(counter), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }));
  } catch (e) {
    await cache.delete(model.url).catch(() => {});
    throw classifyError(e);
  }

  if (loaded === 0 || (headerLen && !encoded && loaded !== headerLen)) {
    await cache.delete(model.url).catch(() => {});
    throw new ModelError('truncated', `File tải về không đầy đủ (${loaded}/${headerLen || '?'} byte).`);
  }

  const meta = { bytes: loaded, ts: Date.now(), url: model.url, downloadMs: performance.now() - t0 };
  await cache.put(metaKey(model), new Response(JSON.stringify(meta), {
    headers: { 'content-type': 'application/json' },
  }));

  let persisted = null;
  try { persisted = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : null; } catch { /* */ }

  return { ...meta, mbps: (loaded * 8) / 1e6 / ((performance.now() - t0) / 1000), persisted };
}

// Đọc model từ cache, kiểm tra kích thước khớp metadata (phát hiện file hỏng).
export async function readModelBuffer(model, cacheName) {
  const cache = await openCache(cacheName);
  const meta = await cache.match(metaKey(model));
  const resp = await cache.match(model.url);
  if (!meta || !resp) throw new ModelError('corrupt', 'Model chưa có trong bộ nhớ thiết bị.');
  const m = await meta.json();
  const buf = await resp.arrayBuffer();
  if (buf.byteLength !== m.bytes) {
    await deleteModel(model, cacheName);
    throw new ModelError('corrupt', 'Model đã lưu bị hỏng (sai kích thước). Đã xoá, hãy tải lại.');
  }
  return buf;
}

export async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
