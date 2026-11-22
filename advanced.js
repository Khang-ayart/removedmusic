/* Chế độ tách NÂNG CAO + làm sạch vocal + nghe so sánh A/B.
 * Chạy trong Web Worker (dsp-worker.js), không đưa âm thanh lên máy chủ.
 * app.js gọi RMAdvanced.run() khi người dùng chọn chế độ "Nâng cao"; chế độ "Cơ bản" giữ nguyên như cũ. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const S = { worker: null, ctx: null, orig: null, sr: 0, raw: null, musicL: null, musicR: null, cleaned: null, bufs: {}, rms: {}, busy: false };

  function newWorker() {
    if (S.worker) S.worker.terminate();
    S.worker = new Worker('dsp-worker.js');
    return S.worker;
  }

  function request(msg, transfer, onProgress) {
    return new Promise((resolve, reject) => {
      const w = S.worker;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') { if (onProgress) onProgress(m.p); }
        else if (m.type === 'error') reject(new Error(m.message));
        else resolve(m);
      };
      w.onerror = (e) => reject(new Error(e.message || 'Không khởi động được bộ xử lý nền'));
      w.postMessage(msg, transfer || []);
    });
  }

  function setProgress(text, p) {
    const bar = $('progressBar');
    $('status').innerText = text;
    if (p == null) { bar.hidden = true; return; }
    bar.hidden = false; bar.value = p;
  }

  function mkBuffer(channels, sr) {
    const b = S.ctx.createBuffer(channels.length, channels[0].length, sr);
    channels.forEach((c, i) => b.copyToChannel(c, i));
    return b;
  }
  function rmsOfBuffer(buf) {
    let s = 0, n = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i += 4) { s += d[i] * d[i]; n++; } }
    return Math.sqrt(s / (n || 1));
  }

  async function refreshCleanup() {
    S.cleaned = null;
    if (!$('cleanupChk').checked) return;
    const copy = S.raw.slice();
    const r = await request({ type: 'cleanup', vocal: copy, sr: S.sr, preset: $('cleanupPreset').value }, [copy.buffer]);
    S.cleaned = r.data;
  }

  function buildBuffers() {
    stopAB(true);
    S.bufs = {
      orig: S.orig,
      raw: mkBuffer([S.raw], S.sr),
      clean: S.cleaned ? mkBuffer([S.cleaned], S.sr) : null,
      music: mkBuffer([S.musicL, S.musicR], S.sr),
    };
    S.rms = {};
    for (const k of Object.keys(S.bufs)) if (S.bufs[k]) S.rms[k] = rmsOfBuffer(S.bufs[k]);
    $('abPanel').style.display = 'block';
    const cleanBtn = document.querySelector('[data-ab="clean"]');
    cleanBtn.disabled = !S.bufs.clean;
    if (!S.bufs.clean && ab.mode === 'clean') setABMode('raw');
  }

  function outputBuffers() {
    return { vocalBuffer: S.bufs.clean || S.bufs.raw, musicBuffer: S.bufs.music };
  }

  async function run(originalBuffer, ctx) {
    if (S.busy) throw new Error('Đang xử lý');
    S.busy = true; S.ctx = ctx; S.orig = originalBuffer; S.sr = originalBuffer.sampleRate;
    $('cancelBtn').hidden = false;
    try {
      const mono = originalBuffer.numberOfChannels < 2;
      const l = originalBuffer.getChannelData(0).slice();
      const r = mono ? null : originalBuffer.getChannelData(1).slice();
      newWorker();
      setProgress('🎚️ Đang tách vocal… 0%', 0);
      const sep = await request(
        { type: 'separate', left: l, right: r, mono, sr: S.sr, strength: $('strengthSelect').value, detail: 'fast' },
        mono ? [l.buffer] : [l.buffer, r.buffer],
        (p) => setProgress(`🎚️ Đang tách vocal… ${Math.round(p * 100)}%`, p));
      S.raw = sep.vocal; S.musicL = sep.musicL; S.musicR = sep.musicR; S.info = sep.info;
      if ($('cleanupChk').checked) { setProgress('✨ Đang làm sạch vocal…', null); await refreshCleanup(); }
      buildBuffers();
      const note = sep.info.mono ? ' (file mono: không tận dụng được âm thanh nổi nên kết quả hạn chế)' : '';
      setProgress('✅ Tách thành công (chế độ nâng cao)!' + note, null);
      return outputBuffers();
    } finally {
      S.busy = false; $('cancelBtn').hidden = true;
    }
  }

  // Đổi bật/tắt hoặc mức làm sạch sau khi đã tách xong
  async function reapplyCleanup() {
    if (!S.raw || S.busy) return;
    S.busy = true;
    try {
      if (typeof stopPlayback === 'function') stopPlayback();
      $('status').innerText = '✨ Đang cập nhật làm sạch vocal…';
      if (!S.worker) newWorker();
      await refreshCleanup();
      buildBuffers();
      const o = outputBuffers();
      window.RM.setBuffers(o.vocalBuffer, o.musicBuffer);
      $('status').innerText = $('cleanupChk').checked ? '✅ Đã áp dụng làm sạch vocal.' : '✅ Đã tắt làm sạch vocal (vocal thô).';
    } catch (e) { $('status').innerText = '❌ Lỗi: ' + e.message; } finally { S.busy = false; }
  }

  function cancel() {
    if (S.worker) { S.worker.terminate(); S.worker = null; }
    S.busy = false; $('cancelBtn').hidden = true;
    setProgress('⏹ Đã huỷ.', null);
    $('processBtn').disabled = false;
    if (window.RM && window.RM.onCancel) window.RM.onCancel();
  }

  // ---------------- Nghe so sánh A/B (chuyển tức thì, cùng một đồng hồ) ----------------
  const ab = { ac: null, nodes: [], playing: false, offset: 0, startedAt: 0, mode: 'raw', timer: null };
  const duration = () => (S.orig ? S.orig.duration : 0);

  function gainFor(k) {
    if (!$('abLevel').checked || !S.rms.orig) return 1;
    const g = S.rms.orig / (S.rms[k] || 1e-9);
    return Math.min(4, Math.max(0.25, g));
  }
  function applyABMode(smooth) {
    for (const n of ab.nodes) {
      const t = n.k === ab.mode ? gainFor(n.k) : 0;
      if (smooth) n.g.gain.setTargetAtTime(t, ab.ac.currentTime, 0.015); else n.g.gain.value = t;
    }
  }
  function startAB() {
    if (!S.bufs.raw) return;
    if (typeof stopPlayback === 'function') stopPlayback(); // không phát chồng với trình phát chính
    if (!ab.ac) ab.ac = S.ctx;
    ab.ac.resume();
    if (ab.offset >= duration() - 0.05) ab.offset = 0;
    ab.nodes = Object.keys(S.bufs).filter((k) => S.bufs[k]).map((k) => {
      const s = ab.ac.createBufferSource(); s.buffer = S.bufs[k];
      const g = ab.ac.createGain(); s.connect(g).connect(ab.ac.destination); s.start(0, ab.offset);
      return { k, s, g };
    });
    applyABMode(false);
    ab.startedAt = ab.ac.currentTime - ab.offset; ab.playing = true;
    ab.nodes[0].s.onended = () => { if (ab.playing && ab.ac.currentTime - ab.startedAt >= duration() - 0.1) stopAB(true); };
    $('abPlayBtn').innerText = '⏸ Tạm dừng';
    clearInterval(ab.timer);
    ab.timer = setInterval(() => { $('abSeek').value = Math.round(((ab.ac.currentTime - ab.startedAt) / duration()) * 1000); }, 250);
  }
  function stopAB(reset) {
    if (ab.playing && ab.ac) ab.offset = ab.ac.currentTime - ab.startedAt;
    for (const n of ab.nodes) { try { n.s.onended = null; n.s.stop(); } catch (e) { /* đã dừng */ } n.s.disconnect(); n.g.disconnect(); }
    ab.nodes = []; ab.playing = false; clearInterval(ab.timer);
    if (reset) { ab.offset = 0; $('abSeek').value = 0; }
    $('abPlayBtn').innerText = '▶️ Nghe';
  }
  function setABMode(m) {
    ab.mode = m;
    document.querySelectorAll('[data-ab]').forEach((b) => b.classList.toggle('on', b.dataset.ab === m));
    if (ab.playing) applyABMode(true);
  }

  document.querySelectorAll('[data-ab]').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) setABMode(b.dataset.ab); }));
  $('abPlayBtn').addEventListener('click', () => (ab.playing ? stopAB(false) : startAB()));
  $('abSeek').addEventListener('input', () => {
    const was = ab.playing; if (was) stopAB(false);
    ab.offset = ($('abSeek').value / 1000) * duration();
    if (was) startAB();
  });
  $('abLevel').addEventListener('change', () => { if (ab.playing) applyABMode(true); });
  $('cancelBtn').addEventListener('click', cancel);
  $('cleanupChk').addEventListener('change', () => { $('cleanupPreset').disabled = !$('cleanupChk').checked; reapplyCleanup(); });
  $('cleanupPreset').addEventListener('change', reapplyCleanup);
  $('modeSelect').addEventListener('change', () => {
    $('advOptions').style.display = $('modeSelect').value === 'advanced' ? 'block' : 'none';
  });
  setABMode('raw');

  window.RMAdvanced = { run, stopAB, isBusy: () => S.busy };
  window.__RMstate = S; // phục vụ kiểm thử
})();
