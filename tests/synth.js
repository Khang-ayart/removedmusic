// Bài nhạc tổng hợp có "đáp án": vocal thật, nhạc nền thật.
module.exports = function synth(sr, seconds, seed = 7) {
  let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const N = Math.round(sr * seconds);
  const vocal = new Float32Array(N), L = new Float32Array(N), R = new Float32Array(N);
  // --- vocal: các nốt có rung, hài + formant, ngắt câu, phụ âm; ở GIỮA
  const notes = [220, 247, 294, 330, 294, 262, 220, 196, 247, 330, 392, 330];
  let ph = 0, t0 = 0;
  const noteLen = 0.5;
  for (let i = 0; i < N; i++) {
    const t = i / sr, ni = Math.floor(t / noteLen) % notes.length, tn = (t % noteLen) / noteLen;
    const phrase = (Math.floor(t / (noteLen * 6)) % 2 === 0) ? 1 : 0.0; // câu hát / nghỉ
    const env = phrase * Math.min(1, tn * 12) * Math.min(1, (1 - tn) * 8);
    const f0 = notes[ni] * Math.pow(2, 0.4 * Math.sin(2 * Math.PI * 5.5 * t) / 12);
    ph += (2 * Math.PI * f0) / sr;
    let v = 0;
    for (let h = 1; h <= 18; h++) {
      const fh = f0 * h; if (fh > sr * 0.45) break;
      const form = Math.exp(-((fh - 800) ** 2) / (2 * 300 ** 2)) + 0.6 * Math.exp(-((fh - 2500) ** 2) / (2 * 500 ** 2)) + 0.05;
      v += (form / h) * Math.sin(h * ph);
    }
    let cons = 0; if (tn < 0.06 && phrase) cons = 0.25 * rnd();
    vocal[i] = 0.35 * (v * env + cons);
  }
  // --- nhạc nền
  const addTone = (arr, f, a, t, d) => {};
  let pp = [0, 0, 0, 0, 0, 0];
  const chords = [[220, 277, 330], [196, 247, 294], [175, 220, 262], [196, 247, 294]];
  const rev = new Float32Array(N); // hồi âm vocal: ngẫu nhiên, phân rã
  for (let i = 0; i < N; i++) {
    const t = i / sr, beat = (t * 2) % 1, bar = Math.floor(t / 2) % 4;
    const ch = chords[bar];
    let padL = 0, padR = 0;
    for (let c = 0; c < 3; c++) {
      pp[c] += (2 * Math.PI * ch[c] * 2) / sr; pp[c + 3] += (2 * Math.PI * ch[c] * 2.003) / sr; // 2 giọng lệch nhẹ
      const a = Math.sin(pp[c]) + 0.5 * Math.sin(2 * pp[c]) + 0.3 * Math.sin(3 * pp[c]);
      const b = Math.sin(pp[c + 3]) + 0.5 * Math.sin(2 * pp[c + 3]) + 0.3 * Math.sin(3 * pp[c + 3]);
      padL += 0.9 * a + 0.2 * b; padR += 0.2 * a + 0.9 * b; // rộng, lệch hai bên
    }
    // guitar bật dây bên phải (hài, gẫy)
    const gt = (t * 4) % 1, gf = ch[0] * 2 * (1 + Math.floor((t * 4) % 3) * 0.25);
    const guitar = Math.exp(-gt * 6) * (Math.sin(2 * Math.PI * gf * t) + 0.4 * Math.sin(4 * Math.PI * gf * t));
    // bass ở giữa
    const bass = 0.5 * Math.sin(2 * Math.PI * ch[0] / 4 * t) * (0.6 + 0.4 * Math.exp(-beat * 3));
    // kick (giữa, xung), snare (giữa, nhiễu + tone), hi-hat (nhiễu cao lệch phải)
    const kick = Math.exp(-beat * 14) * Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-beat * 25)) * t) * 0.9;
    const sn = ((t * 2 + 0.5) % 1); const snare = Math.exp(-sn * 18) * (0.5 * rnd() + 0.3 * Math.sin(2 * Math.PI * 190 * t));
    const hh = Math.exp(-((t * 4) % 1) * 30) * rnd() * 0.25;
    const cL = bass + kick + snare, cR = cL;
    L[i] = 0.07 * padL + 0.02 * guitar + cL * 0.6 + hh * 0.4;
    R[i] = 0.07 * padR + 0.10 * guitar + cR * 0.6 + hh * 0.9;
  }
  // hồi âm vocal độc lập hai kênh (đuôi stereo)
  const tail = (len) => { const k = new Float32Array(len); for (let i = 0; i < len; i++) k[i] = rnd() * Math.exp(-i / (0.12 * sr)); return k; };
  const kL = tail(Math.round(0.35 * sr)), kR = tail(Math.round(0.35 * sr));
  const wetL = new Float32Array(N), wetR = new Float32Array(N);
  for (let i = 0; i < N; i += 1) { const v = vocal[i]; if (!v) continue; const m = Math.min(kL.length, N - i); for (let j = 0; j < m; j += 4) { wetL[i + j] += v * kL[j] * 0.012; wetR[i + j] += v * kR[j] * 0.012; } }
  const trueMusicL = new Float32Array(N), trueMusicR = new Float32Array(N);
  for (let i = 0; i < N; i++) { trueMusicL[i] = L[i]; trueMusicR[i] = R[i]; L[i] += vocal[i] + wetL[i]; R[i] += vocal[i] + wetR[i]; }
  return { sr, N, left: L, right: R, vocal, trueMusicL, trueMusicR };
};
