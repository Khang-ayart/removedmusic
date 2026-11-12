let audioContext;
let vocalBuffer, musicBuffer;
let vocalSource, musicSource;
let vocalGain, musicGain;
let isPlaying = false;
let processed = false;

const fileInput = document.getElementById('fileInput');
const processBtn = document.getElementById('processBtn');
const statusDiv = document.getElementById('status');
const controlsDiv = document.getElementById('controls');
const playBtn = document.getElementById('playBtn');
const downloadBtn = document.getElementById('downloadBtn');

// Khi chọn file → hiển thị tên và enable nút
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        document.getElementById('fileName').innerText = file.name;
        processBtn.disabled = false;
        statusDiv.innerText = "✅ Đã chọn file. Bấm 'Bắt đầu tách nhạc'!";
        processed = false;
        controlsDiv.style.display = 'none';
    }
});

// Xử lý tách nhạc bằng Web Audio API
processBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    processBtn.disabled = true;
    statusDiv.innerText = "🔄 Đang đọc file...";

    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await file.arrayBuffer();

        statusDiv.innerText = "🔄 Đang decode audio...";
        const originalBuffer = await audioContext.decodeAudioData(arrayBuffer);

        statusDiv.innerText = "🎚️ Đang tách Vocal & Music...";
        const length = originalBuffer.length;
        const sampleRate = originalBuffer.sampleRate;

        // Tạo 2 buffer mono
        vocalBuffer = audioContext.createBuffer(1, length, sampleRate);
        musicBuffer = audioContext.createBuffer(1, length, sampleRate);

        const vocalData = vocalBuffer.getChannelData(0);
        const musicData = musicBuffer.getChannelData(0);
        const left = originalBuffer.getChannelData(0);
        const right = originalBuffer.numberOfChannels > 1 
            ? originalBuffer.getChannelData(1) 
            : left;

        // Mid/Side processing:
        // Vocal (Mid) = (L + R) / 2  → giữ giọng hát ở giữa
        // Music (Side) = (L - R) / 2 → giữ nhạc nền 2 bên
        for (let i = 0; i < length; i++) {
            vocalData[i] = (left[i] + right[i]) / 2;
            musicData[i] = (left[i] - right[i]) / 2;
        }

        processed = true;
        statusDiv.innerText = "✅ Tách thành công!";
        controlsDiv.style.display = 'block';
        processBtn.disabled = false;

    } catch (err) {
        statusDiv.innerText = "❌ Lỗi: " + err.message;
        processBtn.disabled = false;
    }
});

// Phát 2 track song song
function startPlayback() {
    if (!processed) return;

    // Stop nếu đang phát
    stopPlayback();

    vocalSource = audioContext.createBufferSource();
    vocalSource.buffer = vocalBuffer;
    vocalGain = audioContext.createGain();
    vocalGain.gain.value = document.getElementById('vocalSlider').value / 100;
    vocalSource.connect(vocalGain).connect(audioContext.destination);

    musicSource = audioContext.createBufferSource();
    musicSource.buffer = musicBuffer;
    musicGain = audioContext.createGain();
    musicGain.gain.value = document.getElementById('musicSlider').value / 100;
    musicSource.connect(musicGain).connect(audioContext.destination);

    vocalSource.start();
    musicSource.start();
    isPlaying = true;
    playBtn.innerText = "⏸ Pause";
}

function stopPlayback() {
    if (vocalSource) { try { vocalSource.stop(); } catch(e){} vocalSource.disconnect(); }
    if (musicSource) { try { musicSource.stop(); } catch(e){} musicSource.disconnect(); }
    isPlaying = false;
    playBtn.innerText = "▶️ Play";
}

playBtn.addEventListener('click', () => {
    if (isPlaying) stopPlayback();
    else startPlayback();
});

// Slider điều chỉnh volume real-time
document.getElementById('vocalSlider').addEventListener('input', (e) => {
    document.getElementById('vocalVal').innerText = e.target.value + '%';
    if (vocalGain) vocalGain.gain.value = e.target.value / 100;
});

document.getElementById('musicSlider').addEventListener('input', (e) => {
    document.getElementById('musicVal').innerText = e.target.value + '%';
    if (musicGain) musicGain.gain.value = e.target.value / 100;
});

// Tải file Vocal (MR Removed) về máy
downloadBtn.addEventListener('click', () => {
    if (!vocalBuffer) return;
    const wavBlob = audioBufferToWav(vocalBuffer);
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'MR_Removed_Vocal.wav';
    a.click();
    URL.revokeObjectURL(url);
});
// Tải file Music (Instrumental) về máy
const downloadMusicBtn = document.getElementById('downloadMusicBtn');
downloadMusicBtn.addEventListener('click', () => {
    if (!musicBuffer) return;
    const wavBlob = audioBufferToWav(musicBuffer);
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'MR_Removed_Music_Instrumental.wav';
    a.click();
    URL.revokeObjectURL(url);
});

// Hàm convert AudioBuffer → WAV file
function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length;
    const channels = [];
    for (let i = 0; i < numChannels; i++) channels.push(buffer.getChannelData(i));

    const arrayBuffer = new ArrayBuffer(44 + length * numChannels * 2);
    const view = new DataView(arrayBuffer);
    const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + length * numChannels * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, length * numChannels * 2, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const s = Math.max(-1, Math.min(1, channels[ch][i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            offset += 2;
        }
    }
    return new Blob([arrayBuffer], { type: 'audio/wav' });
}