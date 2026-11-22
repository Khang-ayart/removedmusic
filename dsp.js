/* Removed Music – bộ xử lý âm thanh KHÔNG dùng AI (chạy được trên điện thoại).
 *
 * 1) separateAdvanced: tách vocal theo phổ tần
 *    - STFT stereo; chỉ giữ thành phần "ở giữa" (L ≈ R về biên độ lẫn pha),
 *    - lọc HPSS (trung vị) để bỏ trống/bass dạng xung ở giữa,
 *    - trọng số tần số để giảm bass/kick,
 *    - chia đoạn 15 s (+ngữ cảnh) để tiết kiệm RAM và báo tiến trình.
 * 2) cleanupVocal: làm sạch vocal – EQ, noise gate, compressor, cân bằng âm lượng.
 *
 * Viết thuần JS: dùng được trong Web Worker (importScripts) và Node (require) để test.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- FFT (radix-2)
  function makeFFT(N) {
    if (N & (N - 1)) throw new Error('FFT: N phải là luỹ thừa của 2');
    const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2), rev = new Uint32Array(N);
    for (let j = 0; j < N / 2; j++) { cos[j] = Math.cos((2 * Math.PI * j) / N); sin[j] = Math.sin((2 * Math.PI * j) / N); }
    let bits = 0; while ((1 << bits) < N) bits++;
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
    return {
      N,
      // tại chỗ, không chuẩn hoá (cả thuận lẫn nghịch)
      transform(re, im, inverse) {
        for (let i = 0; i < N; i++) {
          const j = rev[i];
          if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
        }
        const sg = inverse ? 1 : -1;
        for (let size = 2; size <= N; size <<= 1) {
          const half = size >> 1, step = N / size;
          for (let s = 0; s < N; s += size) {
            for (let k = 0, tw = 0; k < half; k++, tw += step) {
              const wr = cos[tw], wi = sg * sin[tw];
              const a = s + k, b = a + half;
              const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
              re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
            }
          }
        }
      },
    };
  }

  // ---------------------------------------------------------------- trung vị trượt
  // Trung vị cửa sổ w (lẻ) dọc một "đường" của mảng src (bước stride), ghi vào dst. Biên: phản xạ.
  function slidingMedian(src, off, stride, n, w, dst, dOff, dStride, tmp, win) {
    const h = w >> 1;
    const L = n + 2 * h;
    for (let i = 0; i < n; i++) tmp[h + i] = src[off + i * stride];
    for (let i = 1; i <= h; i++) {
      tmp[h - i] = src[off + Math.min(n - 1, i) * stride];
      tmp[h + n - 1 + i] = src[off + Math.max(0, n - 1 - i) * stride];
    }
    for (let i = 0; i < w; i++) win[i] = tmp[i];
    win.subarray(0, w).sort();
    for (let i = 0; i < n; i++) {
      dst[dOff + i * dStride] = win[h];
      if (i + w >= L) break;
      const out = tmp[i], inn = tmp[i + w];
      if (out === inn) continue;
      let lo = 0, hi = w;
      while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < out) lo = m + 1; else hi = m; }
      let j = lo;
      if (inn > out) { while (j + 1 < w && win[j + 1] < inn) { win[j] = win[j + 1]; j++; } }
      else { while (j > 0 && win[j - 1] > inn) { win[j] = win[j - 1]; j--; } }
      win[j] = inn;
    }
  }

  // ---------------------------------------------------------------- tham số
  // strength: độ "sạch" của vocal. Mạnh hơn = ít nhạc lẫn hơn nhưng vocal có thể mỏng hơn.
  const STRENGTH = {
    nhe:      { simLo: 0.15, gamma: 1.0, beta: 1.5, fLo: 70,  fFull: 150, name: 'Nhẹ (giữ nhiều vocal)' },
    canbang:  { simLo: 0.35, gamma: 1.3, beta: 2.0, fLo: 90,  fFull: 200, name: 'Cân bằng' },
    manh:     { simLo: 0.55, gamma: 1.8, beta: 3.0, fLo: 110, fFull: 260, name: 'Mạnh (sạch nhạc hơn)' },
  };

  const N_FFT = 2048;

  // Xử lý 1 đoạn (đã gồm ngữ cảnh). Trả về Float32Array vocal mono cùng độ dài.
  function processSegment(left, right, sr, P, ctx) {
    const len = left.length, N = N_FFT, hop = ctx.hop, K = N / 2 + 1;
    const T = 1 + Math.floor(len / hop);
    const { fft, win, zr, zi } = ctx;
    const Mre = new Float32Array(K * T), Mim = new Float32Array(K * T), mag = new Float32Array(K * T), sim = new Float32Array(K * T);
    const pad = N / 2;

    // --- phân tích: L và R đóng gói thành 1 FFT phức
    for (let t = 0; t < T; t++) {
      const start = t * hop - pad;
      for (let j = 0; j < N; j++) {
        let p = start + j;
        if (p < 0) p = -p; else if (p >= len) p = 2 * (len - 1) - p;
        if (p < 0) p = 0;
        zr[j] = left[p] * win[j]; zi[j] = right[p] * win[j];
      }
      fft.transform(zr, zi, false);
      const base = t * K;
      for (let k = 0; k < K; k++) {
        const m = k === 0 ? 0 : N - k;
        const lre = 0.5 * (zr[k] + zr[m]), lim = 0.5 * (zi[k] - zi[m]);
        const rre = 0.5 * (zi[k] + zi[m]), rim = 0.5 * (zr[m] - zr[k]);
        const mr = 0.5 * (lre + rre), mi = 0.5 * (lim + rim);
        Mre[base + k] = mr; Mim[base + k] = mi;
        mag[base + k] = Math.sqrt(mr * mr + mi * mi);
        const num = 2 * (lre * rre + lim * rim);
        const den = lre * lre + lim * lim + rre * rre + rim * rim + 1e-12;
        sim[base + k] = num / den; // 1 = giống hệt (ở giữa), 0 = không tương quan, -1 = ngược pha
      }
    }

    // --- HPSS: H = trung vị theo thời gian, P = trung vị theo tần số
    const kt = ctx.kt, kf = 17;
    const H = new Float32Array(K * T), Pm = new Float32Array(K * T);
    const tmpT = new Float32Array(T + kt + 2), winT = new Float32Array(kt);
    for (let k = 0; k < K; k++) slidingMedian(mag, k, K, T, kt, H, k, K, tmpT, winT);
    const tmpF = new Float32Array(K + kf + 2), winF = new Float32Array(kf);
    for (let t = 0; t < T; t++) slidingMedian(mag, t * K, 1, K, kf, Pm, t * K, 1, tmpF, winF);

    // --- mặt nạ
    const mask = new Float32Array(K * T);
    const fw = new Float32Array(K);
    for (let k = 0; k < K; k++) {
      const f = (k * sr) / N;
      let x = (f - P.fLo) / (P.fFull - P.fLo); x = x < 0 ? 0 : x > 1 ? 1 : x;
      fw[k] = x * x * (3 - 2 * x);
    }
    const beta = P.beta, fastBeta = beta === 2;
    const s0 = P.simLo, invS = 1 / (1 - s0);
    for (let i = 0; i < K * T; i++) {
      const h = H[i], p = Pm[i];
      let mh;
      if (P.noHpss) mh = 1;
      else if (fastBeta) { const a = h * h, b = p * p; mh = a / (a + b + 1e-12); }
      else { const a = Math.pow(h, beta), b = Math.pow(p, beta); mh = a / (a + b + 1e-12); }
      let mc = (sim[i] - s0) * invS; mc = mc < 0 ? 0 : mc > 1 ? 1 : mc;
      if (P.gamma !== 1) mc = Math.pow(mc, P.gamma);
      mask[i] = mh * mc * fw[i % K];
    }
    // làm mượt mặt nạ theo thời gian (giảm "nhiễu nhạc")
    const sm = new Float32Array(K * T);
    for (let t = 0; t < T; t++) {
      const a = Math.max(0, t - 1) * K, b = t * K, c = Math.min(T - 1, t + 1) * K;
      for (let k = 0; k < K; k++) sm[b + k] = 0.25 * mask[a + k] + 0.5 * mask[b + k] + 0.25 * mask[c + k];
    }

    // --- tổng hợp: 2 frame / 1 IFFT phức; cộng chồng với cửa sổ Hann, chuẩn hoá Σw²
    const out = new Float64Array(len + 2 * N);
    const half = N / 2;
    const frameSpec = (t, re, im) => { // phổ vocal của frame t (K bin)
      const base = t * K;
      for (let k = 0; k < K; k++) { const m = sm[base + k]; re[k] = Mre[base + k] * m; im[k] = Mim[base + k] * m; }
      im[0] = 0; im[half] = 0;
    };
    const ar = new Float64Array(K), ai = new Float64Array(K), br = new Float64Array(K), bi = new Float64Array(K);
    for (let t = 0; t < T; t += 2) {
      const hasB = t + 1 < T;
      frameSpec(t, ar, ai);
      if (hasB) frameSpec(t + 1, br, bi); else { br.fill(0); bi.fill(0); }
      for (let k = 0; k <= half; k++) {
        zr[k] = ar[k] - bi[k]; zi[k] = ai[k] + br[k];
        if (k > 0 && k < half) { const m = N - k; zr[m] = ar[k] + bi[k]; zi[m] = -ai[k] + br[k]; }
      }
      fft.transform(zr, zi, true);
      for (let w = 0; w < (hasB ? 2 : 1); w++) {
        const arr = w === 0 ? zr : zi;
        const start = (t + w) * hop - pad + N; // +N: lề an toàn ở đầu mảng out
        for (let j = 0; j < N; j++) out[start + j] += (arr[j] / N) * win[j];
      }
    }
    const env = ctx.env(len, T);
    const res = new Float32Array(len);
    for (let i = 0; i < len; i++) { const e = env[i]; res[i] = e > 1e-9 ? out[i + N] / e : 0; }
    return res;
  }

  function makeContext(hop, kt) {
    const N = N_FFT;
    const win = new Float64Array(N);
    for (let n = 0; n < N; n++) win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);
    const envCache = new Map();
    return {
      hop, kt, fft: makeFFT(N), win, zr: new Float64Array(N), zi: new Float64Array(N),
      env(len, T) {
        const key = len + ':' + T;
        if (envCache.has(key)) return envCache.get(key);
        const e = new Float64Array(len), pad = N / 2;
        for (let t = 0; t < T; t++) {
          const start = t * hop - pad;
          for (let j = 0; j < N; j++) { const p = start + j; if (p >= 0 && p < len) e[p] += win[j] * win[j]; }
        }
        envCache.set(key, e); return e;
      },
    };
  }

  /**
   * Tách vocal nâng cao.
   * @param {Float32Array} left, right  tín hiệu stereo (mono: truyền cùng mảng)
   * @param {number} sr
   * @param {{strength?:string, detail?:'fast'|'fine', onProgress?:(p:number)=>void, shouldCancel?:()=>boolean}} opt
   * @returns {{vocal: Float32Array, musicL: Float32Array, musicR: Float32Array, info: object}}
   */
  function separateAdvanced(left, right, sr, opt) {
    opt = opt || {};
    const P = STRENGTH[opt.strength] || STRENGTH.canbang;
    const hop = opt.detail === 'fine' ? 512 : 1024;
    // kernel trung vị theo thời gian ≈ 0.19 s
    const kt = hop === 512 ? 17 : 9;
    const ctx = makeContext(hop, kt);
    const N = left.length;
    const coreLen = Math.round(((opt.segmentSec || 15) * sr) / hop) * hop;
    const ctxLen = Math.round((1.0 * sr) / hop) * hop;
    const vocal = new Float32Array(N);
    const isMono = left === right;
    const segs = Math.max(1, Math.ceil(N / coreLen));
    for (let s = 0; s < segs; s++) {
      if (opt.shouldCancel && opt.shouldCancel()) throw new Error('cancelled');
      const c0 = s * coreLen, c1 = Math.min(N, c0 + coreLen);
      const e0 = Math.max(0, c0 - ctxLen), e1 = Math.min(N, c1 + ctxLen);
      const l = left.subarray(e0, e1), r = isMono ? l : right.subarray(e0, e1);
      const v = processSegment(l, r, sr, P, ctx);
      vocal.set(v.subarray(c0 - e0, c0 - e0 + (c1 - c0)), c0);
      if (opt.onProgress) opt.onProgress((s + 1) / segs);
    }
    const musicL = new Float32Array(N), musicR = new Float32Array(N);
    for (let i = 0; i < N; i++) { musicL[i] = left[i] - vocal[i]; musicR[i] = right[i] - vocal[i]; }
    return { vocal, musicL, musicR, info: { strength: opt.strength || 'canbang', hop, segments: segs, mono: isMono } };
  }

  // ---------------------------------------------------------------- làm sạch vocal
  // Biquad RBJ (Direct Form II transposed)
  function biquad(type, fs, f0, Q, gainDb) {
    const A = Math.pow(10, (gainDb || 0) / 40), w0 = (2 * Math.PI * f0) / fs;
    const cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * Q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
    else if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
    else if (type === 'peaking') { b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; }
    else if (type === 'highshelf') {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sq);
      a0 = (A + 1) - (A - 1) * cw + sq; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sq;
    } else throw new Error('biquad: loại không hỗ trợ ' + type);
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }
  function applyBiquad(x, c) {
    let z1 = 0, z2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = c.b0 * v + z1;
      z1 = c.b1 * v - c.a1 * y + z2;
      z2 = c.b2 * v - c.a2 * y;
      x[i] = y;
    }
  }

  const CLEANUP = {
    nhe:  { hpf: 80,  hpfStages: 1, mudDb: -1.0, presDb: 1.0, airDb: 0.5, lpf: 0,     gateOffset: 4,  gateFloorDb: -12, compThr: -22, ratio: 2.0, name: 'Nhẹ' },
    vua:  { hpf: 100, hpfStages: 1, mudDb: -2.0, presDb: 2.0, airDb: 1.5, lpf: 15000, gateOffset: 7,  gateFloorDb: -20, compThr: -26, ratio: 3.0, name: 'Vừa' },
    manh: { hpf: 130, hpfStages: 2, mudDb: -3.0, presDb: 2.5, airDb: 1.0, lpf: 12000, gateOffset: 10, gateFloorDb: -30, compThr: -30, ratio: 4.0, name: 'Mạnh' },
  };

  const rmsOf = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / (x.length || 1)); };
  const dbOf = (v) => 20 * Math.log10(Math.max(v, 1e-9));

  // Noise gate mềm: ngưỡng tự động = sàn nhiễu (phân vị 10%) + offset
  function noiseGate(x, sr, offsetDb, floorDb) {
    const B = Math.max(1, Math.round(0.005 * sr)); // khối 5 ms
    const nb = Math.ceil(x.length / B);
    const lv = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let s = 0; const a = b * B, e = Math.min(x.length, a + 2 * B);
      for (let i = a; i < e; i++) s += x[i] * x[i];
      lv[b] = dbOf(Math.sqrt(s / Math.max(1, e - a)));
    }
    const live = Array.from(lv).filter((v) => v > -80).sort((p, q) => p - q);
    if (!live.length) return { openRatio: 0, thrDb: -80 };
    const floor = live[Math.floor(live.length * 0.1)];
    const thr = floor + offsetDb;
    const g = new Float32Array(nb);
    const floorGain = Math.pow(10, floorDb / 20);
    const atk = 1 - Math.exp(-1 / (0.005 / 0.005)), rel = 1 - Math.exp(-1 / (0.15 / 0.005));
    const holdBlocks = 8; // 40 ms
    let open = false, hold = 0, cur = floorGain, opened = 0;
    for (let b = 0; b < nb; b++) {
      if (lv[b] > thr) { open = true; hold = holdBlocks; }
      else if (lv[b] < thr - 3) { if (hold > 0) hold--; else open = false; }
      const target = open ? 1 : floorGain;
      cur += (target - cur) * (target > cur ? atk : rel);
      g[b] = cur; if (open) opened++;
    }
    for (let i = 0; i < x.length; i++) {
      const pos = i / B, b0 = Math.min(nb - 1, Math.floor(pos)), b1 = Math.min(nb - 1, b0 + 1), f = pos - b0;
      x[i] *= g[b0] * (1 - f) + g[b1] * f;
    }
    return { openRatio: opened / nb, thrDb: thr };
  }

  function compressor(x, sr, thrDb, ratio, kneeDb) {
    const atk = Math.exp(-1 / (0.008 * sr)), rel = Math.exp(-1 / (0.15 * sr));
    let env = -90, maxGr = 0;
    const slope = 1 - 1 / ratio;
    for (let i = 0; i < x.length; i++) {
      const lvl = dbOf(Math.abs(x[i]));
      env = lvl > env ? atk * env + (1 - atk) * lvl : rel * env + (1 - rel) * lvl;
      const over = env - thrDb;
      let gr = 0;
      if (over > kneeDb / 2) gr = slope * over;
      else if (over > -kneeDb / 2) gr = (slope * (over + kneeDb / 2) * (over + kneeDb / 2)) / (2 * kneeDb);
      if (gr > maxGr) maxGr = gr;
      x[i] *= Math.pow(10, -gr / 20);
    }
    return { maxGainReductionDb: maxGr };
  }

  /** Làm sạch vocal (mono). Trả về bản mới, không sửa đầu vào. */
  function cleanupVocal(input, sr, presetName, overrides) {
    const C = Object.assign({}, CLEANUP[presetName] || CLEANUP.vua, overrides || {});
    const x = new Float32Array(input);
    const inRms = rmsOf(x);
    for (let s = 0; s < C.hpfStages; s++) applyBiquad(x, biquad('highpass', sr, C.hpf, 0.707));
    if (C.mudDb) applyBiquad(x, biquad('peaking', sr, 300, 1.0, C.mudDb));
    if (C.presDb) applyBiquad(x, biquad('peaking', sr, 3000, 0.8, C.presDb));
    if (C.airDb) applyBiquad(x, biquad('highshelf', sr, 9000, 0.707, C.airDb));
    if (C.lpf) applyBiquad(x, biquad('lowpass', sr, Math.min(C.lpf, sr * 0.45), 0.707));
    const gate = noiseGate(x, sr, C.gateOffset, C.gateFloorDb);
    const comp = compressor(x, sr, C.compThr, C.ratio, 12);
    // giữ nguyên độ to trung bình như trước khi làm sạch (tăng tối đa +12 dB)
    const outRms = rmsOf(x);
    const g = outRms > 1e-9 ? Math.min(4, inRms / outRms) : 1;
    // giới hạn mềm: chỉ nén những đỉnh vượt 0.85, không hạ cả đoạn nên độ to không bị tụt
    const th = 0.85, rng = 0.13;
    let limited = 0;
    for (let i = 0; i < x.length; i++) {
      let v = x[i] * g; const a = Math.abs(v);
      if (a > th) { v = Math.sign(v) * (th + rng * Math.tanh((a - th) / rng)); limited++; }
      x[i] = v;
    }
    return { data: x, info: { preset: presetName || 'vua', gate, comp, gainDb: dbOf(g), limitedRatio: limited / (x.length || 1) } };
  }

  // ---------------------------------------------------------------- đo kiểm (test/benchmark)
  function sdrDb(ref, est) {
    let s = 0, e = 0;
    for (let i = 0; i < ref.length; i++) { s += ref[i] * ref[i]; const d = ref[i] - est[i]; e += d * d; }
    return e === 0 ? Infinity : 10 * Math.log10(s / e);
  }

  const api = { processSegment, makeContext, makeFFT, slidingMedian, separateAdvanced, cleanupVocal, noiseGate, compressor, biquad, applyBiquad, sdrDb, STRENGTH, CLEANUP, rmsOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DSP = api;
})(typeof self !== 'undefined' ? self : globalThis);
