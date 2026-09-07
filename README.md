# HỆ THỐNG SLOW-MOTION 240FPS LIVE STREAM & WEB DATA CLASSIFICATION

Hệ thống hoàn chỉnh bao gồm 3 phân hệ chính:
1. **Backend Server (`server/`)**: Express API, Socket.io, JWT Authentication, SQLite/JSON Data Store, Phân quyền Admin & User, Quản lý thời hạn và Khóa thiết bị (Single Hardware Device Binding).
2. **Web Application (`web/`)**: React + Vite + Tailwind CSS + Hls.js hỗ trợ Live DVR Rewind, Slow-Motion Player (`0.05x`, `0.1x`, `0.25x`, `0.5x`, `0.75x`, `1.0x`), Frame Stepping (`+/- 1/240s`), Bộ tự phân loại dữ liệu Round-Robin $N$ nhóm, và Admin Dashboard.
3. **iOS Native Client (`ios/`)**: Swift & SwiftUI App với camera AVFoundation HFR 240fps, Keychain Device Lock, CoreLocation GPS background tracking.

---

## 🚀 HƯỚNG DẪN KHỞI CHẠY HỆ THỐNG

### 1. Khởi chạy Backend API & Realtime Server
```bash
cd e:\iosapp\server
npm run build
npm start
```
- Server chạy tại địa chỉ: `http://localhost:4000`
- Tự động tạo sẵn 2 tài khoản mẫu:
  - **Admin**: Username: `admin`, Password: `admin123`
  - **User**: Username: `demouser`, Password: `user123` (Hạn dùng 30 ngày)

---

### 2. Khởi chạy Web Application (Viewer & Admin Portal)
```bash
cd e:\iosapp\web
npm run dev
```
- Truy cập trình duyệt tại: `http://localhost:3000`
- **Tài khoản Admin**: Đăng nhập `admin/admin123` -> Mở giao diện quản lý User, đặt hạn dùng, gia hạn số ngày, khóa/mở khóa, reset Device Binding ID, xem vị trí định vị GPS streamer.
- **Tài khoản User**: Đăng nhập `demouser/user123` -> Tự động chuyển sang chế độ Viewer (Xem Live Stream, Tua lại DVR, Chỉnh tốc độ Slow-Motion 0.05x - 1.0x, Nhập lá bài và tự động chia thành $N$ nhóm).

---

### 3. Cấu hình & Biên dịch Ứng dụng iOS (SwiftUI)
- Mở dự án iOS bằng Xcode từ thư mục `e:\iosapp\ios\SloMoLive`.
- Chọn thiết bị thật (iPhone 8 trở lên) để kích hoạt chế độ quay High Frame Rate 240fps.
- Khi đăng nhập bằng tài khoản User (`demouser`), hệ thống sẽ gán Keychain Device UUID cố định với tài khoản này. Không thể dùng cùng tài khoản đó trên một chiếc iPhone khác nếu chưa được Admin Reset Device ID.

---

## 📋 DANH SÁCH YÊU CẦU ĐÃ ĐÁP ỨNG
1. **Live Stream lên Web**: Kết nối RTMP/HLS DVR realtime.
2. **iOS Slow-Motion 240fps**: Tích hợp `AVCaptureDeviceInput` với `activeFormat` matching 240fps HFR.
3. **Tua lại khi đang Live**: Hls.js Live DVR Seekbar cho phép xem lại các mốc thời gian quá khứ trực tiếp trong khi luồng live vẫn đang tiếp diễn.
4. **Tự ghép lá bài theo nhóm (Round-Robin)**: Cho phép chọn 2, 3, 4, 5 nhóm. Nhập thứ tự bài sẽ tự chia vòng $1 \rightarrow 2 \rightarrow 3 \rightarrow 1 \rightarrow 2 \rightarrow 3...$
5. **Tùy chỉnh tốc độ xem cực chậm khi Live**: Nút bấm tốc độ `0.05x`, `0.1x`, `0.25x`, `0.5x`, `0.75x`, `1.0x` + Nút tua từng khung hình `Frame Step (+/- 1/240s)`.
6. **Tự động lưu Video Live**: Lưu trữ phiên làm việc VOD server-side.
7. **Phân quyền Admin & User**:
   - **Admin**: Tạo user có thời hạn sử dụng, thêm/xóa/block, gia hạn ngày dùng, reset gán thiết bị di động, xem bản đồ GPS.
   - **User**: Duy nhất 1 điện thoại có quyền phát Live và gửi định vị GPS (Req 8a). Khi cùng tài khoản đăng nhập trên Web chỉ được Viewer mode (Req 8b).
