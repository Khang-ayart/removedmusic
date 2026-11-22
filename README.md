# 🎵 Removed Music - MR Removed Web App

Ứng dụng web giúp tách **Vocal** (giọng hát) và **Music** (nhạc nền) từ file âm thanh ngay trên trình duyệt, lấy cảm hứng từ khái niệm "MR Removed" trong cộng đồng K-pop.

![Removed Music](https://img.shields.io/badge/Status-Active-success)
![License](https://img.shields.io/badge/License-MIT-blue)

## ✨ Tính năng

- 🎤 **Tách Vocal & Music**: Tách giọng hát và nhạc nền từ file audio/video
- 🎚️ **Điều chỉnh âm lượng độc lập**: 2 thanh slider riêng cho Vocal và Music
- ▶️ **Phát song song**: Nghe cả 2 track cùng lúc để so sánh
- 🔒 **Bảo mật**: Xử lý 100% trên trình duyệt, không upload file lên server
- 📱 **PWA Support**: Cài đặt như app trên điện thoại
- 🌐 **Multi-platform**: Chạy trên Android, iOS, Windows, macOS

## 🎚️ Chế độ tách

- **Nâng cao** (mặc định): xử lý phổ tần (STFT) tìm thành phần ở giữa, loại trống/bass, rồi *làm sạch vocal* (EQ, lọc ồn, nén). Chạy trong Web Worker nên không đơ giao diện, có tiến độ và nút Huỷ. Có panel **nghe so sánh A/B** (Gốc / Vocal / Vocal sạch / Nhạc) chuyển tức thì.
- **Cơ bản**: Mid/Side như bản cũ, nhanh nhưng kém với nhạc MV.

Không dùng AI, không tải model, không gửi dữ liệu đi đâu. Đây là xử lý tín hiệu cổ điển: tốt hơn Mid/Side rõ rệt nhưng **không bằng AI chuyên dụng**; nhạc có vocal không ở giữa hoặc hoà âm dày vẫn còn lọt nhạc. Số liệu kiểm thử hiện là trên âm thanh tổng hợp.

Kiểm thử: `node tests/dsp.test.js` (thuật toán) và `node tests/integration.adv.mjs` (Chrome headless, cần chỉnh đường dẫn file wav mẫu).

## 🚀 Cách sử dụng

1. Truy cập [removedmusic.vercel.app](https://removedmusic.vercel.app)
2. Nhấn **"📁 Chọn file nhạc"** và chọn file từ thiết bị
3. Nhấn **"⚡ Bắt đầu tách nhạc"** và chờ 10-30 giây
4. Dùng 2 thanh slider để điều chỉnh âm lượng Vocal và Music
5. Nhấn **Play** để nghe kết quả

## 🛠️ Công nghệ sử dụng

- **FFmpeg.wasm**: Thư viện xử lý âm thanh chạy trên trình duyệt
- **HTML5/CSS3/JavaScript**: Frontend thuần, không cần framework
- **Vercel**: Hosting và deploy
- **PWA**: Progressive Web App support

## 📦 Cài đặt để phát triển

```bash
# Clone repository
git clone https://github.com/Khang-ayart/removedmusic.git
cd removedmusic

# Mở file index.html bằng trình duyệt (hoặc dùng Live Server)
# Không cần cài đặt thêm gì!
```

## 🌐 Deploy lên Vercel

1. Fork repository này
2. Truy cập [vercel.com](https://vercel.com) và đăng nhập bằng GitHub
3. Import repository `removedmusic`
4. Nhấn **Deploy** - xong!

## ⚠️ Lưu ý

- Phương pháp tách nhạc sử dụng kỹ thuật **phase cancellation** (triệt tiêu pha), hoạt động tốt nhất với các bài hát có vocal nằm chính giữa stereo (hầu hết nhạc pop/K-pop).
- Chất lượng tách không thể bằng các AI model chuyên dụng (như Demucs, Spleeter) nhưng đủ dùng để kiểm tra vocal live.
- File nhạc được xử lý **hoàn toàn trên trình duyệt** của bạn, không được upload lên bất kỳ server nào.

## 🤝 Đóng góp

Mọi đóng góp đều được chào đón! Hãy tạo Issue hoặc Pull Request nếu bạn có ý tưởng cải thiện.

## 📄 License

Dự án này được phân phối dưới giấy phép [MIT](LICENSE).

## 🙏 Credits

- [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) - Thư viện xử lý âm thanh
- Cảm hứng từ cộng đồng **MR Removed** trong K-pop fandom

---

Made with ❤️ by **RyoK**