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
    suit_info = SUIT_MAP.get(suit_char, {'suit': suit_char, 'symbol': suit_char, 'color': 'black'})
    return {
        'code': c,
        'rank': rank_str,
        'suit': suit_info['suit'],
        'symbol': suit_info['symbol'],
        'color': suit_info['color'],
        'display': f"{rank_str}{suit_info['symbol']}",
        'fullName': f"{rank_str} {suit_info['suit']}"
    }

def compute_sharpness(cv_image):
    try:
        if len(cv_image.shape) == 3:
            gray = cv2.cvtColor(cv_image, cv2.COLOR_BGR2GRAY)
        else:
            gray = cv_image
        return round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 1)
    except Exception:
        return 0.0

def verify_and_disambiguate_card(detected_cards, cv_img):
    if not detected_cards or cv_img is None:
        return detected_cards
    h, w = cv_img.shape[:2]
    for card in detected_cards:
        code = card.get('code', '')
        rank = card.get('rank', '')
        suit = card.get('suit', '')
        
        corner_roi = cv_img[0:max(30, int(h * 0.45)), 0:max(30, int(w * 0.45))]
        if corner_roi.size > 0:
            hsv = cv2.cvtColor(corner_roi, cv2.COLOR_BGR2HSV)
            mask1 = cv2.inRange(hsv, np.array([0, 50, 50]), np.array([12, 255, 255]))
            mask2 = cv2.inRange(hsv, np.array([168, 50, 50]), np.array([180, 255, 255]))
            red_pixels = cv2.countNonZero(mask1 | mask2)
            
            if suit in ['Cơ', 'Rô'] and red_pixels < 15:
                new_suit_char = 'S' if suit == 'Cơ' else 'C'
                parsed = parse_card_code(rank + new_suit_char)
                if parsed:
                    card.update(parsed)
            elif suit in ['Bích', 'Tép'] and red_pixels > 50:
                new_suit_char = 'H' if suit == 'Bích' else 'D'
                parsed = parse_card_code(rank + new_suit_char)
                if parsed:
                    card.update(parsed)

        if rank in ['8', '10'] and corner_roi.size > 0:
            gray_roi = cv2.cvtColor(corner_roi, cv2.COLOR_BGR2GRAY)
            _, bin_roi = cv2.threshold(gray_roi, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
            contours, hierarchy = cv2.findContours(bin_roi, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
            num_holes = 0
            char_w_h_ratio = 0.5
            if hierarchy is not None and len(contours) > 0:
                for h_info in hierarchy[0]:
                    if h_info[3] != -1:
                        num_holes += 1
                valid_contours = [c for c in contours if cv2.contourArea(c) > 20]
                if valid_contours:
                    _, _, w_c, h_c = cv2.boundingRect(max(valid_contours, key=cv2.contourArea))
                    char_w_h_ratio = w_c / max(1, h_c)
            
            if rank == '10' and (num_holes >= 2 or char_w_h_ratio < 0.62):
                parsed = parse_card_code('8' + card['code'][-1])
                if parsed:
                    card.update(parsed)
            elif rank == '8' and (char_w_h_ratio > 0.78 and num_holes <= 1):
                parsed = parse_card_code('10' + card['code'][-1])
                if parsed:
                    card.update(parsed)

    return detected_cards

def extract_cards_from_results(results, m):
    detected = []
    for r in results:
        boxes = r.boxes
        for i in range(len(boxes)):
            cls_id = int(boxes.cls[i].item())
            conf = float(boxes.conf[i].item())
            class_name = m.names.get(cls_id, '')
            parsed = parse_card_code(class_name)
            if parsed:
                box_xyxy = boxes.xyxy[i].tolist()
                box_w = box_xyxy[2] - box_xyxy[0]
                box_h = box_xyxy[3] - box_xyxy[1]
                if box_w < 18 or box_h < 18:
                    continue
                detected.append({
                    **parsed,
                    'confidence': round(conf, 3),
                    'bbox': [round(x, 1) for x in box_xyxy]
                })
    detected.sort(key=lambda x: x['confidence'], reverse=True)
    return detected

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

    # 1. Xoay frame nếu người dùng chỉnh rotation
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

    # Tọa độ tâm khung ngắm so với tâm container
    center_x = (rx + rw / 2.0) - (cw / 2.0)
    center_y = (ry + rh / 2.0) - (ch / 2.0)

    # Tâm khung ngắm trên video gốc
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
        # Nén ảnh crop 1080p sắc nét nhất sang JPEG gửi về Web để hiện lên Khay Soi Quân Bài
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
    Theo dõi đường cong độ nét thực tế: Mờ (bài vào) -> Rõ (giữa khung) -> Mờ (bài ra).
    Tự động bắt đúng duy nhất 1 frame sắc nét nhất ở đỉnh và khóa không bao giờ nhận diện trùng lặp.
    Khi bài rời khỏi khung (khung trống), tự động reset để sẵn sàng đón con tiếp theo.
    """
    STATE_IDLE = "IDLE"           # Khung trống, chưa có bài
    STATE_TRACKING = "TRACKING"   # Bài đang lướt vào (Mờ -> Rõ dần)
    STATE_LOCKED = "LOCKED"       # Đã chốt frame sắc nét nhất, khóa không phát lại lá này

    def __init__(self, emit_callback):
        self.state = self.STATE_IDLE
        self.emit_callback = emit_callback
        
        # Candidate peak storage
        self.peak_sharpness = 0.0
        self.peak_crop = None
        self.peak_card = None
        self.peak_all_cards = []
        self.frames_since_peak = 0
        self.total_frames_in_pass = 0
        
        # Exit detection
        self.empty_streak = 0
        self.min_sharpness_threshold = 40.0
        self.idle_frame_counter = 0

    def reset_to_idle(self):
        self.state = self.STATE_IDLE
        self.peak_sharpness = 0.0
        self.peak_crop = None
        self.peak_card = None
        self.peak_all_cards = []
        self.frames_since_peak = 0
        self.total_frames_in_pass = 0
        self.empty_streak = 0

    def process_frame(self, crop, current_roi):
        if crop is None or crop.size == 0:
            return

        sharpness = compute_sharpness(crop)

        if self.state == self.STATE_IDLE:
            self.idle_frame_counter += 1
            # Quét nhận diện bài định kỳ mỗi 2 frame (~16ms) để tiết kiệm CPU
            if self.idle_frame_counter % 2 == 0:
                results = model.predict(crop, conf=0.25, verbose=False, imgsz=160)
                cards = verify_and_disambiguate_card(extract_cards_from_results(results, model), crop)
                if not cards and corner_model is not None:
                    res_c = corner_model.predict(crop, conf=0.20, verbose=False, imgsz=160)
                    cards = extract_cards_from_results(res_c, corner_model)

                if cards:
                    # BÀI BẮT ĐẦU VÀO KHUNG (MỜ -> RÕ DẦN)
                    self.state = self.STATE_TRACKING
                    self.peak_sharpness = sharpness
                    self.peak_crop = crop.copy()
                    self.peak_card = cards[0]
                    self.peak_all_cards = cards
                    self.frames_since_peak = 0
                    self.total_frames_in_pass = 1
                    self.empty_streak = 0

        elif self.state == self.STATE_TRACKING:
            self.total_frames_in_pass += 1

            # So sánh độ nét: nếu frame này nét hơn -> cập nhật ĐỈNH RÕ
            if sharpness > self.peak_sharpness:
                self.peak_sharpness = sharpness
                self.peak_crop = crop.copy()
                self.frames_since_peak = 0

                # Chạy lại YOLO trên frame mới nét hơn này để cập nhật nhãn chính xác nhất
                results = model.predict(crop, conf=0.25, verbose=False, imgsz=160)
                cards = verify_and_disambiguate_card(extract_cards_from_results(results, model), crop)
                if cards:
                    self.peak_card = cards[0]
                    self.peak_all_cards = cards
            else:
                self.frames_since_peak += 1

            # ĐIỀU KIỆN CHỐT: Đã qua đỉnh rõ và bắt đầu mờ đi (MỜ -> RÕ -> MỜ)
            # Hoặc đã thu thập đủ 18 frames (>150ms) có đỉnh nét
            should_finalize = (
                (self.frames_since_peak >= 3 and self.peak_sharpness >= self.min_sharpness_threshold) or
                (self.total_frames_in_pass >= 18 and self.peak_sharpness >= self.min_sharpness_threshold)
            )

            if should_finalize and self.peak_card is not None and self.peak_crop is not None:
                # CHỐT TẤM ẢNH ĐẸP NHẤT TẠI ĐỈNH SẮC NÉT
                self.emit_callback(self.peak_card, self.peak_all_cards, self.peak_crop, self.peak_sharpness, current_roi)
                self.state = self.STATE_LOCKED
                self.empty_streak = 0
            elif self.total_frames_in_pass >= 25 and self.peak_card is None:
                self.reset_to_idle()

        elif self.state == self.STATE_LOCKED:
            # Lá bài đã được chốt xong. Tuyệt đối không phát lại lá bài này.
            # Kiểm tra xem bài đã rời khỏi khung chưa
            self.idle_frame_counter += 1
            if self.idle_frame_counter % 2 == 0:
                results = model.predict(crop, conf=0.20, verbose=False, imgsz=160)
                cards = extract_cards_from_results(results, model)
                if not cards:
                    self.empty_streak += 1
                    if self.empty_streak >= 4:  # 4 frame trống liên tiếp (~33ms) -> bài đã ra hẳn
                        self.reset_to_idle()
                        print("[AI Worker] 🟢 Khung đã trống -> Sẵn sàng đón quân bài tiếp theo.")
                else:
                    self.empty_streak = 0

def stream_worker_loop():
    print("[AI Worker] Stream consumer thread started.")
    tracker = CardPassTracker(emit_callback=send_card_detected)
    current_cap = None
    connected_key = None

    while not stop_worker.is_set():
        with stream_lock:
            s_key = active_stream_key

        if not s_key:
            if current_cap is not None:
                current_cap.release()
                current_cap = None
                connected_key = None
            tracker.reset_to_idle()
            time.sleep(0.5)
            continue

        if current_cap is None or connected_key != s_key:
            if current_cap is not None:
                current_cap.release()
            
            # Thử kết nối RTSP từ MediaMTX (độ trễ <10ms trên localhost)
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay"
            cap = cv2.VideoCapture(f"{RTSP_BASE_URL}/live/{s_key}", cv2.CAP_FFMPEG)
            if not cap.isOpened():
                cap = cv2.VideoCapture(f"{RTSP_BASE_URL}/{s_key}", cv2.CAP_FFMPEG)
            if not cap.isOpened():
                cap = cv2.VideoCapture(f"{RTMP_BASE_URL}/live/{s_key}", cv2.CAP_FFMPEG)

            if not cap.isOpened():
                time.sleep(0.5)
                continue

            current_cap = cap
            connected_key = s_key
            tracker.reset_to_idle()
            print(f"[AI Worker] ✅ Connected to stream: {s_key}")

        ret, raw_frame = current_cap.read()
        if not ret or raw_frame is None or raw_frame.size == 0:
            time.sleep(0.005)
            continue

        with roi_lock:
            current_roi = dict(roi_state)

        if not current_roi.get('isActive', True):
            time.sleep(0.05)
            continue

        crop = crop_frame_roi(raw_frame, current_roi)
        if crop is None or crop.size == 0:
            continue

        # Đưa frame vào CardPassTracker xử lý đường cong mờ -> rõ -> mờ
        tracker.process_frame(crop, current_roi)

    if current_cap is not None:
        current_cap.release()

if __name__ == '__main__':
    print("[AI Worker] Starting Server-side AI Worker...")
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
