// Hàm thuần (không phụ thuộc DOM) để dễ test bằng Node.

export function formatBytes(n) {
  if (!isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

export function fmtDur(ms) {
  if (!isFinite(ms)) return '?';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + ' s';
  const m = Math.floor(s / 60);
  return `${m} phút ${Math.round(s - m * 60)} s`;
}

export function percentile(arr, p) {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[i];
}

// WAV 16-bit stereo
export function encodeWav(left, right, sampleRate) {
  const n = left.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (const ch of [left, right]) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return buf;
}

// Thống kê 1 stem stereo
export function stemStats(l, r) {
  let sum = 0, peak = 0, clipped = 0, nonFinite = 0;
  const n = l.length;
  for (let i = 0; i < n; i++) {
    const a = l[i], b = r[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) { nonFinite++; continue; }
    sum += a * a + b * b;
    const m = Math.max(Math.abs(a), Math.abs(b));
    if (m > peak) peak = m;
    if (m >= 0.999) clipped++;
  }
  const rms = Math.sqrt(sum / (2 * n || 1));
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return { rmsDb: db(rms), peakDb: db(peak), clipped, nonFinite, rms };
}

// SNR của (vocal + nhạc nền) so với bản gốc: kiểm tra 2 stem có cộng lại ≈ bản gốc không.
export function reconstructionSnrDb(oL, oR, vL, vR, iL, iR) {
  let sig = 0, err = 0;
  const n = oL.length;
  for (let i = 0; i < n; i++) {
    const eL = oL[i] - (vL[i] + iL[i]);
    const eR = oR[i] - (vR[i] + iR[i]);
    sig += oL[i] * oL[i] + oR[i] * oR[i];
    err += eL * eL + eR * eR;
  }
  if (err === 0) return Infinity;
  return 10 * Math.log10(sig / err);
}

// Tương quan L/R (vocal thường nằm giữa => gần 1; nhạc nền rộng => thấp hơn)
export function lrCorrelation(l, r) {
  let sl = 0, sr = 0, sll = 0, srr = 0, slr = 0;
  const n = l.length;
  for (let i = 0; i < n; i++) {
    const a = l[i], b = r[i];
    sl += a; sr += b; sll += a * a; srr += b * b; slr += a * b;
  }
  const cov = slr / n - (sl / n) * (sr / n);
  const vl = sll / n - (sl / n) ** 2;
  const vr = srr / n - (sr / n) ** 2;
  const d = Math.sqrt(vl * vr);
  return d > 0 ? cov / d : 0;
}

// ---- Chia khối có chồng lấp + crossfade tuyến tính (giới hạn RAM) ----
// Trả về danh sách khối [{a, b, rampIn, rampOut}] phủ kín [0, N).
export function planBlocks(N, blockLen, overlap) {
  if (N <= blockLen) return [{ a: 0, b: N, rampIn: 0, rampOut: 0 }];
  const step = blockLen - overlap;
  const count = Math.ceil((N - overlap) / step);
  const blocks = [];
  for (let k = 0; k < count; k++) {
    const a = k * step;
    const b = Math.min(N, a + blockLen);
    blocks.push({ a, b, rampIn: k > 0 ? overlap : 0, rampOut: k < count - 1 ? overlap : 0 });
  }
  return blocks;
}

// Trọng số của khối tại vị trí tuyệt đối i (a <= i < b)
export function blockWeight(blk, i) {
  let w = 1;
  if (blk.rampIn > 0 && i < blk.a + blk.rampIn) w *= (i - blk.a + 0.5) / blk.rampIn;
  if (blk.rampOut > 0 && i >= blk.b - blk.rampOut) w *= (blk.b - i - 0.5) / blk.rampOut;
  return w;
}
