# Manual Test Plan — Test 5: Browser Player with Silent AAC Audio

## Mục tiêu
Verify rằng trình duyệt non-Safari (Chrome/Firefox) có thể phát HLS stream từ server
mà không bị lỗi audio, không bị đứng hình, và silent AAC track hoạt động bình thường.

## Điều kiện tiên quyết
1. Server đang chạy với custom HLS wrapper:
   ```
   cd server
   node dist/index.js
   ```
2. Có iPhone thật kết nối cùng mạng Wi-Fi, chạy app SloMoLive
3. Máy tính có Chrome và/hoặc Firefox
4. iPhone đã bật Live Stream và đang push RTMP

## URL test
- HLS playlist: `http://<server-ip>:8000/live/<streamKey>/index.m3u8`
  (Server IP hiển thị trong console server khi start)
- Web app: `http://<server-ip>:4000`

## Các bước test

### Bước 1: Khởi động stream từ iPhone
1. Mở app SloMoLive trên iPhone
2. Bấm nút "Start Stream" (app sẽ gọi POST /api/stream/start, nhận streamKey, rồi push RTMP)
3. Quan sát console server: phải thấy `[MediaServer] Starting HLS session for <streamKey>`
4. Quan sát thư mục `server/media/live/<streamKey>/`:
   - File `00000.ts`, `00001.ts`,... phải xuất hiện (1 file/giây)
   - File `index.m3u8` phải tồn tại
5. Copy URL HLS: `http://<server-ip>:8000/live/<streamKey>/index.m3u8`

### Bước 2: Test trên Chrome
1. Mở Chrome, truy cập `chrome://inspect/#devices` hoặc mở DevTools → Console
2. Mở tab mới, paste URL HLS vào address bar
3. HOẶC mở DevTools Console, chạy:
   ```js
   const video = document.createElement('video');
   video.src = 'http://<server-ip>:8000/live/<streamKey>/index.m3u8';
   video.controls = true;
   video.autoplay = true;
   video.style.width = '640px';
   video.style.height = '480px';
   document.body.appendChild(video);
   ```
4. Quan sát:
   - ✅ Video phải phát ngay lập tức (không buffering dài)
   - ✅ Không có lỗi `MediaError` trong console
   - ✅ Thanh seek bar hoạt động (DVR — tua được vài giây trước)
   - ✅ Âm thanh câm (silent AAC) không gây ra tiếng ồn, không đứng hình
   - ✅ `playbackRate` có thể thay đổi (slow-motion)

### Bước 3: Test trên Firefox
1. Lặp lại Bước 2 trên Firefox
2. Quan sát: cùng kết quả như Chrome

### Bước 4: Test Safari (baseline — đã hỗ trợ HLS native)
1. Mở Safari trên Mac/iPhone
2. Truy cập URL HLS trực tiếp (Safari hỗ trợ HLS native không cần hls.js)
3. Quan sát:
   - ✅ Video phát được
   - ✅ Silent audio track vẫn hoạt động (không lỗi audio)
   - ✅ So sánh: playback phải mượt hơn Chrome (vì Safari dùng native HLS)

### Bước 5: Test DVR window (tua lại)
1. Chờ stream chạy ít nhất 10 giây
2. Kéo thanh seek bar về phía trái (tua lại)
3. Xác nhận: có thể tua được ít nhất 5 giây trước (với test config hls_list_size=5)
4. Sau khi test xong: bấm "End Stream" trên iPhone
5. Quan sát: thư mục segment bị xóa sạch

## Kết quả kỳ vọng

| Trình duyệt | Video phát | Audio câm OK | DVR hoạt động | Không có lỗi |
|-------------|-----------|-------------|---------------|-------------|
| Chrome      | ✅         | ✅           | ✅             | ✅           |
| Firefox     | ✅         | ✅           | ✅             | ✅           |
| Safari      | ✅         | ✅           | ✅             | ✅           |

## Lỗi thường gặp

### "All tee outputs failed" hoặc "Conversion failed"
→ FFmpeg không sinh được .ts files. Xem server log. Nguyên nhân thường:
- FFmpeg path không đúng trong NMS config
- Quyền ghi thư mục media

### "MediaError: Media source not supported"
→ Trình duyệt không hỗ trợ codec H.264 profile trong segment. Thường do iOS push H.264 High profile nhưng browser yêu cầu Baseline/Main. Cần thêm `-profile:v baseline` trong custom HLS wrapper.

### "Failed to open file" trong server log
→ FFmpeg không ghi được file .ts. Nguyên nhân: backslash trong path trên Windows. Đã được fix bằng custom wrapper gọi ffmpeg trực tiếp.

## Cleanup sau test
Sau khi test xong, revert config về production:
- Không cần làm gì (code đã dùng env vars với default production)
- Nếu muốn test lại với config khác, set env var khi start:
  ```
  DVR_WINDOW_SECONDS=5 node dist/index.js
  ```
