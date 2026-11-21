// Cấu hình bản thử nghiệm. Có thể ghi đè bằng query string để test (vd. ?ort=1.22.0&threads=1).
const q = new URLSearchParams(self.location.search);

const ortVersion = q.get('ort') || '1.22.0';
const ortBase = q.get('ortBase') || `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVersion}/dist/`;

export const CONFIG = {
  defaultModel: q.get('model') || 'mdx_voc_ft',
  models: {
    // Mặc định: nhẹ hơn ~2.6 lần so với HTDemucs, chuyên tách vocal.
    mdx_voc_ft: {
      key: 'mdx_voc_ft', id: 'mdx-voc-ft', kind: 'mdx',
      name: 'MDX-Net Voc FT (UVR) – nhẹ, chuyên vocal',
      url: q.get('mdxUrl') ||
        'https://huggingface.co/masszhou/mdxnet/resolve/main/UVR-MDX-NET-Voc_FT.onnx',
      approxBytes: Number(q.get('mdxBytes')) || 66.8 * 1000 * 1000,
      mdx: { nFft: 6144, hop: 1024, dimF: 3072, dimT: 256 },
      primary: 'vocals', // đầu ra của model là vocal; nhạc nền = bản gốc − vocal
      license: 'MIT (dự án UVR; repo Hugging Face gắn thẻ MIT). Cần ghi công UVR/Anjok07, Kimberley Jensen.',
    },
    htdemucs: {
      key: 'htdemucs', id: 'htdemucs-timcsy-embedded', kind: 'demucs',
      name: 'HTDemucs 4-stem (nặng, chất lượng cao)',
      url: q.get('modelUrl') ||
        'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx',
      approxBytes: Number(q.get('modelBytes')) || 172 * 1000 * 1000,
      license: 'Trọng số gốc: Meta/facebookresearch demucs (MIT). Repo HF này chưa có model card.',
    },
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
