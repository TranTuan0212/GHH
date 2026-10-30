import os
import sys
import math
import random
import time
import shutil
import glob
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from ultralytics import YOLO

sys.stdout.reconfigure(encoding='utf-8')

CLASSES = [
    "10C", "10D", "10H", "10S",
    "2C", "2D", "2H", "2S",
    "3C", "3D", "3H", "3S",
    "4C", "4D", "4H", "4S",
    "5C", "5D", "5H", "5S",
    "6C", "6D", "6H", "6S",
    "7C", "7D", "7H", "7S",
    "8C", "8D", "8H", "8S",
    "9C", "9D", "9H", "9S",
    "AC", "AD", "AH", "AS",
    "JC", "JD", "JH", "JS",
    "KC", "KD", "KH", "KS",
    "QC", "QD", "QH", "QS"
]
CLASS_TO_IDX = {c: i for i, c in enumerate(CLASSES)}
SUIT_SYMBOLS = {'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣'}

FONT_RANK = "C:/Windows/Fonts/arialbd.ttf"
FONT_SUIT = "C:/Windows/Fonts/seguisym.ttf"

BG_COLORS = [
    (24, 78, 38),     # Casino green
    (18, 62, 30),     # Dark felt
    (88, 20, 28),     # Velvet dark red
    (35, 35, 38),     # Dark jacket / indoor
    (65, 60, 55),     # Indoor skin / warm wall
    (40, 38, 42),     # Backlit indoor shadow
]

DATASET_DIR = r"E:\iosapp\server\ai\dataset_matrix"

def make_card_surface(rank, suit, is_dark=False):
    w, h = 150, 210
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    
    bg_val = random.randint(75, 105) if is_dark else random.randint(180, 240)
    card_bg = (bg_val, bg_val, int(bg_val * 0.94))
    b_col = int(bg_val * 0.75)
    cd.rounded_rectangle([0, 0, w-1, h-1], radius=8, fill=card_bg, outline=(b_col, b_col, b_col), width=1)
    
    font_r = ImageFont.truetype(FONT_RANK, 28)
    font_s = ImageFont.truetype(FONT_SUIT, 26)
    
    if suit in ['H', 'D']:
        r_c = max(80, min(220, int(bg_val * 1.1)))
        g_c = max(10, int(bg_val * 0.15))
        color = (r_c, g_c, g_c, 255)
    else:
        g = max(10, int(bg_val * 0.15))
        color = (g, g, g, 255)
        
    rx = 8 if rank != '10' else 4
    # Corner top-left
    cd.text((rx, 6), rank, fill=color, font=font_r)
    cd.text((8, 36), SUIT_SYMBOLS[suit], fill=color, font=font_s)
    
    # Corner bottom-right (rotated 180)
    br = Image.new('RGBA', (45, 70), (0, 0, 0, 0))
    br_d = ImageDraw.Draw(br)
    br_d.text((rx, 6), rank, fill=color, font=font_r)
    br_d.text((8, 36), SUIT_SYMBOLS[suit], fill=color, font=font_s)
    br_rot = br.rotate(180, expand=True)
    card.paste(br_rot, (w - 50, h - 75), br_rot)
    
    # Center pips
    if rank == '5':
        cd.text((w//2 - 13, h//2 - 17), SUIT_SYMBOLS[suit], fill=color, font=font_s)
        cd.text((32, 70), SUIT_SYMBOLS[suit], fill=color, font=font_s)
        cd.text((w - 55, 70), SUIT_SYMBOLS[suit], fill=color, font=font_s)
        cd.text((32, h - 95), SUIT_SYMBOLS[suit], fill=color, font=font_s)
        cd.text((w - 55, h - 95), SUIT_SYMBOLS[suit], fill=color, font=font_s)
    elif rank in ['2', '3', '4', '6', '7', '8', '9', '10']:
        cd.text((w//2 - 13, h//2 - 17), SUIT_SYMBOLS[suit], fill=color, font=font_s)
        cd.text((32, 70), SUIT_SYMBOLS[suit], fill=color, font=font_s)
        cd.text((w - 55, h - 95), SUIT_SYMBOLS[suit], fill=color, font=font_s)
    elif rank in ['J', 'Q', 'K']:
        cd.rounded_rectangle([25, 45, w - 25, h - 45], radius=4, outline=color, width=1)
        cd.text((w//2 - 13, h//2 - 17), rank, fill=color, font=font_r)
    elif rank == 'A':
        font_big = ImageFont.truetype(FONT_SUIT, 42)
        cd.text((w//2 - 21, h//2 - 26), SUIT_SYMBOLS[suit], fill=color, font=font_big)
        
    return card

def generate_matrix_sample(cls_name, angle_deg, tilt_deg, is_mirrored, is_dark, canvas_size=256):
    rank = cls_name[:-1]
    suit = cls_name[-1]
    pil_card = make_card_surface(rank, suit, is_dark)
    cv_card = cv2.cvtColor(np.array(pil_card), cv2.COLOR_RGBA2BGRA)
    ch, cw = cv_card.shape[:2]
    
    # 1. 3D Perspective Tilt (Trapezoid foreshortening)
    tilt_ratio = tilt_deg / 90.0
    inset_x = int(cw * tilt_ratio * 0.45)
    new_h = max(35, int(ch * np.cos(np.radians(tilt_deg))))
    
    pts_src = np.float32([[0, 0], [cw, 0], [cw, ch], [0, ch]])
    pts_dst = np.float32([[inset_x, 0], [cw - inset_x, 0], [cw, new_h], [0, new_h]])
    M_p = cv2.getPerspectiveTransform(pts_src, pts_dst)
    warped = cv2.warpPerspective(cv_card, M_p, (cw, new_h), borderMode=cv2.BORDER_CONSTANT, borderValue=[0,0,0,0])
    
    # Corner box initial points (top-left corner rank + suit)
    corner_box = np.array([[[4, 4]], [[48, 4]], [[48, 70]], [[4, 70]]], dtype=np.float32)
    corner_w = cv2.perspectiveTransform(corner_box, M_p)
    
    # 2. Mirror if requested
    if is_mirrored:
        warped = cv2.flip(warped, 1)
        corner_w[:, 0, 0] = cw - corner_w[:, 0, 0]
        
    # 3. Rotate
    wh, ww = warped.shape[:2]
    pad = int(max(ww, wh) * 0.7)
    padded = cv2.copyMakeBorder(warped, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=[0,0,0,0])
    corner_w[:, 0, 0] += pad
    corner_w[:, 0, 1] += pad
    
    c_rot = (padded.shape[1] // 2, padded.shape[0] // 2)
    M_r = cv2.getRotationMatrix2D(c_rot, angle_deg, 1.0)
    rotated = cv2.warpAffine(padded, M_r, (padded.shape[1], padded.shape[0]), borderMode=cv2.BORDER_CONSTANT, borderValue=[0,0,0,0])
    
    ones = np.ones((corner_w.shape[0], 1))
    homog = np.hstack([corner_w[:, 0, :], ones])
    corner_r = (M_r @ homog.T).T
    
    # Background canvas
    bg_color = random.choice(BG_COLORS)
    canvas = np.full((canvas_size, canvas_size, 3), bg_color, dtype=np.uint8)
    
    r_h, r_w = rotated.shape[:2]
    # Small jitter in placement
    jitter_x = random.randint(-15, 15)
    jitter_y = random.randint(-15, 15)
    cx = (canvas_size - r_w) // 2 + jitter_x
    cy = (canvas_size - r_h) // 2 + jitter_y
    
    alpha = rotated[:, :, 3] / 255.0
    for c in range(3):
        canvas[max(0, cy):min(canvas_size, cy+r_h), max(0, cx):min(canvas_size, cx+r_w), c] = (
            alpha[max(0, -cy):min(r_h, canvas_size-cy), max(0, -cx):min(r_w, canvas_size-cx)] * 
            rotated[max(0, -cy):min(r_h, canvas_size-cy), max(0, -cx):min(r_w, canvas_size-cx), c] +
            (1.0 - alpha[max(0, -cy):min(r_h, canvas_size-cy), max(0, -cx):min(r_w, canvas_size-cx)]) * 
            canvas[max(0, cy):min(canvas_size, cy+r_h), max(0, cx):min(canvas_size, cx+r_w), c]
        )
        
    pts = corner_r + np.array([cx, cy])
    bx1 = max(1, int(pts[:, 0].min()))
    by1 = max(1, int(pts[:, 1].min()))
    bx2 = min(canvas_size - 1, int(pts[:, 0].max()))
    by2 = min(canvas_size - 1, int(pts[:, 1].max()))
    
    bw = bx2 - bx1
    bh = by2 - by1
    if bw < 8 or bh < 8:
        return None, None
        
    xc = (bx1 + bx2) / (2.0 * canvas_size)
    yc = (by1 + by2) / (2.0 * canvas_size)
    nw = bw / float(canvas_size)
    nh = bh / float(canvas_size)
    
    cls_idx = CLASS_TO_IDX[cls_name]
    yolo_line = f"{cls_idx} {xc:.6f} {yc:.6f} {nw:.6f} {nh:.6f}"
    return canvas, yolo_line

def build_full_matrix_dataset():
    print("[Dataset] Building Full Combinatorial 52-Card Matrix Dataset...")
    if os.path.exists(DATASET_DIR):
        shutil.rmtree(DATASET_DIR)
        
    for split in ['train', 'val']:
        os.makedirs(os.path.join(DATASET_DIR, 'images', split), exist_ok=True)
        os.makedirs(os.path.join(DATASET_DIR, 'labels', split), exist_ok=True)
        
    rotations = [0, 45, 90, 135, 180, 225, 270, 315]
    tilts = [0, 25, 40, 55]
    mirrors = [False, True]
    
    train_count = 0
    val_count = 0
    
    for cls_idx, cls_name in enumerate(CLASSES):
        sample_idx = 0
        for rot in rotations:
            for tilt in tilts:
                for is_mirrored in mirrors:
                    sample_idx += 1
                    # Small random jitter to angle and tilt
                    jitter_rot = rot + random.uniform(-4, 4)
                    jitter_tilt = max(0, min(65, tilt + random.uniform(-3, 3)))
                    is_dark = (tilt >= 35 and random.random() < 0.6) or (random.random() < 0.25)
                    
                    img, label_line = generate_matrix_sample(
                        cls_name, jitter_rot, jitter_tilt, is_mirrored, is_dark, canvas_size=256
                    )
                    if img is None:
                        continue
                        
                    # 90% train, 10% val (every 10th sample to val)
                    is_val = (sample_idx % 10 == 0)
                    split = 'val' if is_val else 'train'
                    fname = f"{cls_name}_m{sample_idx:03d}"
                    
                    cv2.imwrite(os.path.join(DATASET_DIR, 'images', split, f"{fname}.jpg"), img, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
                    with open(os.path.join(DATASET_DIR, 'labels', split, f"{fname}.txt"), 'w') as f:
                        f.write(label_line + "\n")
                        
                    if is_val:
                        val_count += 1
                    else:
                        train_count += 1
                        
        if (cls_idx + 1) % 10 == 0 or (cls_idx + 1) == len(CLASSES):
            print(f"  Processed {cls_idx + 1}/52 cards ({train_count} train, {val_count} val)...")
            
    yaml_content = f"""path: {DATASET_DIR}
train: images/train
val: images/val
names:
"""
    for idx, name in enumerate(CLASSES):
        yaml_content += f"  {idx}: {name}\n"

    yaml_path = os.path.join(DATASET_DIR, "data.yaml")
    with open(yaml_path, 'w') as f:
        f.write(yaml_content)

    print(f"[Dataset] Ready: {train_count} train samples, {val_count} val samples. Total = {train_count + val_count}")
    return yaml_path

def train():
    yaml_path = build_full_matrix_dataset()
    base_model_path = os.path.join(os.path.dirname(__file__), "cards_yolov8.pt")
    
    # Backup original weights if not backed up yet
    backup_path = os.path.join(os.path.dirname(__file__), "cards_yolov8_backup.pt")
    if not os.path.exists(backup_path) and os.path.exists(base_model_path):
        shutil.copyfile(base_model_path, backup_path)
        print(f"[Trainer] Created backup at {backup_path}")
        
    print(f"\n[Trainer] Starting Full Matrix Training from {base_model_path}...")
    model = YOLO(base_model_path)
    t0 = time.time()
    
    run_dir = os.path.join(os.path.dirname(__file__), "matrix_train_run")
    if os.path.exists(run_dir):
        shutil.rmtree(run_dir)
        
    model.train(
        data=yaml_path,
        epochs=10,
        imgsz=256,
        batch=32,
        freeze=10,
        optimizer='AdamW',
        lr0=0.0015,
        fliplr=0.0,
        flipud=0.0,
        erasing=0.0,
        scale=0.1,
        mosaic=0.0,
        device='cpu',
        workers=4,
        verbose=True,
        project=os.path.dirname(__file__),
        name="matrix_train_run",
        exist_ok=True
    )
    
    dur = time.time() - t0
    print(f"\n[Trainer] Full matrix training completed in {dur:.1f}s!")
    
    best_weights = os.path.join(run_dir, "weights", "best.pt")
    if not os.path.exists(best_weights):
        best_weights = os.path.join(run_dir, "weights", "last.pt")
        
    if os.path.exists(best_weights):
        shutil.copyfile(best_weights, base_model_path)
        print(f"[Trainer] Successfully updated main model: {base_model_path}")
    else:
        print("[Trainer] Warning: Could not find trained weights")

if __name__ == '__main__':
    train()
