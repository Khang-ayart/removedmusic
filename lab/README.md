# Removed Music Lab – thử nghiệm AI tách vocal trên thiết bị

Thư mục này **độc lập** với app chính: không sửa `index.html`, `app.js`, `style.css`, `manifest.json` ở gốc.
Mở tại `…/lab/index.html`.

## Thiết kế

| Yêu cầu | Cách làm |
|---|---|
| Xử lý hoàn toàn trên thiết bị | Bài hát chỉ đi từ file → bộ nhớ → Web Worker. Mạng chỉ dùng để tải model (Hugging Face) và thư viện (jsDelivr). |
| Không treo giao diện | Toàn bộ AI chạy trong Web Worker (`worker.js`); bài được chia khối 45 s (chồng 1.5 s, crossfade) để giới hạn RAM. |
| GPU nếu có, CPU nếu không | Thử WebGPU trước, lỗi thì tự chuyển WASM và ghi nguyên nhân vào báo cáo. |
| Tải model một lần | Ghi thẳng luồng tải vào Cache Storage `mrr-models-v1`, kiểm tra đủ dung lượng + đủ byte, xin `storage.persist()`. |
| Model tách khỏi app | Service worker chỉ dọn cache có tiền tố `lab-app-`. Cập nhật HTML/CSS/JS **không** xoá `mrr-models-*`. |
| WASM đa luồng trên GitHub Pages | Service worker thêm `COOP: same-origin` + `COEP: credentialless` để bật cross-origin isolation. |
| Giấy phép | Xem `config.js` và bảng dưới. |

Model thử: `timcsy/demucs-web-onnx` (`htdemucs_embedded.onnx`, ~172 MB, STFT nhúng trong graph) qua thư viện `demucs-web` (MIT) và ONNX Runtime Web.
Trọng số gốc là HTDemucs của Meta (MIT) nhưng repo Hugging Face trên **chưa có model card**; cần xác nhận lại giấy phép trước khi đưa vào app chính.

## Quy trình test trên Android (Chrome)

1. Mở trang `lab/`, chờ trang tự tải lại một lần (để bật isolation). Mục 1 phải thấy *Cross-origin isolated: Có*.
2. Bấm **Kiểm tra Hugging Face** → ghi nhận kết quả.
3. Bấm **Tải model** (nên dùng Wi-Fi) → xem tiến trình, tốc độ, thời gian.
4. **Đóng hẳn** Chrome/PWA rồi mở lại → phải báo "đã có trên thiết bị", không tải lại.
5. (Tuỳ chọn) Chrome ⋮ → *Thêm vào màn hình chính*, mở từ icon, kiểm tra lại bước 4 ở chế độ app.
6. Chọn mp3 ~3 phút:
   - Lần 1: **30 giây đầu**, tăng tốc *Tự động* (smoke test).
   - Lần 2: **Toàn bài**, chia khối 45 s.
   - Lần 3: *Chỉ CPU (WASM)* để đo trường hợp máy không có GPU.
7. Nghe A/B (Gốc / Vocal / Nhạc nền), ghi chú vocal còn lẫn gì, có méo/“rỗng”, có tiếng lạ ở chỗ nối khối (mỗi 43.5 s).
8. Thử lỗi: bật chế độ máy bay giữa lúc tải (phải báo lỗi rõ và không lưu file dở); chọn "Không chia" với bài dài (thử hết RAM).
9. Mục **5. Báo cáo** → *Sao chép* và gửi lại.

Nếu tab bị hệ thống đóng giữa chừng (hết RAM), lần mở sau trang tự báo "lần chạy trước bị dừng đột ngột ở bước …".

## Giới hạn đã biết

- RAM thật của tiến trình trình duyệt không đo được từ web; báo cáo chỉ có JS heap + `deviceMemory` (+ `measureUserAgentSpecificMemory` nếu máy hỗ trợ). Quan sát thêm bằng *Cài đặt → Pin/Bộ nhớ* hoặc việc tab có bị reload không.
- Tải model chưa hỗ trợ tiếp tục giữa chừng: mất mạng thì tải lại từ đầu (không để lại file dở).
- Thư viện nạp từ CDN lúc chạy; chưa đóng gói offline hoàn toàn (service worker có cache lại sau lần đầu).
- Thư viện `demucs-web` không cho biết backend thực tế; ta chạy từng backend riêng (GPU rồi CPU) để biết chắc.
