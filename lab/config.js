// Cấu hình bản thử nghiệm. Có thể ghi đè bằng query string để test (vd. ?ort=1.22.0&threads=1).
const q = new URLSearchParams(self.location.search);

const ortVersion = q.get('ort') || '1.22.0';
const ortBase = q.get('ortBase') || `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVersion}/dist/`;

export const CONFIG = {
  model: {
    id: 'htdemucs-timcsy-embedded',
    name: 'HTDemucs 4-stem (ONNX, STFT nhúng sẵn)',
    // Đây chính là DEFAULT_MODEL_URL của thư viện demucs-web.
    url: q.get('modelUrl') ||
      'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx',
    // Chỉ dùng để hiển thị trước khi biết kích thước thật.
    approxBytes: Number(q.get('modelBytes')) || 172 * 1000 * 1000,
    license: 'Trọng số gốc: Meta/facebookresearch demucs (MIT). Repo HF này chưa có model card.',
  },
  // Cache model TÁCH RIÊNG với cache ứng dụng. Service worker không bao giờ đụng vào tên này.
  modelCacheName: 'mrr-models-v1',
  ortVersion,
  ortUrl: q.get('ortUrl') || `${ortBase}ort.webgpu.min.mjs`,
  ortBase,
  demucsUrls: q.get('demucs')
    ? [q.get('demucs')]
    : ['https://cdn.jsdelivr.net/npm/demucs-web/+esm', 'https://esm.sh/demucs-web'],
  sampleRate: 44100,
  overlapSec: 1.5,
};
