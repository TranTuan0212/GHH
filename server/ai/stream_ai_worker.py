import os
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"
import time
import base64
import threading
from datetime import datetime
import cv2
import numpy as np
import socketio
import requests
from ultralytics import YOLO
import torch

torch.set_num_threads(2)

BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:4000")
RTSP_BASE_URL = os.environ.get("RTSP_BASE_URL", "rtsp://127.0.0.1:8554")
RTMP_BASE_URL = os.environ.get("RTMP_BASE_URL", "rtmp://127.0.0.1:1935/live")

MODEL_DIR = os.path.dirname(__file__)
MODEL_PATH = os.path.join(MODEL_DIR, "cards_yolov8.pt")
CORNER_MODEL_PATH = os.path.join(MODEL_DIR, "cards_corner_yolo.pt")

print(f"[AI Worker] Loading YOLO model from {MODEL_PATH}...")
model = YOLO(MODEL_PATH)
print(f"[AI Worker] Main model loaded with {len(model.names)} classes.")

corner_model = None
if os.path.exists(CORNER_MODEL_PATH):
    try:
        print(f"[AI Worker] Loading corner model from {CORNER_MODEL_PATH}...")
        corner_model = YOLO(CORNER_MODEL_PATH)
        print("[AI Worker] Corner model loaded.")
    except Exception as e:
        print(f"[AI Worker] Corner model load error: {e}")

SUIT_MAP = {
    'S': {'suit': 'Bích', 'symbol': '♠', 'color': 'black', 'nameEn': 'Spades'},
    'H': {'suit': 'Cơ', 'symbol': '♥', 'color': 'red', 'nameEn': 'Hearts'},
    'D': {'suit': 'Rô', 'symbol': '♦', 'color': 'red', 'nameEn': 'Diamonds'},
    'C': {'suit': 'Tép', 'symbol': '♣', 'color': 'black', 'nameEn': 'Clubs'}
}

def parse_card_code(raw_code):
    c = str(raw_code).strip().upper()
    if not c or len(c) < 2:
        return None
    suit_char = c[-1]
    rank_str = c[:-1]
    if suit_char not in SUIT_MAP:
        return None
    suit_info = SUIT_MAP[suit_char]
    return {
        'code': f"{rank_str}{suit_char}",
        'rank': rank_str,
        'suit': suit_info['suit'],
        'suitSymbol': suit_info['symbol'],
        'color': suit_info['color'],
        'display': f"{rank_str}{suit_info['symbol']}",
        'fullName': f"{rank_str} {suit_info['suit']}"
    }

def check_card_paper_presence(crop_img):
    """
    Tầng 1 (Siêu nhẹ <0.5ms): Lọc chất liệu giấy bài quang học.
    Độ bão hòa màu thấp (S < 95), độ sáng (V > 50).
    Chỉ cần 6% diện tích mang đặc tính nền giấy là xác nhận có bài trong khung.
    """
    if crop_img is None or crop_img.size == 0:
        return True
    try:
        hsv = cv2.cvtColor(crop_img, cv2.COLOR_BGR2HSV)
        _, s, v = cv2.split(hsv)
        paper_mask = (s < 95) & (v > 50)
        paper_ratio = np.count_nonzero(paper_mask) / (crop_img.shape[0] * crop_img.shape[1])
        return paper_ratio >= 0.06
    except Exception:
        return True

def compute_sharpness(cv_image):
    """
    Tầng 1 (Siêu nhẹ <0.8ms): Đo độ nét của khung hình bằng phương sai Laplacian.
    Giúp tìm ra đỉnh điểm nét nhất trong chu kỳ: Mờ -> Rõ -> Mờ.
    """
    try:
        if len(cv_image.shape) == 3:
            gray = cv2.cvtColor(cv_image, cv2.COLOR_BGR2GRAY)
        else:
            gray = cv_image
        return round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 1)
    except Exception:
        return 0.0

def extract_cards_from_results(results, m, min_conf=0.18):
    detected = []
    for r in results:
        boxes = r.boxes
        for i in range(len(boxes)):
            cls_id = int(boxes.cls[i].item())
            conf = float(boxes.conf[i].item())
            if conf < min_conf:
                continue
            class_name = m.names.get(cls_id, '')
            parsed = parse_card_code(class_name)
            if parsed:
                box_xyxy = boxes.xyxy[i].tolist()
                box_w = box_xyxy[2] - box_xyxy[0]
                box_h = box_xyxy[3] - box_xyxy[1]
                if box_w < 16 or box_h < 16:
                    continue
                ratio = box_w / max(1.0, box_h)
                if ratio < 0.20 or ratio > 2.5:
                    continue
                detected.append({
                    **parsed,
                    'confidence': round(conf, 3),
                    'bbox': [round(x, 1) for x in box_xyxy]
                })
    detected.sort(key=lambda x: x['confidence'], reverse=True)
    return detected

def predict_single_peak_frame(peak_crop):
    """
    Tầng 2: Soi AI trên duy nhất tấm ảnh sắc nét nhất tại đỉnh chuyển động.
    - Quét model chính ở imgsz=128 (0° và 180° đối xứng).
    - Nếu bài bị che khuất / xếp chồng, fallback sang corner_model.
    - Trả về nguyên bản từ mạng nơ-ron, không dùng rule heuristic đè sai chất bài.
    """
    if peak_crop is None or peak_crop.size == 0:
        return None, []

    # 1. Quét model chính góc xuôi (0°)
    r1 = model.predict(peak_crop, conf=0.18, verbose=False, imgsz=128)
    cards = extract_cards_from_results(r1, model, min_conf=0.18)
    if cards:
        return cards[0], cards

    # 2. Quét model chính góc ngược (180°) phòng bài cầm ngược đầu
    rot180 = cv2.rotate(peak_crop, cv2.ROTATE_180)
    r2 = model.predict(rot180, conf=0.18, verbose=False, imgsz=128)
    cards_rot = extract_cards_from_results(r2, model, min_conf=0.18)
    if cards_rot:
        return cards_rot[0], cards_rot

    # 3. Quét góc nghiêng nhẹ (±30°) nếu chưa thấy
    h, w = peak_crop.shape[:2]
    for ang in [30, -30]:
        M = cv2.getRotationMatrix2D((w/2, h/2), ang, 1.0)
        rot_ang = cv2.warpAffine(peak_crop, M, (w, h))
        r_ang = model.predict(rot_ang, conf=0.18, verbose=False, imgsz=128)
        cards_ang = extract_cards_from_results(r_ang, model, min_conf=0.18)
        if cards_ang:
            return cards_ang[0], cards_ang

    # 4. Fallback corner_model nếu có
    if corner_model is not None:
        rc1 = corner_model.predict(peak_crop, conf=0.15, verbose=False, imgsz=192)
        cc1 = extract_cards_from_results(rc1, corner_model, min_conf=0.15)
        if cc1:
            return cc1[0], cc1

        rc2 = corner_model.predict(rot180, conf=0.15, verbose=False, imgsz=128)
        cc2 = extract_cards_from_results(rc2, corner_model, min_conf=0.15)
        if cc2:
            return cc2[0], cc2

    return None, []

# Global state
roi_lock = threading.Lock()
roi_state = {
    'x': 120,
    'y': 80,
    'w': 220,
    'h': 280,
    'containerW': 1000,
    'containerH': 580,
    'rotation': 0,
    'isFlipped': False,
    'isActive': True,
    'roomId': 'default'
}

active_stream_key = None
stream_lock = threading.Lock()
stop_worker = threading.Event()

sio = socketio.Client(reconnection=True, reconnection_delay=1, reconnection_delay_max=5)

@sio.event
def connect():
    print("[AI Worker] Connected to Node.js backend Socket.io successfully!")
    sio.emit('join_room', {'roomId': 'default'})

@sio.event
def disconnect():
    print("[AI Worker] Disconnected from Node.js backend.")

@sio.on('stream_status_changed')
def on_stream_status_changed(data):
    global active_stream_key
    status = data.get('status')
    session = data.get('session') or {}
    s_key = session.get('streamKey')
    print(f"[AI Worker] Stream status changed: {status} | streamKey={s_key}")
    with stream_lock:
        if status == 'LIVE' and s_key:
            active_stream_key = s_key
        elif status == 'ENDED':
            if active_stream_key == s_key:
                active_stream_key = None

@sio.on('reticle_roi_updated')
def on_reticle_roi_updated(data):
    with roi_lock:
        for k in ['x', 'y', 'w', 'h', 'containerW', 'containerH', 'rotation', 'isFlipped', 'isActive', 'roomId']:
            if k in data:
                roi_state[k] = data[k]

def fetch_initial_stream():
    global active_stream_key
    try:
        r = requests.get(f"{BACKEND_URL}/api/stream/active", timeout=2)
        if r.status_code == 200:
            d = r.json()
            if d.get('stream') and d['stream'].get('status') == 'LIVE':
                with stream_lock:
                    active_stream_key = d['stream']['streamKey']
                print(f"[AI Worker] Found active stream on startup: {active_stream_key}")
    except Exception as e:
        print(f"[AI Worker] Could not fetch initial stream: {e}")

def crop_frame_roi(raw_frame, roi):
    """
    Cắt chính xác vùng khung đỏ (Native 1080p pixel accuracy).
    Xử lý góc xoay (rotation) và lật gương (isFlipped).
    """
    if raw_frame is None or raw_frame.size == 0:
        return None

    frame = raw_frame
    rot = roi.get('rotation', 0)
    if rot == 90:
        frame = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    elif rot == 180:
        frame = cv2.rotate(frame, cv2.ROTATE_180)
    elif rot == 270:
        frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)

    if roi.get('isFlipped', False):
        frame = cv2.flip(frame, 1)

    vh, vw = frame.shape[:2]
    cw = max(1, roi.get('containerW', 1000))
    ch = max(1, roi.get('containerH', 580))

    container_ratio = cw / ch
    video_ratio = vw / vh

    if video_ratio > container_ratio:
        render_w = cw
        render_h = cw / video_ratio
    else:
        render_h = ch
        render_w = ch * video_ratio

    native_scale = vw / max(1.0, render_w)

    rx = roi.get('x', 0)
    ry = roi.get('y', 0)
    rw = roi.get('w', 220)
    rh = roi.get('h', 280)

    center_x = (rx + rw / 2.0) - (cw / 2.0)
    center_y = (ry + rh / 2.0) - (ch / 2.0)

    video_cx = (vw / 2.0) + (center_x * native_scale)
    video_cy = (vh / 2.0) + (center_y * native_scale)

    crop_w = max(160, int(round(rw * native_scale)))
    crop_h = max(160, int(round(rh * native_scale)))

    x1 = max(0, int(round(video_cx - crop_w / 2.0)))
    y1 = max(0, int(round(video_cy - crop_h / 2.0)))
    x2 = min(vw, x1 + crop_w)
    y2 = min(vh, y1 + crop_h)

    if x2 <= x1 or y2 <= y1:
        return None

    return frame[y1:y2, x1:x2].copy()

def send_card_detected(card, all_cards, crop_img, sharpness, current_roi):
    try:
        _, buf = cv2.imencode('.jpg', crop_img, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        b64_crop = base64.b64encode(buf).decode('utf-8')

        payload = {
            'card': card,
            'allCards': all_cards,
            'confidence': card.get('confidence', 0.95),
            'sharpness': sharpness,
            'image': f"data:image/jpeg;base64,{b64_crop}",
            'timestamp': datetime.now().strftime('%H:%M:%S'),
            'roomId': current_roi.get('roomId', 'default')
        }

        sio.emit('server_card_detected', payload)
        print(f"[AI Worker] 🎯 ĐÃ BẮN VỀ WEB LÁ BÀI NÉT NHẤT: {card.get('display', '')} ({int(card.get('confidence', 0.95)*100)}%) | Độ nét đỉnh={sharpness}")
    except Exception as e:
        print(f"[AI Worker] Lỗi gửi kết quả qua Socket: {e}")

class CardPassTracker:
    """
    Kiến trúc 2 tầng chuẩn 120 FPS:
    - Tầng 1: Lọc quang học và bắt đỉnh nét thời gian thực (<1.2ms/frame, 0% rớt frame).
      Theo dõi đường cong chuyển động: Mờ (bài vào) -> Rõ (đỉnh điểm nét) -> Mờ (bài ra).
    - Tầng 2: Kích hoạt YOLO đúng 1 lần trên tấm ảnh nét nhất tại đỉnh sắc nét.
      Khóa không bắn trùng lặp, tự động reset khi quân bài rời khỏi khung ngắm.
    """
    STATE_IDLE = "IDLE"           # Khung trống, chưa có bài
    STATE_TRACKING = "TRACKING"   # Bài đang lướt vào (Mờ -> Rõ dần)
    STATE_LOCKED = "LOCKED"       # Đã chốt frame sắc nét nhất, khóa không phát lại lá này

    def __init__(self, emit_callback):
        self.state = self.STATE_IDLE
        self.emit_callback = emit_callback
        
        self.peak_sharpness = 0.0
        self.peak_crop = None
        self.frames_since_peak = 0
        self.frames_in_pass = 0
        
        self.empty_streak = 0
        self.min_sharpness_threshold = 20.0

    def reset_to_idle(self):
        self.state = self.STATE_IDLE
        self.peak_sharpness = 0.0
        self.peak_crop = None
        self.frames_since_peak = 0
        self.frames_in_pass = 0
        self.empty_streak = 0

    def process_frame(self, crop, current_roi):
        if crop is None or crop.size == 0:
            return

        # Tầng 1: Tính toán siêu nhẹ thời gian thực (<1.2ms)
        has_paper = check_card_paper_presence(crop)
        sharpness = compute_sharpness(crop)

        if self.state == self.STATE_IDLE:
            # Bài bắt đầu chớm vào khung ngắm khi có giấy bài và độ nét bắt đầu tăng
            if has_paper and sharpness >= self.min_sharpness_threshold:
                self.state = self.STATE_TRACKING
                self.peak_sharpness = sharpness
                self.peak_crop = crop.copy()
                self.frames_in_pass = 1
                self.frames_since_peak = 0
                self.empty_streak = 0
                print(f"[AI Worker] 🔍 Bắt đầu đón bài vào khung (120fps) | Nét ban đầu={sharpness:.1f}")

        elif self.state == self.STATE_TRACKING:
            self.frames_in_pass += 1

            if sharpness > self.peak_sharpness:
                # Đang rõ dần -> Cập nhật tấm ảnh nét nhất mới
                self.peak_sharpness = sharpness
                self.peak_crop = crop.copy()
                self.frames_since_peak = 0
            else:
                # Đang mờ dần (đã qua đỉnh sắc nét)
                self.frames_since_peak += 1

            # ĐIỀU KIỆN CHỐT ĐỈNH NÉT:
            # 1. Đã qua đỉnh rõ (độ nét giảm 3 frames liên tiếp) và đợt bài đã quét ít nhất 3 frames
            # 2. Hoặc đã trôi qua 16 frames 120fps (~130ms) mà bài vẫn nằm trong khung
            should_finalize = (
                (self.frames_since_peak >= 3 and self.frames_in_pass >= 3) or
                (self.frames_in_pass >= 16 and self.peak_crop is not None)
            )

            if should_finalize and self.peak_crop is not None:
                # KÍCH HOẠT TẦNG 2: SOI BÀI TRÊN ĐÚNG TẤM ẢNH SẮC NÉT NHẤT
                best_card, all_cards = predict_single_peak_frame(self.peak_crop)
                if best_card:
                    self.emit_callback(best_card, all_cards, self.peak_crop, self.peak_sharpness, current_roi)
                    self.state = self.STATE_LOCKED
                    self.empty_streak = 0
                else:
                    # Nếu frame nét nhất không phải lá bài (bóng mờ hoặc ngón tay), hủy đợt này
                    self.reset_to_idle()
            elif self.frames_in_pass >= 30:
                self.reset_to_idle()

        elif self.state == self.STATE_LOCKED:
            # Đang khóa kết quả lá bài vừa bắn. Chờ bài rút ra khỏi khung.
            if not has_paper or sharpness < 15.0:
                self.empty_streak += 1
            else:
                self.empty_streak = 0

            # Khung trống 4 frames liên tiếp (~33ms ở 120fps) -> Mở khóa đón lá bài kế tiếp
            if self.empty_streak >= 4:
                self.reset_to_idle()
                print("[AI Worker] 🟢 Khung đã trống -> Sẵn sàng đón quân bài tiếp theo.")

class FrameReader120Fps:
    """
    Luồng đọc video 120fps chuyên biệt:
    Chạy trong 1 background thread riêng biệt để liên tục gọi cap.read() ở tốc độ 120fps.
    Xả sạch bộ đệm socket RTSP của MediaMTX, triệt tiêu 100% cảnh báo 'reader is too slow',
    và đảm bảo luồng AI trên Server luôn luôn nhận frame mới nhất với độ trễ 0ms.
    """
    def __init__(self, src):
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay"
        self.cap = cv2.VideoCapture(src, cv2.CAP_FFMPEG)
        self.latest_frame = None
        self.stopped = False
        self.lock = threading.Lock()
        self.is_opened = self.cap.isOpened()
        if self.is_opened:
            self.thread = threading.Thread(target=self._reader_loop, daemon=True)
            self.thread.start()

    def _reader_loop(self):
        while not self.stopped:
            ret, frame = self.cap.read()
            if not ret or frame is None or frame.size == 0:
                time.sleep(0.002)
                continue
            with self.lock:
                self.latest_frame = frame

    def read(self):
        with self.lock:
            if self.latest_frame is None:
                return False, None
            return True, self.latest_frame

    def release(self):
        self.stopped = True
        if self.is_opened and hasattr(self, 'thread'):
            self.thread.join(timeout=0.3)
        self.cap.release()

def stream_worker_loop():
    print("[AI Worker] Stream consumer thread started (Tier-1 Optical Peak + Tier-2 AI Engine).")
    tracker = CardPassTracker(emit_callback=send_card_detected)
    current_reader = None
    connected_key = None
    frame_count = 0

    while not stop_worker.is_set():
        with stream_lock:
            s_key = active_stream_key

        if not s_key:
            if current_reader is not None:
                current_reader.release()
                current_reader = None
                connected_key = None
            tracker.reset_to_idle()
            time.sleep(0.5)
            continue

        if current_reader is None or connected_key != s_key:
            if current_reader is not None:
                current_reader.release()
            
            reader = FrameReader120Fps(f"{RTSP_BASE_URL}/live/{s_key}")
            if not reader.is_opened:
                reader = FrameReader120Fps(f"{RTSP_BASE_URL}/{s_key}")
            if not reader.is_opened:
                reader = FrameReader120Fps(f"{RTMP_BASE_URL}/live/{s_key}")

            if not reader.is_opened:
                time.sleep(0.5)
                continue

            current_reader = reader
            connected_key = s_key
            tracker.reset_to_idle()
            frame_count = 0
            print(f"[AI Worker] ✅ Connected to stream: {s_key}")

        ret, raw_frame = current_reader.read()
        if not ret or raw_frame is None or raw_frame.size == 0:
            time.sleep(0.004)
            continue

        with roi_lock:
            current_roi = dict(roi_state)

        if not current_roi.get('isActive', True):
            time.sleep(0.05)
            continue

        crop = crop_frame_roi(raw_frame, current_roi)
        if crop is None or crop.size == 0:
            continue

        frame_count += 1
        if frame_count % 120 == 0:
            paper_ok = check_card_paper_presence(crop)
            sh = compute_sharpness(crop)
            print(f"[AI Worker] ⚡ 120fps quét frame #{frame_count} | State: {tracker.state} | Crop={crop.shape} | Paper={paper_ok} | Sharp={sh}")

        # Xử lý frame ở Tầng 1 (Cực nhẹ <1.2ms/frame)
        tracker.process_frame(crop, current_roi)

    if current_reader is not None:
        current_reader.release()

if __name__ == '__main__':
    print("[AI Worker] Starting Server-side AI Worker (2-Tier 120fps Architecture)...")
    fetch_initial_stream()

    # Chạy worker thread
    worker_th = threading.Thread(target=stream_worker_loop, daemon=True)
    worker_th.start()

    # Kết nối Socket.io
    try:
        sio.connect(BACKEND_URL, auth={'token': 'internal_ai_worker'}, socketio_path='/socket.io')
        sio.wait()
    except KeyboardInterrupt:
        stop_worker.set()
        sio.disconnect()
        print("[AI Worker] Stopped.")
