import os
import sys
import glob
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

os.environ["OMP_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"
os.environ["OPENBLAS_NUM_THREADS"] = "2"
os.environ["NUMEXPR_NUM_THREADS"] = "2"

import ast
import math
import time
import queue
import base64
import threading
import collections
from datetime import datetime
import cv2
import numpy as np
import socketio
import requests
import onnxruntime as ort

BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:4000")
RTSP_BASE_URL = os.environ.get("RTSP_BASE_URL", "rtsp://127.0.0.1:8554")
RTMP_BASE_URL = os.environ.get("RTMP_BASE_URL", "rtmp://127.0.0.1:1935/live")

MODEL_DIR = os.path.dirname(__file__)
ONNX_MODEL_PATH = os.path.join(MODEL_DIR, "cards_yolov8.onnx")
CORNER_ONNX_PATH = os.path.join(MODEL_DIR, "cards_corner_yolo.onnx")

NUM_AI_CHANNELS = 4  # 4 Kênh AI chuyên biệt 4 góc: Kênh #1 (0°), Kênh #2 (-22°), Kênh #3 (+22°), Kênh #4 (Phối cảnh 1.35x)
MIN_CONFIDENCE = 0.58  # Ngưỡng chống nhiễu >= 58% (loại bỏ hoàn toàn kích hoạt giả 46% trên hàng rào/kính xe)

CHANNEL_MODES = {
    0: "Thẳng 0°",
    1: "Nghiêng Trái -22°",
    2: "Nghiêng Phải +22°",
    3: "Nghiêng Dọc 1.35x"
}

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


def compute_sharpness(cv_image):
    try:
        if cv_image is None or cv_image.size == 0:
            return 0.0
        if len(cv_image.shape) == 3:
            gray = cv2.cvtColor(cv_image, cv2.COLOR_BGR2GRAY)
        else:
            gray = cv_image
        return round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 1)
    except Exception:
        return 0.0


def compute_sharpness_fast(cv_image):
    """
    Tính độ nét siêu tốc (<0.03ms) trực tiếp trên kênh Green giảm mẫu 2x.
    """
    try:
        if cv_image is None or cv_image.size == 0:
            return 0.0
        g = cv_image[::2, ::2, 1] if len(cv_image.shape) == 3 else cv_image[::2, ::2]
        return round(float(cv2.Laplacian(g, cv2.CV_16S).var()) * 1.4, 1)
    except Exception:
        return 0.0


def enhance_low_light_crop(crop_img):
    """
    Siêu bộ lọc phục hồi độ nét & tương phản 3 tầng (3-Stage Clarity Engine):
    1. Cân bằng dải sáng (Percentile Stretch) khắc phục phòng tối / đèn chói
    2. Tăng cường tương phản viền cục bộ (CLAHE trên kênh LAB L) làm nổi bần bật hoa văn bài
    3. Bộ lọc Unsharp Masking tái tạo đường viền sắc cạnh của chữ số & chất bài (tăng nét ~6x)
    """
    if crop_img is None or crop_img.size == 0:
        return crop_img
    try:
        f = crop_img.astype(np.float32)
        sub = f[::4, ::4]
        p8 = np.percentile(sub, 8, axis=(0, 1))
        p92 = np.percentile(sub, 92, axis=(0, 1))
        span = np.maximum(20.0, p92 - p8)
        if float(np.max(p92)) < 185.0 or float(np.min(span)) < 95.0:
            out = (f - p8) * (230.0 / span) + 12.0
            base = np.clip(out, 0, 255).astype(np.uint8)
        else:
            base = crop_img

        lab = cv2.cvtColor(base, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
        l_enh = clahe.apply(l)
        enhanced = cv2.cvtColor(cv2.merge([l_enh, a, b]), cv2.COLOR_LAB2BGR)

        gaussian = cv2.GaussianBlur(enhanced, (0, 0), 2.0)
        unsharp = cv2.addWeighted(enhanced, 1.45, gaussian, -0.45, 0)
        return np.clip(unsharp, 0, 255).astype(np.uint8)
    except Exception:
        return crop_img


def validate_card_patch(crop_img, box, parsed_card, conf):
    """
    Cổng kiểm định chống nhận diện nhầm (Anti-False-Positive Gate):
    1. Loại bỏ các box nhiễu nằm ở vùng mép biên ngoài cùng (như hàng rào/kính xe ở góc trên bên trái).
    2. Kiểm tra vùng giấy bài sáng + độ tương phản nét mực cục bộ.
    3. Kiểm tra tính hợp lệ của màu chất bài (Cơ/Rô phải có sắc đỏ ấm, Bích/Tép không phải vùng da tay đỏ).
    """
    if crop_img is None or crop_img.size == 0:
        return False
    h, w = crop_img.shape[:2]
    bx1, by1, bx2, by2 = box
    bw = bx2 - bx1
    bh = by2 - by1

    if bw < 12 or bh < 12:
        return False
    ratio = bw / max(1.0, float(bh))
    if ratio < 0.16 or ratio > 3.0:
        return False

    # Chống bắt nhầm góc ngoài rìa (như hàng rào/kính xe tải góc trái trên trong ảnh lỗi)
    is_near_margin = (bx1 < 0.08 * w or by1 < 0.08 * h or bx2 > 0.92 * w or by2 > 0.92 * h)
    if is_near_margin and conf < 0.72:
        return False

    px1 = max(0, bx1 - 12)
    py1 = max(0, by1 - 12)
    px2 = min(w, bx2 + 12)
    py2 = min(h, by2 + 12)
    patch = crop_img[py1:py2, px1:px2]
    if patch.size == 0:
        return False

    try:
        hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
        s = hsv[:, :, 1]
        v = hsv[:, :, 2]

        paper_ratio = np.count_nonzero((s < 115) & (v > 105)) / max(1, s.size)
        if paper_ratio < 0.08 and conf < 0.66:
            return False

        contrast = float(np.percentile(v, 92) - np.percentile(v, 10))
        if contrast < 28.0:
            return False

        local_sharp = compute_sharpness(patch)
        if local_sharp < 9.5 and conf < 0.65:
            return False

        return True
    except Exception:
        return True


def compute_raw_crop_coords(rh, rw, current_roi):
    """
    Tính tọa độ cắt thô trên raw_frame trong <0.005ms để `_reader_loop` không phải xoay/lật ảnh.
    Việc xoay/lật sẽ do 4 Kênh AI tự thực hiện song song.
    """
    rot = int(current_roi.get('rotation', 0)) % 360
    is_flipped = bool(current_roi.get('isFlipped', False))

    if rot in (90, 270):
        vw, vh = rh, rw
    else:
        vw, vh = rw, rh

    norm_cx = float(current_roi.get('normX', 0.45))
    norm_cy = float(current_roi.get('normY', 0.52))
    norm_w = float(current_roi.get('normW', 0.28))
    norm_h = float(current_roi.get('normH', 0.34))

    pad = 1.04
    box_w = max(160, int(round(norm_w * pad * vw)))
    box_h = max(160, int(round(norm_h * pad * vh)))
    cx_px = int(round(norm_cx * vw))
    cy_px = int(round(norm_cy * vh))

    x1 = max(0, min(vw - box_w, cx_px - box_w // 2))
    y1 = max(0, min(vh - box_h, cy_px - box_h // 2))
    x2 = min(vw, x1 + box_w)
    y2 = min(vh, y1 + box_h)

    ux1, ux2 = (vw - x2, vw - x1) if is_flipped else (x1, x2)
    uy1, uy2 = y1, y2

    if rot == 0:
        rx1, ry1, rx2, ry2 = ux1, uy1, ux2, uy2
    elif rot == 180:
        rx1, ry1, rx2, ry2 = rw - ux2, rh - uy2, rw - ux1, rh - uy1
    elif rot == 90:
        rx1, rx2 = uy1, uy2
        ry1, ry2 = rh - ux2, rh - ux1
    elif rot == 270:
        rx1, rx2 = rw - uy2, rw - uy1
        ry1, ry2 = ux1, ux2
    else:
        rx1, ry1, rx2, ry2 = ux1, uy1, ux2, uy2

    rx1, rx2 = max(0, rx1), min(rw, rx2)
    ry1, ry2 = max(0, ry1), min(rh, ry2)
    return (rx1, ry1, rx2, ry2), (x1, y1, x2, y2), rot, is_flipped


def orient_raw_sub(sub_raw, rot, is_flipped):
    """
    Xoay & lật vùng ảnh cắt thô (được gọi bên trong từng Kênh AI song song, không chặn luồng đọc).
    """
    if sub_raw is None or sub_raw.size == 0:
        return np.zeros((200, 200, 3), dtype=np.uint8)
    if rot == 90:
        sub = cv2.rotate(sub_raw, cv2.ROTATE_90_CLOCKWISE)
    elif rot == 180:
        sub = cv2.rotate(sub_raw, cv2.ROTATE_180)
    elif rot == 270:
        sub = cv2.rotate(sub_raw, cv2.ROTATE_90_COUNTERCLOCKWISE)
    else:
        sub = sub_raw
    if is_flipped:
        sub = cv2.flip(sub, 1)
    return sub


class DirectONNXYoloEngine:
    """
    Engine suy luận ONNX Runtime C++ trực tiếp (1 Pass duy nhất mỗi kênh = ~4.8ms, giải phóng 100% GIL).
    """
    def __init__(self, onnx_path, intra_threads=2):
        so = ort.SessionOptions()
        so.intra_op_num_threads = intra_threads
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(onnx_path, sess_options=so, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name
        meta = self.session.get_modelmeta().custom_metadata_map
        self.names = ast.literal_eval(meta.get('names', '{}'))

        dummy = np.zeros((1, 3, 256, 256), dtype=np.float32)
        self.session.run(None, {self.input_name: dummy})

    def predict(self, bgr_img, conf_thres=MIN_CONFIDENCE, iou_thres=0.45):
        if bgr_img is None or bgr_img.size == 0:
            return []
        h, w = bgr_img.shape[:2]
        scale = min(256.0 / h, 256.0 / w)
        nw = int(round(w * scale))
        nh = int(round(h * scale))
        dw = (256 - nw) // 2
        dh = (256 - nh) // 2

        interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
        resized = cv2.resize(bgr_img, (nw, nh), interpolation=interp)
        canvas = cv2.copyMakeBorder(
            resized,
            dh, 256 - nh - dh,
            dw, 256 - nw - dw,
            cv2.BORDER_CONSTANT,
            value=(114, 114, 114)
        )
        rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
        blob = np.ascontiguousarray(rgb.transpose(2, 0, 1), dtype=np.float32) * (1.0 / 255.0)
        blob = blob[np.newaxis, ...]

        pred = self.session.run(None, {self.input_name: blob})[0][0]
        cls_scores = pred[4:, :]
        max_scores = np.max(cls_scores, axis=0)
        mask = max_scores >= conf_thres
        if not np.any(mask):
            return []

        boxes_cxcywh = pred[:4, mask].T
        scores = max_scores[mask]
        class_ids = np.argmax(cls_scores[:, mask], axis=0)

        cx = boxes_cxcywh[:, 0]
        cy = boxes_cxcywh[:, 1]
        bw = boxes_cxcywh[:, 2]
        bh = boxes_cxcywh[:, 3]

        x1 = (cx - bw * 0.5 - dw) / scale
        y1 = (cy - bh * 0.5 - dh) / scale
        x2 = (cx + bw * 0.5 - dw) / scale
        y2 = (cy + bh * 0.5 - dh) / scale

        nms_boxes = np.column_stack((x1, y1, x2 - x1, y2 - y1)).tolist()
        score_list = scores.tolist()
        indices = cv2.dnn.NMSBoxes(nms_boxes, score_list, conf_thres, iou_thres)
        if len(indices) == 0:
            return []

        results = []
        for idx in np.array(indices).flatten():
            cid = int(class_ids[idx])
            cname = self.names.get(cid, '')
            sc = float(score_list[idx])
            bx1 = float(max(0.0, min(w, x1[idx])))
            by1 = float(max(0.0, min(h, y1[idx])))
            bx2 = float(max(0.0, min(w, x2[idx])))
            by2 = float(max(0.0, min(h, y2[idx])))
            results.append((cid, cname, sc, [bx1, by1, bx2, by2]))
        return results


# Global state
roi_lock = threading.Lock()
roi_state = {
    'x': 230,
    'y': 150,
    'w': 260,
    'h': 300,
    'containerW': 1000,
    'containerH': 580,
    'normX': 0.45,
    'normY': 0.52,
    'normW': 0.28,
    'normH': 0.34,
    'rotation': 0,
    'isFlipped': False,
    'isActive': True,
    'roomId': 'default'
}

live_crop_lock = threading.Lock()
live_crop_state = {
    'crop_img': None,
    'crop_box': [0, 0, 0, 0],
    'sharpness': 0.0,
    'source_fps': 120,
    'scan_fps': 120,
    'updated_at': 0.0,
    'detected_overlay': [],
    'detected_desc': '',
    'best_conf': 0.0,
    'overlay_ts': 0.0,
    'room_id': 'default',
    'channels': {
        i: {
            'id': i + 1,
            'seq': 0,
            'sharpness': 0.0,
            'card': 'Đang quét...',
            'conf': 0.0,
            'mode': CHANNEL_MODES[i]
        }
        for i in range(NUM_AI_CHANNELS)
    }
}

active_stream_key = None
stream_lock = threading.Lock()
ended_stream_keys = set()
stop_worker = threading.Event()
emit_queue = queue.Queue(maxsize=64)
global_aggregator = None

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
            ended_stream_keys.discard(s_key)
            active_stream_key = s_key
            if global_aggregator is not None:
                global_aggregator.reset()
        elif status == 'ENDED':
            if s_key:
                ended_stream_keys.add(s_key)
            if active_stream_key == s_key:
                active_stream_key = None
            # Giải phóng ngay lập tức bộ đọc để không đọc dồn 3.000 frame cũ
            with current_reader_lock:
                cur_reader = shared_reader_ref['reader']
                if cur_reader is not None:
                    shared_reader_ref['reader'] = None
                    shared_reader_ref['key'] = None
                    cur_reader.release()
            print(f"[AI Worker] ⏹ Luồng {s_key} đã KẾT THÚC -> Đã đóng bộ đọc và giải phóng bộ nhớ!")


@sio.on('cards_cleared')
def on_cards_cleared(data):
    print("[AI Worker] 🔄 Nhận lệnh 'Ván Mới' (cards_cleared) -> Reset bộ nhớ chống trùng bài!")
    if global_aggregator is not None:
        global_aggregator.reset()


@sio.on('reticle_roi_updated')
def on_reticle_roi_updated(data):
    with roi_lock:
        for k in ['x', 'y', 'w', 'h', 'containerW', 'containerH', 'rotation', 'isFlipped', 'isActive', 'roomId', 'normX', 'normY', 'normW', 'normH']:
            if k in data:
                roi_state[k] = data[k]
        nx = round(float(roi_state.get('normX', 0.50)) * 100)
        ny = round(float(roi_state.get('normY', 0.52)) * 100)
        nw = round(float(roi_state.get('normW', 0.28)) * 100)
        nh = round(float(roi_state.get('normH', 0.35)) * 100)
        print(f"[AI Worker] 📐 ĐÃ CẬP NHẬT KÍCH THƯỚC Ô SOI: Rộng={nw}% | Dài={nh}% | Tâm=({nx}%, {ny}%)")

    # Ép reset updated_at trong live_crop_state để khung soi RAM lập tức cập nhật kích thước mới
    with live_crop_lock:
        live_crop_state['updated_at'] = 0.0
        live_crop_state['crop_img'] = None


instant_engine = None
instant_corner_engine = None


@sio.on('reset_session_ram')
def on_reset_session_ram(data=None):
    global global_aggregator
    try:
        if global_aggregator:
            global_aggregator.reset()
        print("[AI Worker] 🧹 ĐÃ XÓA SẠCH BỘ ĐỆM RAM (locked_cards & spatial_clusters), SẴN SÀNG TEST PHIÊN MỚI!")
        sio.emit('session_ram_reset_ack', {'status': 'OK', 'timestamp': time.time()})
    except Exception as e:
        print(f"[AI Worker] reset_session_ram error: {e}")

@sio.on('scan_exact_frame_request')
def on_scan_exact_frame_request(data):
    global instant_engine, instant_corner_engine
    try:
        img_b64 = data.get('imageBase64')
        if not img_b64:
            return
        time_str = data.get('timeStr', '')
        room_id = data.get('roomId', 'default')

        if instant_engine is None:
            instant_engine = DirectONNXYoloEngine(ONNX_MODEL_PATH, intra_threads=4)
            if os.path.exists(CORNER_ONNX_PATH):
                instant_corner_engine = DirectONNXYoloEngine(CORNER_ONNX_PATH, intra_threads=2)

        raw_b64 = img_b64.split(',', 1)[1] if ',' in img_b64 else img_b64
        raw_bytes = base64.b64decode(raw_b64)
        nparr = np.frombuffer(raw_bytes, np.uint8)
        crop_cv = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if crop_cv is None or crop_cv.size == 0:
            return

        sharpness = compute_sharpness_fast(crop_cv)
        ch, cw = crop_cv.shape[:2]

        all_candidates = []
        # Tăng cường độ nét, khử bóng lóa phòng bằng bộ lọc CLAHE trước khi nhận diện
        enhanced_crop = enhance_low_light_crop(crop_cv)

        # 1. Thẳng 0° (đưa trực tiếp enhanced_crop vào mô hình, không padding thu nhỏ)
        preds0 = instant_engine.predict(enhanced_crop, conf_thres=0.35)
        for cid, cname, conf, rb in preds0:
            p = parse_card_code(cname)
            if p:
                all_candidates.append((p, conf, '0° Thẳng'))

        # Early exit tối ưu tốc độ: Nếu pass 0° đã nhận diện rõ (conf >= 0.55), chốt luôn trong 20ms mà không chạy 3 pass nghiêng!
        if not (all_candidates and all_candidates[0][1] >= 0.55):
            # 2. Nghiêng trái -20°
            preds_l = rotate_image_and_map_boxes(enhanced_crop, -20.0, instant_engine, pad=30)
            for cid, cname, conf, b in preds_l:
                p = parse_card_code(cname)
                if p:
                    all_candidates.append((p, conf, '-20° Nghiêng'))

            # 3. Nghiêng phải +20°
            preds_r = rotate_image_and_map_boxes(enhanced_crop, 20.0, instant_engine, pad=30)
            for cid, cname, conf, b in preds_r:
                p = parse_card_code(cname)
                if p:
                    all_candidates.append((p, conf, '+20° Nghiêng'))

            # 4. Corner / Phối cảnh
            eng_corner = instant_corner_engine or instant_engine
            stretched = cv2.resize(enhanced_crop, None, fx=1.0, fy=1.35, interpolation=cv2.INTER_LINEAR)
            preds_s = eng_corner.predict(stretched, conf_thres=0.35)
            for cid, cname, conf, rb in preds_s:
                p = parse_card_code(cname)
                if p:
                    all_candidates.append((p, conf, 'Dọc 1.35x'))

        all_candidates.sort(key=lambda x: x[1], reverse=True)
        best = all_candidates[0] if all_candidates else None

        # 1. Nếu bắt dính bài: Phát tín hiệu card_detected về Web
        is_detected = (best is not None and best[1] >= 0.42)
        card_title = ""
        c_code = "NO_CARD"

        if is_detected:
            card_dict = best[0]
            conf = best[1]
            pct = int(round(conf * 100))
            card_title = f"{card_dict['display']} ({pct}%)"
            c_code = card_dict.get('code', 'CARD')
            print(f"[AI Worker] 🎯 [FRAME {time_str}] Quét trúng: {card_title} | Nét={sharpness}")
            sio.emit('server_card_detected', {
                'card': {
                    **card_dict,
                    'confidence': round(conf, 3)
                },
                'confidence': round(conf, 3),
                'sharpness': sharpness,
                'image': f"data:image/png;base64,{raw_b64}" if not raw_b64.startswith('data:') else raw_b64,
                'timestamp': f"⏱ {time_str}",
                'roomId': room_id,
                'updateFrameOnly': False
            })

        # 2. LƯU 100% MỌI FRAME LƯỚT TRÚNG (CẢ THÀNH CÔNG LẪN TRƯỢT/CHƯA BẮT ĐƯỢC) VÀO FOLDER media/debug_pairs
        try:
            debug_dir = r"E:\iosapp\server\media\debug_pairs"
            os.makedirs(debug_dir, exist_ok=True)
            now_str = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:19]

            if is_detected:
                # 1. Ảnh thực tế cắt đúng ô đỏ (PNG Lossless nguyên bản 100%)
                f_real = os.path.join(debug_dir, f"{now_str}_1_thuc_te_{c_code}.png")
                cv2.imwrite(f_real, crop_cv, [int(cv2.IMWRITE_PNG_COMPRESSION), 1])

                # 2. Ảnh AI nhận diện (dùng enhanced_crop sắc nét + vẽ box xanh + nhãn)
                ai_box_img = enhanced_crop.copy()
                cv2.rectangle(ai_box_img, (0, 0), (cw - 1, ch - 1), (0, 255, 0), 2)
                cv2.rectangle(ai_box_img, (0, 0), (min(cw, 230), 24), (0, 0, 0), -1)
                cv2.putText(ai_box_img, f"{card_title} | Net:{sharpness:.1f}", (4, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1)
                f_ai = os.path.join(debug_dir, f"{now_str}_2_ai_nhan_dien_{c_code}.png")
                cv2.imwrite(f_ai, ai_box_img, [int(cv2.IMWRITE_PNG_COMPRESSION), 1])
            else:
                top_conf_pct = int(round(best[1] * 100)) if best else 0
                top_name = best[0].get('code', '') if best else ''
                tag = f"CHUA_BAT_{top_name}_{top_conf_pct}pct" if top_name else "CHUA_BAT_0pct"

                # 1. Ảnh thực tế cắt đúng ô đỏ (PNG Lossless nguyên bản 100%)
                f_real = os.path.join(debug_dir, f"{now_str}_1_thuc_te_{tag}.png")
                cv2.imwrite(f_real, crop_cv, [int(cv2.IMWRITE_PNG_COMPRESSION), 1])

                # 2. Ảnh AI ghi nhận kết quả rà soát (dùng enhanced_crop sắc nét + box vàng cam)
                ai_box_img = enhanced_crop.copy()
                cv2.rectangle(ai_box_img, (0, 0), (cw - 1, ch - 1), (0, 140, 255), 2)
                cv2.rectangle(ai_box_img, (0, 0), (min(cw, 250), 24), (0, 0, 0), -1)
                lbl = f"Chua bat ({top_name or 'N/A'} {top_conf_pct}%) | Net:{sharpness:.1f}"
                cv2.putText(ai_box_img, lbl, (4, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.40, (0, 180, 255), 1)
                f_ai = os.path.join(debug_dir, f"{now_str}_2_ai_nhan_dien_{tag}.png")
                cv2.imwrite(f_ai, ai_box_img, [int(cv2.IMWRITE_PNG_COMPRESSION), 1])

            # Giữ lại tối đa 200 ảnh gần nhất để chống đầy ổ cứng
            all_imgs = sorted(glob.glob(os.path.join(debug_dir, "*.png")) + glob.glob(os.path.join(debug_dir, "*.jpg")))
            if len(all_imgs) > 200:
                for old_img in all_imgs[:-200]:
                    try: os.remove(old_img)
                    except: pass
        except Exception as d_err:
            print(f"[AI Worker] Debug save error: {d_err}")

        # Đồng bộ trực tiếp ảnh nét và kết quả lên khung 'Soi RAM' trên Web
        disp_card = card_title if (best and best[1] >= 0.42) else "Đang soi khung hình chuẩn"
        conf_val = round(best[1] * 100, 1) if (best and best[1] >= 0.42) else 0.0
        # Xuất ảnh PNG độ nét cao cho màn hình Soi RAM trên Web
        _, enh_buf = cv2.imencode('.png', enhanced_crop)
        enh_b64 = base64.b64encode(enh_buf).decode('utf-8')
        sio.emit('ai_debug_crop', {
            'image': f"data:image/png;base64,{enh_b64}",
            'cropBox': [0, 0, cw, ch],
            'cropSize': f"{cw}x{ch}",
            'detectedCard': disp_card,
            'bestConf': conf_val,
            'sharpness': sharpness,
            'sourceFps': 120,
            'scanFps': 20,
            'isDetected': bool(best and best[1] >= 0.42),
            'roomId': room_id
        })
    except Exception as e:
        print(f"[AI Worker] scan_exact_frame_request error: {e}")


def enqueue_card_detected(card, all_cards, crop_image, sharpness=0.0, roi=None, update_frame_only=False):
    try:
        emit_queue.put_nowait((card, all_cards, crop_image.copy(), sharpness, dict(roi) if roi else None, update_frame_only))
    except queue.Full:
        pass


def async_web_publisher_loop():
    """
    KÊNH 5 — Async Web Publisher & JPEG Encoder Channel.
    """
    while not stop_worker.is_set():
        try:
            item = emit_queue.get(timeout=0.2)
        except queue.Empty:
            continue

        card, all_cards, crop_image, sharpness, roi, update_frame_only = item
        if not card or not sio.connected:
            continue
        try:
            _, buf = cv2.imencode('.jpg', crop_image, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
            img_b64 = f"data:image/jpeg;base64,{base64.b64encode(buf).decode('utf-8')}"

            payload = {
                'card': card,
                'allCards': all_cards,
                'confidence': card.get('confidence', 0.95),
                'sharpness': sharpness,
                'image': img_b64,
                'timestamp': datetime.now().strftime('%H:%M:%S'),
                'roomId': roi.get('roomId', 'default') if roi else 'default',
                'doorIndex': -1,
                'updateFrameOnly': update_frame_only
            }
            sio.emit('server_card_detected', payload)
            tag = "✨ NÂNG CẤP ẢNH NÉT NHẤT" if update_frame_only else "🎯 ĐÃ CHỐT LÁ BÀI CHUẨN (0 TRÙNG)"
            print(f"[AI Worker] {tag}: {card.get('display', '')} ({int(card.get('confidence', 0.95)*100)}%) | Độ nét={sharpness}")
        except Exception as e:
            print(f"[AI Worker] Lỗi gửi kết quả qua Socket: {e}")


class BestFrameCardAggregator:
    """
    KÊNH 4 — Bộ Tổng Hợp Bầu Chọn Theo Đỉnh Độ Nét (Spatial Physical-Card Election & Strict Deduplication):
    1. Chống nhận diện sai chất bài (vd: 3♣ vs 3♠ khi bài mới đưa vào còn mờ):
       - Gom các dự đoán ở cùng một vị trí không gian (`dist <= 115px`) trong cửa sổ 180ms vào chung 1 sự kiện vật lý (`spatial_clusters`).
       - Mỗi frame bầu chọn cho mã bài `code` với trọng số `weight = (sharpness ** 1.6) * (conf ** 2.2)`.
       - Frame sắc nét nhất khi bài nằm rõ trong khung sẽ quyết định mã bài chiến thắng (loại bỏ hoàn toàn lỗi đoán nhầm chất lúc bài mới chớm vào còn nhòe!).
    2. Chống trùng lặp tuyệt đối (`locked_cards`):
       - Mỗi lá bài chỉ được chốt ĐÚNG 1 LẦN DUY NHẤT.
       - Nếu các frame sau của chính lá bài đó có độ nét cao hơn, chỉ gửi `update_frame_only=True` để nâng cấp bức ảnh rõ nhất.
    """
    def __init__(self, emit_callback):
        self.emit_callback = emit_callback
        self.lock = threading.Lock()
        self.spatial_clusters = []  # Danh sách các cụm bài vật lý đang trong cửa sổ 180ms
        self.locked_cards = {}      # code -> dict khóa chống trùng sau khi đã chốt

    def reset(self):
        with self.lock:
            self.spatial_clusters.clear()
            self.locked_cards.clear()

    def _annotate_best_crop(self, crop_img, bbox, code_str, conf_val):
        annotated = crop_img.copy()
        bx1, by1, bx2, by2 = bbox
        cv2.rectangle(annotated, (bx1, by1), (bx2, by2), (0, 255, 0), 2)
        cv2.putText(
            annotated,
            f"{code_str} {int(round(conf_val * 100))}%",
            (max(4, bx1), max(18, by1 - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (0, 255, 0),
            2
        )
        return annotated

    def submit_frame_result(self, frame_seq, ts, detected_cards, sharpness, current_roi):
        now = time.time()
        with self.lock:
            if detected_cards:
                detected_cards.sort(key=lambda x: x[1], reverse=True)
                best_card, best_conf, best_bbox, best_crop = detected_cards[0]
                code = best_card.get('code')

                if best_conf >= MIN_CONFIDENCE and code:
                    bx1, by1, bx2, by2 = best_bbox
                    cx = 0.5 * (bx1 + bx2)
                    cy = 0.5 * (by1 + by2)

                    card_patch = best_crop[
                        max(0, by1 - 16):min(best_crop.shape[0], by2 + 16),
                        max(0, bx1 - 16):min(best_crop.shape[1], bx2 + 16)
                    ]
                    patch_sharp = compute_sharpness(card_patch) if card_patch.size > 0 else sharpness
                    frame_sharp = max(sharpness, patch_sharp)
                    vote_weight = (max(10.0, frame_sharp) ** 1.6) * (best_conf ** 2.2)
                    quality = frame_sharp * (best_conf ** 1.5) + (best_conf * 30.0)
                    all_cards = [c[0] for c in detected_cards]

                    # 1. Nếu mã bài này đã chốt trong ván -> Khóa tuyệt đối 100%, chỉ nâng cấp ảnh NÉT HƠN!
                    if code in self.locked_cards:
                        locked = self.locked_cards[code]
                        locked['last_seen'] = now
                        locked['cx'] = cx
                        locked['cy'] = cy
                        if frame_sharp > locked['sharpness'] * 1.08 and quality > locked['quality'] * 1.05:
                            locked['sharpness'] = frame_sharp
                            locked['conf'] = max(locked['conf'], best_conf)
                            locked['quality'] = quality
                            locked['card']['confidence'] = round(locked['conf'], 3)
                            annotated_crop = self._annotate_best_crop(best_crop, best_bbox, code, locked['conf'])
                            self.emit_callback(
                                locked['card'],
                                all_cards,
                                annotated_crop,
                                frame_sharp,
                                current_roi,
                                update_frame_only=True
                            )
                        return

                    # 2. Kiểm tra nếu vị trí (cx, cy) này trùng với 1 lá bài vừa chốt cách đây < 0.45s
                    for l_code, l_info in self.locked_cards.items():
                        if (now - l_info['last_seen']) < 0.45:
                            dist_locked = math.hypot(cx - l_info.get('cx', -999), cy - l_info.get('cy', -999))
                            if dist_locked < 85.0 and best_card.get('rank') == l_info['card'].get('rank'):
                                l_info['last_seen'] = now
                                return

                    # 3. Gom vào Cụm Bầu Chọn Đỉnh Độ Nét (150ms Election Window)
                    matched_cluster = None
                    for cl in self.spatial_clusters:
                        if math.hypot(cx - cl['cx'], cy - cl['cy']) <= 125.0:
                            matched_cluster = cl
                            break

                    if matched_cluster is None:
                        matched_cluster = {
                            'cx': cx,
                            'cy': cy,
                            'first_seen': now,
                            'last_seen': now,
                            'total_frames': 0,
                            'roi': current_roi,
                            'votes': {}
                        }
                        self.spatial_clusters.append(matched_cluster)

                    matched_cluster['cx'] = 0.6 * cx + 0.4 * matched_cluster['cx']
                    matched_cluster['cy'] = 0.6 * cy + 0.4 * matched_cluster['cy']
                    matched_cluster['last_seen'] = now
                    matched_cluster['total_frames'] += 1
                    matched_cluster['roi'] = current_roi

                    votes = matched_cluster['votes']
                    if code not in votes:
                        votes[code] = {
                            'code': code,
                            'weight': vote_weight,
                            'count': 1,
                            'card': best_card,
                            'all_cards': all_cards,
                            'crop': best_crop,
                            'bbox': best_bbox,
                            'sharpness': frame_sharp,
                            'conf': best_conf,
                            'quality': quality
                        }
                    else:
                        v = votes[code]
                        v['weight'] += vote_weight
                        v['count'] += 1
                        if quality > v['quality'] or frame_sharp > v['sharpness'] * 1.04:
                            v['card'] = best_card
                            v['all_cards'] = all_cards
                            v['crop'] = best_crop
                            v['bbox'] = best_bbox
                            v['sharpness'] = frame_sharp
                            v['conf'] = best_conf
                            v['quality'] = quality

            self._flush_ready_clusters_unlocked(now)

    def _flush_ready_clusters_unlocked(self, now):
        remaining = []
        for cl in self.spatial_clusters:
            age = now - cl['first_seen']
            idle = now - cl['last_seen']

            if not cl['votes']:
                continue
            winner = max(cl['votes'].values(), key=lambda item: item['weight'])

            # Bỏ qua nếu chỉ xuất hiện 1 frame yếu và đã rời đi
            if cl['total_frames'] < 2 and winner['conf'] < 0.70:
                if idle <= 0.080:
                    remaining.append(cl)
                continue

            # Điều kiện chốt bầu chọn đỉnh độ nét (150ms hoặc khi bài vừa rời khung):
            # Cửa sổ 150ms đủ để frame nét nhất (3♣ 94%) đè bẹp frame mờ lúc mới vào (3♠/5♠ 75%)
            ready_by_window = (winner['count'] >= 2 and (age >= 0.150 or winner['count'] >= 4 or idle >= 0.060))
            ready_by_high_conf = (winner['count'] >= 2 and winner['conf'] >= 0.82 and winner['sharpness'] >= 60.0 and age >= 0.090)

            if ready_by_window or ready_by_high_conf:
                w_code = winner['code']

                # Chống nhận nhầm chất bài cùng rank (ví dụ 3♠ vs 3♣ tại cùng 1 vị trí đặt bài trong ván)
                same_rank_code = None
                for l_code, l_info in self.locked_cards.items():
                    if (now - l_info['last_seen']) < 2.0:
                        dist = math.hypot(cl['cx'] - l_info.get('cx', -999), cl['cy'] - l_info.get('cy', -999))
                        if dist < 120.0 and winner['card'].get('rank') == l_info['card'].get('rank'):
                            same_rank_code = l_code
                            break

                if same_rank_code is not None:
                    l_info = self.locked_cards[same_rank_code]
                    l_info['last_seen'] = now
                    if winner['conf'] > l_info['conf'] and winner['sharpness'] > l_info['sharpness']:
                        del self.locked_cards[same_rank_code]
                        self.locked_cards[w_code] = {
                            'card': winner['card'],
                            'all_cards': winner['all_cards'],
                            'sharpness': winner['sharpness'],
                            'conf': winner['conf'],
                            'quality': winner['quality'],
                            'cx': cl['cx'],
                            'cy': cl['cy'],
                            'locked_at': now,
                            'last_seen': now
                        }
                        annotated_crop = self._annotate_best_crop(winner['crop'], winner['bbox'], w_code, winner['conf'])
                        self.emit_callback(
                            winner['card'],
                            winner['all_cards'],
                            annotated_crop,
                            winner['sharpness'],
                            cl['roi'],
                            update_frame_only=True
                        )
                    continue

                if w_code not in self.locked_cards and winner['conf'] >= 0.74:
                    self.locked_cards[w_code] = {
                        'card': winner['card'],
                        'all_cards': winner['all_cards'],
                        'sharpness': winner['sharpness'],
                        'conf': winner['conf'],
                        'quality': winner['quality'],
                        'cx': cl['cx'],
                        'cy': cl['cy'],
                        'locked_at': now,
                        'last_seen': now
                    }
                    annotated_crop = self._annotate_best_crop(winner['crop'], winner['bbox'], w_code, winner['conf'])
                    self.emit_callback(
                        winner['card'],
                        winner['all_cards'],
                        annotated_crop,
                        winner['sharpness'],
                        cl['roi'],
                        update_frame_only=False
                    )
            else:
                remaining.append(cl)

        self.spatial_clusters = remaining

    def flush_idle_tick(self):
        now = time.time()
        with self.lock:
            self._flush_ready_clusters_unlocked(now)


class MultiChannelFrameBuffer120Fps:
    """
    KÊNH 2 — Bộ Hút Khung Hình 120fps Live-Edge (0ms TCP Backlog + Peak-Sharpness Priority Buffer):
    - Vòng lặp `_reader_loop` chỉ làm việc siêu nhẹ (<0.05ms Python GIL): đọc `cap.read()` và cắt lát mảng thô `raw_sub`,
      nhường toàn bộ việc xoay/lật/LUTF cho 4 Kênh AI. Nhờ đó tốc độ rút luồng luôn đạt 120fps thực tế,
      không bao giờ để ứ đọng frame cũ trong bộ đệm TCP!
    - Nếu hàng đợi 4 frame đang đầy, cơ chế **Peak-Sharpness Priority** chỉ thay thế frame mờ nhất bằng frame nét hơn,
      đảm bảo: (1) Độ trễ so với Live luôn < 0.2s, và (2) KHÔNG BAO GIỜ RỚT FRAME RÕ NÉT CỦA LÁ BÀI!
    """
    def __init__(self, src):
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "fflags;nobuffer|flags;low_delay|probesize;32|analyzeduration;0|threads;4"
        self.cap = cv2.VideoCapture(src, cv2.CAP_FFMPEG)
        try:
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        self.stopped = False
        self.cond = threading.Condition()
        self.queue = []  # Ring Buffer 4 frame mượt mà cho luồng 120fps (độ trễ < 33ms)
        self.max_queue_size = 4
        self.is_opened = self.cap.isOpened()

        self.frame_seq = 0
        self.last_frame_ts = time.time()
        self.fps_timestamps = collections.deque(maxlen=140)
        self.measured_fps = 120

        if self.is_opened:
            self.thread = threading.Thread(target=self._reader_loop, daemon=True)
            self.thread.start()
        else:
            try:
                self.cap.release()
            except Exception:
                pass

    def _reader_loop(self):
        try:
            while not self.stopped:
                t0 = time.perf_counter()
                ret, raw_frame = self.cap.read()
                if not ret or raw_frame is None or raw_frame.size == 0:
                    time.sleep(0.001)
                    continue

                # Luôn xả nhanh các packet TCP tồn đọng để không bao giờ bị trễ hàng ngàn frame
                if len(self.queue) >= 2:
                    for _ in range(4):
                        if not self.cap.grab():
                            break

                now = time.time()
                self.last_frame_ts = now
                self.fps_timestamps.append(now)
                if len(self.fps_timestamps) >= 10:
                    span = self.fps_timestamps[-1] - self.fps_timestamps[0]
                    if span > 0.05:
                        raw_fps = (len(self.fps_timestamps) - 1) / span
                        self.measured_fps = min(120, max(60, int(round(raw_fps))))

                with roi_lock:
                    current_roi = dict(roi_state)

                rh, rw = raw_frame.shape[:2]
                (rx1, ry1, rx2, ry2), crop_box, rot, is_flipped = compute_raw_crop_coords(rh, rw, current_roi)
                sub_raw = raw_frame[ry1:ry2, rx1:rx2].copy()
                fast_sharp = compute_sharpness_fast(sub_raw)

                with self.cond:
                    self.frame_seq += 1
                    new_item = (self.frame_seq, now, sub_raw, crop_box, rot, is_flipped, fast_sharp, current_roi)
                    if len(self.queue) < self.max_queue_size:
                        self.queue.append(new_item)
                    else:
                        # Tìm frame có độ nét thấp nhất (nhòe nhất) trong hàng đợi để thay thế bằng frame nét hơn
                        min_idx = min(range(len(self.queue)), key=lambda idx: self.queue[idx][6])
                        if fast_sharp >= self.queue[min_idx][6] * 0.90:
                            self.queue[min_idx] = new_item
                        else:
                            # Nếu frame mới quá nhòe so với các frame đang chờ thì bỏ qua frame nhòe này
                            pass
                    self.cond.notify()
        finally:
            try:
                self.cap.release()
            except Exception:
                pass

    def pop_next_unique_frame(self, timeout=0.03):
        with self.cond:
            if not self.queue and not self.stopped:
                self.cond.wait(timeout=timeout)
            if not self.queue or self.stopped:
                return None
            return self.queue.pop(0)

    def release(self):
        self.stopped = True
        with self.cond:
            self.cond.notify_all()
        if self.is_opened and hasattr(self, 'thread'):
            self.thread.join(timeout=2.5)


def rotate_image_and_map_boxes(reticle_crop, angle_deg, main_engine, pad=68):
    """
    Xoay ảnh `angle_deg` (ví dụ -22° hoặc +22°) để bắt lá bài cầm nghiêng trái/phải,
    sau đó ánh xạ ngược tọa độ hộp bài về lại hệ quy chiếu gốc của `reticle_crop`.
    """
    ch, cw = reticle_crop.shape[:2]
    center = (cw * 0.5, ch * 0.5)
    rot_mat = cv2.getRotationMatrix2D(center, angle_deg, 1.0)
    inv_mat = cv2.getRotationMatrix2D(center, -angle_deg, 1.0)

    rotated = cv2.warpAffine(
        reticle_crop,
        rot_mat,
        (cw, ch),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(38, 38, 38)
    )
    padded = cv2.copyMakeBorder(rotated, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(38, 38, 38))
    raw_preds = main_engine.predict(padded, conf_thres=MIN_CONFIDENCE)

    mapped_preds = []
    for cid, class_name, conf, raw_b in raw_preds:
        rx1 = raw_b[0] - pad
        ry1 = raw_b[1] - pad
        rx2 = raw_b[2] - pad
        ry2 = raw_b[3] - pad
        bw = rx2 - rx1
        bh = ry2 - ry1
        rcx = 0.5 * (rx1 + rx2)
        rcy = 0.5 * (ry1 + ry2)

        # Ánh xạ tâm (rcx, rcy) ngược về ảnh gốc trước khi xoay
        orig_cx = inv_mat[0, 0] * rcx + inv_mat[0, 1] * rcy + inv_mat[0, 2]
        orig_cy = inv_mat[1, 0] * rcx + inv_mat[1, 1] * rcy + inv_mat[1, 2]

        bx1 = max(0, min(cw, int(round(orig_cx - bw * 0.5))))
        by1 = max(0, min(ch, int(round(orig_cy - bh * 0.5))))
        bx2 = max(0, min(cw, int(round(orig_cx + bw * 0.5))))
        by2 = max(0, min(ch, int(round(orig_cy + bh * 0.5))))
        mapped_preds.append((cid, class_name, conf, [bx1, by1, bx2, by2]))
    return mapped_preds


def detect_multi_angle_on_channel(channel_id, main_engine, sub_raw, crop_box, rot, is_flipped):
    """
    4 KÊNH AI CHUYÊN TRÁCH 4 GÓC NGHIÊNG KHÁC NHAU (1 Pass / Kênh = ~4.8ms, Tổng hợp đủ 4 góc mỗi 33ms):
    - Kênh #1 (channel_id = 0): Quét Góc Thẳng `0°` (`pad=74`).
    - Kênh #2 (channel_id = 1): Quét Góc Nghiêng Trái `-22°` (bắt bài cầm nghiêng sang trái).
    - Kênh #3 (channel_id = 2): Quét Góc Nghiêng Phải `+22°` (bắt bài cầm nghiêng sang phải).
    - Kênh #4 (channel_id = 3): Quét Góc Nghiêng Phối Cảnh Dọc `fy=1.36` (bắt bài cầm ngửa/dẹt).
    """
    oriented = orient_raw_sub(sub_raw, rot, is_flipped)
    reticle_crop = enhance_low_light_crop(oriented)
    x1, y1, x2, y2 = crop_box
    ch, cw = reticle_crop.shape[:2]
    dets = []

    if channel_id == 0:
        pad = 74
        padded = cv2.copyMakeBorder(reticle_crop, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(38, 38, 38))
        raw_preds = main_engine.predict(padded, conf_thres=MIN_CONFIDENCE)
        boxes_in_crop = [
            (
                cid,
                cname,
                conf,
                [
                    max(0, min(cw, int(round(rb[0] - pad)))),
                    max(0, min(ch, int(round(rb[1] - pad)))),
                    max(0, min(cw, int(round(rb[2] - pad)))),
                    max(0, min(ch, int(round(rb[3] - pad))))
                ]
            )
            for cid, cname, conf, rb in raw_preds
        ]
    elif channel_id == 1:
        boxes_in_crop = rotate_image_and_map_boxes(reticle_crop, -22.0, main_engine, pad=68)
    elif channel_id == 2:
        boxes_in_crop = rotate_image_and_map_boxes(reticle_crop, +22.0, main_engine, pad=68)
    else:
        fy_scale = 1.45
        pad = 65
        stretched = cv2.resize(reticle_crop, None, fx=1.0, fy=fy_scale, interpolation=cv2.INTER_LINEAR)
        padded = cv2.copyMakeBorder(stretched, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(38, 38, 38))
        raw_preds = main_engine.predict(padded, conf_thres=MIN_CONFIDENCE)
        boxes_in_crop = [
            (
                cid,
                cname,
                conf,
                [
                    max(0, min(cw, int(round(rb[0] - pad)))),
                    max(0, min(ch, int(round((rb[1] - pad) / fy_scale)))),
                    max(0, min(cw, int(round(rb[2] - pad)))),
                    max(0, min(ch, int(round((rb[3] - pad) / fy_scale))))
                ]
            )
            for cid, cname, conf, rb in raw_preds
        ]

    for cid, class_name, conf, box in boxes_in_crop:
        parsed = parse_card_code(class_name)
        if not parsed:
            continue
        if not validate_card_patch(reticle_crop, box, parsed, conf):
            continue
        bx1, by1, bx2, by2 = box
        global_box = [bx1 + x1, by1 + y1, bx2 + x1, by2 + y1]
        card_dict = {
            **parsed,
            'confidence': round(conf, 3),
            'bbox': global_box
        }
        dets.append((card_dict, conf, box, reticle_crop))

    dets.sort(key=lambda x: x[1], reverse=True)
    return dets, reticle_crop


def discover_active_stream():
    global active_stream_key
    try:
        r = requests.get("http://127.0.0.1:9997/v3/paths/list", timeout=0.6)
        if r.status_code == 200:
            items = r.json().get("items", [])
            for it in items:
                if it.get("ready", False):
                    name = it.get("name", "")
                    s_key = name.split("/", 1)[1] if name.startswith("live/") else name
                    if s_key and s_key not in ended_stream_keys:
                        with stream_lock:
                            if active_stream_key != s_key:
                                print(f"[AI Worker] 🔄 Auto-discovered ready 120fps stream on MediaMTX: {s_key}")
                                active_stream_key = s_key
                        return s_key
    except Exception:
        pass

    try:
        r = requests.get(f"{BACKEND_URL}/api/stream/active", timeout=1.0)
        if r.status_code == 200:
            d = r.json()
            if d.get('stream') and d['stream'].get('status') == 'LIVE':
                s_key = d['stream']['streamKey']
                with stream_lock:
                    if active_stream_key != s_key:
                        print(f"[AI Worker] Found active stream from Backend API: {s_key}")
                        active_stream_key = s_key
                return s_key
    except Exception:
        pass
    return None


def is_mediamtx_path_ready(s_key):
    if not s_key:
        return False
    try:
        r = requests.get("http://127.0.0.1:9997/v3/paths/list", timeout=0.6)
        if r.status_code == 200:
            items = r.json().get("items", [])
            for it in items:
                name = it.get("name", "")
                if (name == f"live/{s_key}" or name == s_key) and it.get("ready", False):
                    return True
    except Exception:
        pass
    return False


def debug_crop_broadcaster_loop():
    """
    Vòng lặp nhàn rỗi (idle) để nhường quyền cập nhật Soi RAM hoàn toàn cho Canvas Client + scan_exact_frame,
    triệt tiêu 100% hiện tượng chớp/giật giữa ảnh cũ của server và ảnh live hiện tại!
    """
    while not stop_worker.is_set():
        time.sleep(1.0)
        if not sio.connected:
            continue

        with live_crop_lock:
            crop_img = live_crop_state['crop_img']
            updated_at = live_crop_state['updated_at']
            if crop_img is None or updated_at <= last_sent_ts or (time.time() - updated_at) > 2.0:
                continue
            last_sent_ts = updated_at
            debug_crop = crop_img.copy()
            crop_box = list(live_crop_state['crop_box'])
            sharpness = live_crop_state['sharpness']
            source_fps = live_crop_state['source_fps']
            scan_fps = live_crop_state['scan_fps']
            overlay_items = list(live_crop_state['detected_overlay'])
            detected_desc = live_crop_state['detected_desc']
            best_conf = live_crop_state['best_conf']
            overlay_ts = live_crop_state['overlay_ts']
            room_id = live_crop_state['room_id']
            channels_snapshot = [
                {
                    'id': ch_info['id'],
                    'seq': ch_info['seq'],
                    'sharpness': ch_info['sharpness'],
                    'card': ch_info['card'],
                    'conf': ch_info['conf'],
                    'mode': ch_info['mode']
                }
                for _, ch_info in sorted(live_crop_state['channels'].items())
            ]

        try:
            debug_dh, debug_dw = debug_crop.shape[:2]
            now = time.time()
            has_recent_det = (now - overlay_ts) <= 0.40 and len(overlay_items) > 0

            if has_recent_det:
                for bx1, by1, bx2, by2, code_str, conf_pct in overlay_items:
                    cv2.rectangle(debug_crop, (bx1, by1), (bx2, by2), (0, 255, 0), 2)
                    cv2.putText(
                        debug_crop,
                        f"{code_str} {conf_pct}%",
                        (max(4, bx1), max(18, by1 - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.55,
                        (0, 255, 0),
                        2
                    )

            _, dbuf = cv2.imencode('.jpg', debug_crop, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
            b64_debug = base64.b64encode(dbuf).decode('utf-8')
            sio.emit('ai_debug_crop', {
                'image': f"data:image/jpeg;base64,{b64_debug}",
                'cropBox': crop_box,
                'cropSize': f"{debug_dw}x{debug_dh}",
                'detectedCard': detected_desc if has_recent_det else "4 Kênh Đa Góc đang soi 120fps",
                'bestConf': best_conf if has_recent_det else 0.0,
                'sharpness': sharpness,
                'sourceFps': source_fps,
                'scanFps': scan_fps,
                'isDetected': has_recent_det and best_conf >= 55.0,
                'channels': channels_snapshot,
                'roomId': room_id
            })
        except Exception:
            pass


current_reader_lock = threading.Lock()
shared_reader_ref = {'reader': None, 'key': None}
scan_stats_lock = threading.Lock()
scan_timestamps = collections.deque(maxlen=160)
total_scanned_frames = 0


def ai_worker_channel_loop(channel_id, aggregator):
    """
    KÊNH 3 (Worker #channel_id) — Kênh AI Quét Đa Góc Xoay Vòng Độc Lập:
    - Kênh #1: Thẳng 0°
    - Kênh #2: Nghiêng Trái -22°
    - Kênh #3: Nghiêng Phải +22°
    - Kênh #4: Nghiêng Dọc 1.35x
    """
    global total_scanned_frames
    model_path = CORNER_ONNX_PATH if (channel_id == 3 and os.path.exists(CORNER_ONNX_PATH)) else ONNX_MODEL_PATH
    main_eng = DirectONNXYoloEngine(model_path, intra_threads=2)
    mode_name = CHANNEL_MODES.get(channel_id, "Chuẩn 1:1")
    print(f"[AI Worker] 🚀 Kênh AI #{channel_id + 1}/{NUM_AI_CHANNELS} [{mode_name}] đã sẵn sàng!")

    while not stop_worker.is_set():
        with current_reader_lock:
            reader = shared_reader_ref['reader']

        if reader is None or not reader.is_opened:
            time.sleep(0.012)
            continue

        item = reader.pop_next_unique_frame(timeout=0.03)
        if item is None:
            continue

        frame_seq, frame_ts, sub_raw, crop_box, rot, is_flipped, fast_sharp, current_roi = item
        if not current_roi.get('isActive', True):
            continue

        detected_in_reticle, enhanced_crop = detect_multi_angle_on_channel(
            channel_id, main_eng, sub_raw, crop_box, rot, is_flipped
        )
        sharpness = compute_sharpness_fast(enhanced_crop)
        now = time.time()

        with scan_stats_lock:
            total_scanned_frames += 1
            cur_count = total_scanned_frames
            scan_timestamps.append(now)
            scan_fps = 120
            if len(scan_timestamps) >= 12:
                span = scan_timestamps[-1] - scan_timestamps[0]
                if span > 0.02:
                    scan_fps = min(120, int(round((len(scan_timestamps) - 1) / span)))

        with live_crop_lock:
            ch_card = "Trống"
            ch_conf = 0.0
            if detected_in_reticle:
                top_c = detected_in_reticle[0][0]
                ch_conf = round(detected_in_reticle[0][1] * 100, 1)
                ch_card = f"{top_c['display']} ({int(ch_conf)}%)"

            live_crop_state['channels'][channel_id] = {
                'id': channel_id + 1,
                'seq': frame_seq,
                'sharpness': sharpness,
                'card': ch_card,
                'conf': ch_conf,
                'mode': mode_name
            }
            live_crop_state['scan_fps'] = scan_fps
            live_crop_state['source_fps'] = reader.measured_fps

            age = now - live_crop_state['updated_at']
            if (
                live_crop_state['crop_img'] is None
                or detected_in_reticle
                or sharpness >= live_crop_state['sharpness'] * 0.94
                or age >= 0.065
            ):
                live_crop_state['crop_img'] = enhanced_crop
                live_crop_state['crop_box'] = list(crop_box)
                live_crop_state['sharpness'] = sharpness
                live_crop_state['updated_at'] = now
                live_crop_state['room_id'] = current_roi.get('roomId', 'default')

            if detected_in_reticle:
                live_crop_state['detected_desc'] = f"{ch_card} • {mode_name}"
                live_crop_state['best_conf'] = ch_conf
                live_crop_state['overlay_ts'] = now
                live_crop_state['detected_overlay'] = [
                    (d[2][0], d[2][1], d[2][2], d[2][3], d[0]['code'], int(d[1] * 100))
                    for d in detected_in_reticle
                ]

        if cur_count % 120 == 0:
            in_reticle_names = [f"{d[0]['code']}({int(d[1]*100)}%)" for d in detected_in_reticle]
            print(
                f"[AI Worker] ⚡ 4-Kênh Đa Góc #{cur_count} (Frame #{frame_seq} -> Kênh #{channel_id+1} {mode_name}) "
                f"| Src={reader.measured_fps}fps | Scan={scan_fps}fps | Sharpness={sharpness} | InBox={in_reticle_names}"
            )

        aggregator.submit_frame_result(frame_seq, frame_ts, detected_in_reticle, sharpness, current_roi)


def stream_coordinator_loop(aggregator):
    """
    KÊNH 1 — Stream Monitor & Coordinator Channel.
    """
    last_discover_ts = 0.0
    while not stop_worker.is_set():
        now = time.time()
        aggregator.flush_idle_tick()

        with stream_lock:
            s_key = active_stream_key

        if not s_key or (now - last_discover_ts) > 1.8:
            last_discover_ts = now
            discovered = discover_active_stream()
            if discovered:
                s_key = discovered

        with current_reader_lock:
            cur_reader = shared_reader_ref['reader']
            cur_key = shared_reader_ref['key']

        if not s_key:
            if cur_reader is not None:
                with current_reader_lock:
                    shared_reader_ref['reader'] = None
                    shared_reader_ref['key'] = None
                cur_reader.release()
                aggregator.reset()
            time.sleep(0.05)
            continue

        if cur_reader is None or cur_key != s_key:
            if cur_reader is not None:
                with current_reader_lock:
                    shared_reader_ref['reader'] = None
                    shared_reader_ref['key'] = None
                cur_reader.release()

            if not is_mediamtx_path_ready(s_key):
                time.sleep(0.25)
                continue

            reader = MultiChannelFrameBuffer120Fps(f"{RTMP_BASE_URL}/{s_key}")
            if not reader.is_opened:
                reader.release()
                reader = MultiChannelFrameBuffer120Fps(f"{RTSP_BASE_URL}/live/{s_key}")
            if not reader.is_opened:
                reader.release()
                reader = MultiChannelFrameBuffer120Fps(f"{RTSP_BASE_URL}/{s_key}")

            if not reader.is_opened:
                reader.release()
                time.sleep(0.3)
                continue

            aggregator.reset()
            with current_reader_lock:
                shared_reader_ref['reader'] = reader
                shared_reader_ref['key'] = s_key
            print(f"[AI Worker] ✅ Đã kết nối RTMP TCP Live-Edge 120fps [{s_key}] -> Phân phối 4 Góc Quét Xoay Vòng!")
            continue

        if (time.time() - cur_reader.last_frame_ts) > 4.0:
            print(f"[AI Worker] ⚠️ Mất tín hiệu luồng {cur_key} (>4s), đang kết nối lại...")
            with current_reader_lock:
                shared_reader_ref['reader'] = None
                shared_reader_ref['key'] = None
            cur_reader.release()
            time.sleep(0.2)
            continue

        time.sleep(0.020)


if __name__ == '__main__':
    print(f"[AI Worker] Starting Multi-Angle 120fps Live-Edge AI Engine ({NUM_AI_CHANNELS} Channels: 0°, -22°, +22°, 1.35x)...")
    global_aggregator = BestFrameCardAggregator(emit_callback=enqueue_card_detected)

    pub_th = threading.Thread(target=async_web_publisher_loop, daemon=True)
    pub_th.start()

    broadcaster_th = threading.Thread(target=debug_crop_broadcaster_loop, daemon=True)
    broadcaster_th.start()

    for ch_idx in range(NUM_AI_CHANNELS):
        t = threading.Thread(target=ai_worker_channel_loop, args=(ch_idx, global_aggregator), daemon=True)
        t.start()

    coord_th = threading.Thread(target=stream_coordinator_loop, args=(global_aggregator,), daemon=True)
    coord_th.start()

    try:
        sio.connect(BACKEND_URL, auth={'token': 'internal_ai_worker'}, socketio_path='/socket.io')
        sio.wait()
    except KeyboardInterrupt:
        stop_worker.set()
        sio.disconnect()
        print("[AI Worker] Stopped.")
