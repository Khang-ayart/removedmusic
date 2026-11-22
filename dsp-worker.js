// Web Worker: chạy toàn bộ xử lý nặng để giao diện không bị đơ. Âm thanh không rời thiết bị.
importScripts('dsp.js');

self.onmessage = function (e) {
  const m = e.data;
  try {
    if (m.type === 'separate') {
      const left = m.left, right = m.mono ? m.left : m.right;
      const r = self.DSP.separateAdvanced(left, right, m.sr, {
        strength: m.strength, detail: m.detail, synth: m.synth,
        onProgress: (p) => self.postMessage({ type: 'progress', stage: 'separate', p }),
      });
      self.postMessage({ type: 'separated', vocal: r.vocal, musicL: r.musicL, musicR: r.musicR, info: r.info },
        [r.vocal.buffer, r.musicL.buffer, r.musicR.buffer]);
    } else if (m.type === 'cleanup') {
      const r = self.DSP.cleanupVocal(m.vocal, m.sr, m.preset);
      self.postMessage({ type: 'cleaned', data: r.data, info: r.info }, [r.data.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
