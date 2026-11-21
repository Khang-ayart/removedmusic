// Tiền/hậu xử lý cho MDX-Net (UVR): STFT / iSTFT stereo bằng JavaScript thuần.
// Quy ước theo UVR: cửa sổ Hann tuần hoàn, center=True (đệm phản xạ), STFT không chuẩn hoá,
// bỏ bin Nyquist (dimF = nFft/2). Kênh: [L_re, L_im, R_re, R_im]; chỉ số phẳng ((c*dimF)+bin)*T + frame.

// FFT phức cho N = P * 2^m (P lẻ nhỏ, vd 3 cho 6144, 15 cho 7680). Không chuẩn hoá (cả thuận lẫn nghịch).
export class FFT {
  constructor(N) {
    let M = N, P = 1;
    while (M % 2 === 0) M /= 2; // M tạm = phần lẻ
    P = M; M = N / P;
    if ((M & (M - 1)) !== 0) throw new Error('FFT: N phải có dạng P*2^m');
    this.N = N; this.P = P; this.M = M;
    this.cosN = new Float64Array(N); this.sinN = new Float64Array(N);
    for (let j = 0; j < N; j++) { this.cosN[j] = Math.cos((2 * Math.PI * j) / N); this.sinN[j] = Math.sin((2 * Math.PI * j) / N); }
    this.cosM = new Float64Array(Math.max(1, M / 2)); this.sinM = new Float64Array(Math.max(1, M / 2));
    for (let j = 0; j < M / 2; j++) { this.cosM[j] = Math.cos((2 * Math.PI * j) / M); this.sinM[j] = Math.sin((2 * Math.PI * j) / M); }
    this.rev = new Uint32Array(M);
    let bits = 0; while ((1 << bits) < M) bits++;
    for (let i = 0; i < M; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); this.rev[i] = r; }
    if (P > 1) {
      this.sr = Array.from({ length: P }, () => new Float64Array(M));
      this.si = Array.from({ length: P }, () => new Float64Array(M));
    }
  }

  _pow2(re, im, inv) {
    const M = this.M, rev = this.rev, cosM = this.cosM, sinM = this.sinM;
    for (let i = 0; i < M; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sg = inv ? 1 : -1;
    for (let size = 2; size <= M; size <<= 1) {
      const half = size >> 1, stepT = M / size;
      for (let start = 0; start < M; start += size) {
        for (let k = 0, tw = 0; k < half; k++, tw += stepT) {
          const wr = cosM[tw], wi = sg * sinM[tw];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  // Biến đổi tại chỗ trên re/im (độ dài N).
  transform(re, im, inv = false) {
    const { N, P, M } = this;
    if (P === 1) { this._pow2(re, im, inv); return; }
    const { sr, si, cosN, sinN } = this;
    for (let r = 0; r < P; r++) {
      const a = sr[r], b = si[r];
      for (let n = 0; n < M; n++) { a[n] = re[P * n + r]; b[n] = im[P * n + r]; }
      this._pow2(a, b, inv);
    }
    const sg = inv ? 1 : -1;
    for (let k = 0; k < N; k++) {
      const kk = k % M;
      let xr = sr[0][kk], xi = si[0][kk];
      for (let r = 1; r < P; r++) {
        const idx = (r * k) % N;
        const c = cosN[idx], s = sg * sinN[idx];
        const fr = sr[r][kk], fi = si[r][kk];
        xr += fr * c - fi * s;
        xi += fr * s + fi * c;
      }
      re[k] = xr; im[k] = xi;
    }
  }
}

export class StereoSTFT {
  constructor(nFft, hop, dimF, dimT) {
    this.nFft = nFft; this.hop = hop; this.dimF = dimF; this.dimT = dimT;
    this.len = hop * (dimT - 1);
    this.fft = new FFT(nFft);
    this.win = new Float64Array(nFft);
    for (let n = 0; n < nFft; n++) this.win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / nFft); // Hann tuần hoàn
    this.zr = new Float64Array(nFft); this.zi = new Float64Array(nFft);
    // Hệ số chuẩn hoá overlap-add của iSTFT: Σ w² tại mỗi mẫu (center=True)
    this.env = new Float64Array(this.len);
    const pad = nFft / 2;
    for (let t = 0; t < dimT; t++) {
      const start = t * hop - pad;
      for (let j = 0; j < nFft; j++) { const p = start + j; if (p >= 0 && p < this.len) this.env[p] += this.win[j] * this.win[j]; }
    }
  }

  // l, r: Float32Array độ dài this.len. out: Float32Array 4*dimF*dimT.
  forward(l, r, out) {
    const { nFft: N, hop, dimF, dimT, win, zr, zi, fft, len } = this;
    const pad = N / 2;
    for (let t = 0; t < dimT; t++) {
      const start = t * hop - pad;
      for (let j = 0; j < N; j++) {
        let p = start + j;
        if (p < 0) p = -p; else if (p >= len) p = 2 * (len - 1) - p; // phản xạ (không lặp biên)
        zr[j] = l[p] * win[j]; zi[j] = r[p] * win[j];
      }
      fft.transform(zr, zi, false);
      for (let k = 0; k < dimF; k++) {
        const m = k === 0 ? 0 : N - k;
        const lre = 0.5 * (zr[k] + zr[m]), lim = 0.5 * (zi[k] - zi[m]);
        const rre = 0.5 * (zi[k] + zi[m]), rim = 0.5 * (zr[m] - zr[k]);
        out[(0 * dimF + k) * dimT + t] = lre;
        out[(1 * dimF + k) * dimT + t] = lim;
        out[(2 * dimF + k) * dimT + t] = rre;
        out[(3 * dimF + k) * dimT + t] = rim;
      }
    }
  }

  // spec: Float32Array 4*dimF*dimT -> ghi l, r (Float32Array độ dài this.len)
  inverse(spec, l, r) {
    const { nFft: N, hop, dimF, dimT, win, zr, zi, fft, len, env } = this;
    const pad = N / 2, half = N / 2;
    const accL = this._accL || (this._accL = new Float64Array(len));
    const accR = this._accR || (this._accR = new Float64Array(len));
    accL.fill(0); accR.fill(0);
    for (let t = 0; t < dimT; t++) {
      for (let k = 0; k <= half; k++) {
        let lre = 0, lim = 0, rre = 0, rim = 0;
        if (k < dimF) {
          lre = spec[(0 * dimF + k) * dimT + t]; lim = spec[(1 * dimF + k) * dimT + t];
          rre = spec[(2 * dimF + k) * dimT + t]; rim = spec[(3 * dimF + k) * dimT + t];
        }
        if (k === 0 || k === half) { lim = 0; rim = 0; } // DC/Nyquist của tín hiệu thực
        zr[k] = lre - rim; zi[k] = lim + rre;
        if (k > 0 && k < half) { const m = N - k; zr[m] = lre + rim; zi[m] = -lim + rre; }
      }
      fft.transform(zr, zi, true);
      const start = t * hop - pad;
      for (let j = 0; j < N; j++) {
        const p = start + j;
        if (p < 0 || p >= len) continue;
        accL[p] += (zr[j] / N) * win[j];
        accR[p] += (zi[j] / N) * win[j];
      }
    }
    for (let i = 0; i < len; i++) { const e = env[i] > 1e-11 ? env[i] : 1; l[i] = accL[i] / e; r[i] = accR[i] / e; }
  }
}

// Kế hoạch chia chunk kiểu UVR: bước = chunk - nFft, cộng gộp có trọng số Hann.
export function planMdxChunks(N, hop, dimT, nFft) {
  const chunk = hop * (dimT - 1), trim = nFft / 2, step = chunk - nFft;
  const padded = N + 2 * trim;
  const K = padded <= chunk ? 1 : Math.ceil((padded - chunk) / step) + 1;
  return { chunk, trim, step, K, accLen: (K - 1) * step + chunk, padded };
}

export function hannWeights(len) {
  const w = new Float32Array(len);
  for (let i = 0; i < len; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / len);
  return w;
}
