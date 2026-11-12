const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({ log: true });

const fileInput = document.getElementById('fileInput');
const processBtn = document.getElementById('processBtn');
const statusDiv = document.getElementById('status');
const controlsDiv = document.getElementById('controls');

let vocalAudio = new Audio();
let musicAudio = new Audio();
let isPlaying = false;

// Load FFmpeg khi mở web
(async () => {
    statusDiv.innerText = "⏳ Đang tải engine tách nhạc...";
    await ffmpeg.load();
    statusDiv.innerText = "✅ Sẵn sàng! Hãy chọn file nhạc.";
    processBtn.disabled = false;
})();

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        document.getElementById('fileName').innerText = file.name;
    }
});

processBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    processBtn.disabled = true;
    statusDiv.innerText = "🔄 Đang tách nhạc (có thể mất 10-30s)...";

    ffmpeg.FS('writeFile', 'input.mp3', await fetchFile(file));

    // Tách Vocal (giữ kênh giữa)
    await ffmpeg.run('-i', 'input.mp3', '-af', 'pan=mono|c0=0.5*c0+0.5*c1', 'vocal.wav');
    // Tách Music (loại kênh giữa - karaoke)
    await ffmpeg.run('-i', 'input.mp3', '-af', 'pan=mono|c0=0.5*c0-0.5*c1', 'music.wav');

    const vocalData = ffmpeg.FS('readFile', 'vocal.wav');
    const musicData = ffmpeg.FS('readFile', 'music.wav');

    vocalAudio.src = URL.createObjectURL(new Blob([vocalData.buffer], { type: 'audio/wav' }));
    musicAudio.src = URL.createObjectURL(new Blob([musicData.buffer], { type: 'audio/wav' }));

    statusDiv.innerText = "✅ Tách thành công!";
    controlsDiv.style.display = 'block';
    processBtn.disabled = false;
});

// Điều chỉnh âm lượng
document.getElementById('vocalSlider').addEventListener('input', (e) => {
    vocalAudio.volume = e.target.value / 100;
    document.getElementById('vocalVal').innerText = e.target.value + '%';
});
document.getElementById('musicSlider').addEventListener('input', (e) => {
    musicAudio.volume = e.target.value / 100;
    document.getElementById('musicVal').innerText = e.target.value + '%';
});

// Phát nhạc
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