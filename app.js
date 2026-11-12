import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const ffmpeg = new FFmpeg();
let vocalAudio = new Audio();
let musicAudio = new Audio();
let isPlaying = false;

const statusDiv = document.getElementById('status');
const processBtn = document.getElementById('processBtn');
const controlsDiv = document.getElementById('controls');

// Load FFmpeg
(async () => {
    statusDiv.innerText = "⏳ Đang tải engine tách nhạc...";
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    
    await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    
    statusDiv.innerText = "✅ Sẵn sàng! Hãy chọn file nhạc.";
    processBtn.disabled = false;
})();

document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        document.getElementById('fileName').innerText = file.name;
    }
});

processBtn.addEventListener('click', async () => {
    const file = document.getElementById('fileInput').files[0];
    if (!file) return;

    processBtn.disabled = true;
    statusDiv.innerText = "🔄 Đang tách nhạc (10-30s)...";

    await ffmpeg.writeFile('input.mp3', await fetchFile(file));

    // Tách vocal
    await ffmpeg.exec(['-i', 'input.mp3', '-af', 'pan=mono|c0=0.5*c0+0.5*c1', 'vocal.wav']);
    // Tách music
    await ffmpeg.exec(['-i', 'input.mp3', '-af', 'pan=mono|c0=0.5*c0-0.5*c1', 'music.wav']);

    const vocalData = await ffmpeg.readFile('vocal.wav');
    const musicData = await ffmpeg.readFile('music.wav');

    vocalAudio.src = URL.createObjectURL(new Blob([vocalData.buffer], { type: 'audio/wav' }));
    musicAudio.src = URL.createObjectURL(new Blob([musicData.buffer], { type: 'audio/wav' }));

    statusDiv.innerText = "✅ Tách thành công!";
    controlsDiv.style.display = 'block';
    processBtn.disabled = false;
});

// Slider và Play/Pause giữ nguyên như code cũ
document.getElementById('vocalSlider').addEventListener('input', (e) => {
    vocalAudio.volume = e.target.value / 100;
    document.getElementById('vocalVal').innerText = e.target.value + '%';
});
document.getElementById('musicSlider').addEventListener('input', (e) => {
    musicAudio.volume = e.target.value / 100;
    document.getElementById('musicVal').innerText = e.target.value + '%';
});

document.getElementById('playBtn').addEventListener('click', () => {
    if (isPlaying) {
        vocalAudio.pause(); musicAudio.pause();
        document.getElementById('playBtn').innerText = "▶️ Play";
    } else {
        vocalAudio.play(); musicAudio.play();
        document.getElementById('playBtn').innerText = "⏸ Pause";
    }
    isPlaying = !isPlaying;
});