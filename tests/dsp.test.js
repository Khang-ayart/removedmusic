// Chạy: node tests/dsp.test.js  (không cần thư viện ngoài)
const DSP = require('../dsp.js');
const synth = require('./synth.js');
let fails = 0; const ok = (c, m, x = '') => { if (!c) { fails++; console.log('FAIL', m, x); } else console.log('ok  ', m, x); };
let seed = 99; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));

// 1. FFT khớp DFT thô + khứ hồi
{ const N = 256, f = DSP.makeFFT(N), re = Float64Array.from({ length: N }, rnd), im = Float64Array.from({ length: N }, rnd), r0 = re.slice(), i0 = im.slice();
  f.transform(re, im, false); let e = 0;
  for (const k of [0, 1, 5, 100, 255]) { let sr = 0, si = 0; for (let n = 0; n < N; n++) { const a = -2 * Math.PI * k * n / N; sr += r0[n] * Math.cos(a) - i0[n] * Math.sin(a); si += r0[n] * Math.sin(a) + i0[n] * Math.cos(a); } e = Math.max(e, Math.abs(sr - re[k]), Math.abs(si - im[k])); }
  f.transform(re, im, true); let rt = 0; for (let n = 0; n < N; n++) rt = Math.max(rt, Math.abs(re[n] / N - r0[n]));
  ok(e < 1e-9 && rt < 1e-12, 'FFT khớp DFT thô và khứ hồi', `(${e.toExponential(1)})`); }

// 2. Trung vị trượt khớp tính trực tiếp (nhiều cửa sổ, có giá trị trùng, có stride)
{ let worst = 0;
  for (const w of [3, 9, 17]) for (const n of [20, 40, 200]) {
    const stride = 3, src = new Float32Array(n * stride); for (let i = 0; i < src.length; i++) src[i] = Math.round(rnd() * 10) / 10;
    const dst = new Float32Array(n), tmp = new Float32Array(n + w + 2), win = new Float32Array(w);
    DSP.slidingMedian(src, 1, stride, n, w, dst, 0, 1, tmp, win);
    const h = w >> 1, at = (i) => { if (i < 0) i = -i; if (i > n - 1) i = 2 * (n - 1) - i; return src[1 + Math.max(0, Math.min(n - 1, i)) * stride]; };
    for (let i = 0; i < n; i++) { const a = []; for (let j = -h; j <= h; j++) a.push(at(i + j)); a.sort((x, y) => x - y); worst = Math.max(worst, Math.abs(a[h] - dst[i])); }
  }
  ok(worst === 0, 'slidingMedian khớp tính trực tiếp (w=3,9,17; n=5..200)', `(lệch tối đa ${worst})`); }

// 3. Tổng hợp STFT: tắt mọi mặt nạ → vocal phải bằng đúng tín hiệu giữa (L+R)/2
{ const sr = 44100, len = 44100 * 3, L = Float32Array.from({ length: len }, (_, i) => 0.3 * Math.sin(i / 7) + 0.1 * rnd()), R = Float32Array.from({ length: len }, (_, i) => 0.25 * Math.sin(i / 9) + 0.1 * rnd());
  const ctx = DSP.makeContext(512, 17), P = { simLo: -1e9, gamma: 1, beta: 2, fLo: -2e9, fFull: -1e9, noHpss: true };
  const v = DSP.processSegment(L, R, sr, P, ctx); let e = 0, s = 0;
  for (let i = 4000; i < len - 4000; i++) { const m = (L[i] + R[i]) / 2; e += (v[i] - m) ** 2; s += m * m; }
  ok(10 * Math.log10(s / e) > 60, 'STFT→mặt nạ=1→iSTFT tái tạo đúng tín hiệu giữa (L+R)/2', `(SNR ${(10 * Math.log10(s / e)).toFixed(0)} dB)`); }

// 4. Tách nâng cao: tốt hơn Mid/Side rõ rệt trên bài tổng hợp; kích thước/NaN; chia đoạn không để lại đường nối
{ const sr = 44100, S = synth(sr, 40), pad = sr / 2, cut = (x) => x.subarray(pad, x.length - pad);
  const mid = new Float32Array(S.N); for (let i = 0; i < S.N; i++) mid[i] = (S.left[i] + S.right[i]) / 2;
  const oldS = DSP.sdrDb(cut(S.vocal), cut(mid));
  const t0 = Date.now(); const r = DSP.separateAdvanced(S.left, S.right, sr, { strength: 'canbang' });
  const newS = DSP.sdrDb(cut(S.vocal), cut(r.vocal));
  ok(newS > oldS + 6, `SDR vocal: cũ ${oldS.toFixed(1)} dB → mới ${newS.toFixed(1)} dB (tốt hơn > 6 dB)`);
  ok(r.vocal.length === S.N && r.musicL.length === S.N && r.vocal.every(Number.isFinite), 'đầu ra đủ độ dài, không NaN/Inf');
  // chia đoạn 15 s: so với chạy 1 đoạn duy nhất (ép đoạn dài) → khác biệt nhỏ
  let m = 0; for (let i = 0; i < S.N; i++) m = Math.max(m, Math.abs(r.vocal[i] + r.musicL[i] - S.left[i]));
  ok(m < 1e-5, 'vocal + nền = bản gốc (kênh trái) chính xác', `(${m.toExponential(1)})`);
  // đường nối: chạy chia đoạn 15 s so với chạy một đoạn duy nhất → chênh lệch quanh mốc nối phải rất nhỏ
  const one = DSP.separateAdvanced(S.left, S.right, sr, { strength: 'canbang', segmentSec: 1000 });
  let dMax = 0, vRms = DSP.rmsOf(S.vocal);
  for (const b of [15 * sr, 30 * sr]) for (let i = b - 4410; i < b + 4410; i++) dMax = Math.max(dMax, Math.abs(r.vocal[i] - one.vocal[i]));
  ok(20 * Math.log10(dMax / vRms + 1e-12) < -25, 'chia đoạn 15 s không đổi kết quả quanh điểm nối (so với 1 đoạn)', `(lệch tối đa ${(20 * Math.log10(dMax / vRms + 1e-12)).toFixed(0)} dB so với mức vocal)`);
  // mono: không hỏng
  const mono = S.left; const rm = DSP.separateAdvanced(mono, mono, sr, {});
  ok(rm.vocal.every(Number.isFinite) && rm.info.mono, 'file mono chạy được (không NaN)');
  // huỷ giữa chừng
  let thrown = false; try { DSP.separateAdvanced(S.left, S.right, sr, { shouldCancel: () => true }); } catch (e) { thrown = e.message === 'cancelled'; }
  ok(thrown, 'huỷ giữa chừng ném lỗi "cancelled"'); }

// 5. Bộ lọc: đáp ứng tần số đúng thiết kế
{ const sr = 44100, mag = (c, f) => { const w = 2 * Math.PI * f / sr, cr = Math.cos(w), ci = -Math.sin(w), c2r = Math.cos(2 * w), c2i = -Math.sin(2 * w);
    const nr = c.b0 + c.b1 * cr + c.b2 * c2r, ni = c.b1 * ci + c.b2 * c2i, dr = 1 + c.a1 * cr + c.a2 * c2r, di = c.a1 * ci + c.a2 * c2i;
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di)); };
  ok(Math.abs(mag(DSP.biquad('highpass', sr, 100, 0.707), 100) + 3.01) < 0.1 && mag(DSP.biquad('highpass', sr, 100, 0.707), 20) < -25, 'highpass 100 Hz: −3 dB tại 100 Hz, chặn mạnh ở 20 Hz');
  ok(Math.abs(mag(DSP.biquad('peaking', sr, 3000, 0.8, 2), 3000) - 2) < 0.05 && Math.abs(mag(DSP.biquad('peaking', sr, 3000, 0.8, 2), 200)) < 0.2, 'peaking +2 dB tại 3 kHz, phẳng ở xa');
  ok(Math.abs(mag(DSP.biquad('highshelf', sr, 9000, 0.707, 1.5), 20000) - 1.5) < 0.3 && Math.abs(mag(DSP.biquad('highshelf', sr, 9000, 0.707, 1.5), 500)) < 0.1, 'highshelf +1.5 dB phía trên 9 kHz');
  ok(mag(DSP.biquad('lowpass', sr, 15000, 0.707), 19000) < -3, 'lowpass 15 kHz giảm ở 19 kHz'); }

// 6. Làm sạch vocal: bỏ ồn lúc nghỉ, giữ tiếng hát, giữ độ to, không vỡ tiếng
{ const sr = 44100, S = synth(sr, 24), sep = DSP.separateAdvanced(S.left, S.right, sr, { strength: 'canbang' });
  const pad = sr / 2, cut = (x) => x.subarray(pad, x.length - pad);
  for (const preset of ['nhe', 'vua', 'manh']) {
    const c = DSP.cleanupVocal(sep.vocal, sr, preset);
    const rmsIn = DSP.rmsOf(sep.vocal), rmsOut = DSP.rmsOf(c.data); let peak = 0; for (const v of c.data) peak = Math.max(peak, Math.abs(v));
    ok(c.data.every(Number.isFinite) && peak <= 0.981, `cleanup ${preset}: hữu hạn, đỉnh ≤ 0.98`, `(đỉnh ${peak.toFixed(2)})`);
    ok(Math.abs(db(rmsOut) - db(rmsIn)) < 1.5, `cleanup ${preset}: độ to trung bình giữ nguyên`, `(${(db(rmsOut) - db(rmsIn)).toFixed(2)} dB)`);
    if (preset === 'vua') {
      const rest = [], sung = []; // đoạn nghỉ hát (3 s sau mỗi 3 s) so với đoạn hát
      for (let t = 0.2; t < 23; t += 0.1) { const ph = Math.floor(t / 3) % 2 === 0; const a = Math.round(t * sr), b = a + Math.round(0.1 * sr); const rI = DSP.rmsOf(sep.vocal.subarray(a, b)), rO = DSP.rmsOf(c.data.subarray(a, b)); (ph ? sung : rest).push(db(rO) - db(rI)); }
      const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      ok(avg(rest) < avg(sung) - 3, 'gate: đoạn nghỉ bị giảm nhiều hơn đoạn hát ≥ 3 dB', `(nghỉ ${avg(rest).toFixed(1)} dB, hát ${avg(sung).toFixed(1)} dB)`);
      const si = (ref, est) => { let a = 0, b = 0; for (let i = 0; i < ref.length; i++) { a += ref[i] * est[i]; b += ref[i] * ref[i]; } const al = a / b; let sg = 0, er = 0; for (let i = 0; i < ref.length; i++) { const t = al * ref[i]; sg += t * t; er += (est[i] - t) ** 2; } return 10 * Math.log10(sg / er); };
      const gateOnly = DSP.cleanupVocal(sep.vocal, sr, 'vua', { hpfStages: 0, mudDb: 0, presDb: 0, airDb: 0, lpf: 0, ratio: 1 });
      const b4 = si(cut(S.vocal), cut(sep.vocal)), af = si(cut(S.vocal), cut(gateOnly.data));
      ok(af > b4 + 0.3, 'gate (tách riêng) làm vocal giống đáp án hơn (SI-SDR)', `(${b4.toFixed(1)} → ${af.toFixed(1)} dB)`);
    }
  }
  // HPF thật sự loại tiếng rền thấp
  const rumble = Float32Array.from({ length: sr * 2 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 40 * i / sr) + 0.1 * Math.sin(2 * Math.PI * 1000 * i / sr));
  const cr = DSP.cleanupVocal(rumble, sr, 'vua', { gateOffset: -200 }); // tắt gate để thử riêng EQ/nén
  const proj = (x, f) => { let c = 0, s = 0; for (let i = sr / 2; i < sr * 1.5; i++) { c += x[i] * Math.cos(2 * Math.PI * f * i / sr); s += x[i] * Math.sin(2 * Math.PI * f * i / sr); } return Math.hypot(c, s); };
  const ratioIn = proj(rumble, 40) / proj(rumble, 1000), ratioOut = proj(cr.data, 40) / proj(cr.data, 1000);
  ok(ratioOut / ratioIn < 0.2, 'HPF: tiếng rền 40 Hz giảm > 14 dB so với 1 kHz', `(${(20 * Math.log10(ratioOut / ratioIn)).toFixed(1)} dB)`); }

console.log(fails ? `\n${fails} FAILED` : '\nALL DSP TESTS PASSED'); process.exit(fails ? 1 : 0);
