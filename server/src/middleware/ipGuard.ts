import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';

const GUARD_CONFIG_FILE = path.join(__dirname, '../../data/guard_config.json');

// Hỗ trợ cả mã dài và mã số ngắn tiện dụng khi gõ trên điện thoại
export const VALID_KEYS = ['Bacuanobita@1'];
export const SECRET_KEY = 'Bacuanobita@1';

interface GuardData {
  enabled: boolean;
  allowedIps: string[];
}

let guardState: GuardData = {
  enabled: true,
  allowedIps: ['127.0.0.1', '::1', 'localhost']
};

function loadGuardConfig() {
  try {
    if (fs.existsSync(GUARD_CONFIG_FILE)) {
      const raw = fs.readFileSync(GUARD_CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      guardState = {
        enabled: parsed.enabled ?? true,
        allowedIps: Array.isArray(parsed.allowedIps) ? parsed.allowedIps : ['127.0.0.1', '::1']
      };
    }
  } catch (err) {
    console.error('[IPGuard] Lỗi khi đọc guard_config.json:', err);
  }
}

export function saveGuardConfig() {
  try {
    const dir = path.dirname(GUARD_CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GUARD_CONFIG_FILE, JSON.stringify(guardState, null, 2), 'utf8');
  } catch (err) {
    console.error('[IPGuard] Lỗi khi lưu guard_config.json:', err);
  }
}

loadGuardConfig();

export function getClientIp(req: Request): string {
  const cfIp = req.headers['cf-connecting-ip'] as string;
  if (cfIp) return cfIp.trim();

  const forwarded = req.headers['x-forwarded-for'] as string;
  if (forwarded) {
    const firstIp = forwarded.split(',')[0].trim();
    if (firstIp) return firstIp;
  }

  const realIp = req.headers['x-real-ip'] as string;
  if (realIp) return realIp.trim();

  const remote = req.socket.remoteAddress || req.ip || '';
  return remote.replace(/^.*:/, '');
}

export function isGuardEnabled(): boolean {
  return guardState.enabled;
}

export function setGuardEnabled(enabled: boolean) {
  guardState.enabled = enabled;
  saveGuardConfig();
}

export function getAllowedIps(): string[] {
  return guardState.allowedIps;
}

export function addAllowedIp(ip: string): boolean {
  if (!ip) return false;
  const cleanIp = ip.trim();
  if (!guardState.allowedIps.includes(cleanIp)) {
    guardState.allowedIps.push(cleanIp);
    saveGuardConfig();
    return true;
  }
  return false;
}

export function removeAllowedIp(ip: string): boolean {
  const cleanIp = ip.trim();
  const idx = guardState.allowedIps.indexOf(cleanIp);
  if (idx !== -1) {
    guardState.allowedIps.splice(idx, 1);
    saveGuardConfig();
    return true;
  }
  return false;
}

export function ipGuardMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!guardState.enabled) {
    return next();
  }

  if (req.path.startsWith('/api/guard')) {
    return next();
  }

  const clientIp = getClientIp(req);
  if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === 'localhost') {
    return next();
  }

  const isAllowed = guardState.allowedIps.some((allowed) => {
    return allowed === clientIp || clientIp.includes(allowed) || allowed.includes(clientIp);
  });

  if (isAllowed) {
    return next();
  }

  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(403).json({
      error: '403 Forbidden: Hệ thống đang trong Chế Độ Kiểm Thử Riêng Tư. Vui lòng mở khóa IP.'
    });
  }

  // Trang HTML 403 ĐẲNG CẤP CÓ Ô NHẬP MẬT KHẨU & NÚT MỞ KHÓA TRỰC TIẾP
  return res.status(403).send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>403 - Kiểm Thử Riêng Tư</title>
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          padding: 15px;
          background: #0b0b0e;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
        }
        .box {
          background: rgba(18, 18, 24, 0.95);
          border: 1px solid rgba(225, 29, 72, 0.35);
          border-radius: 24px;
          padding: 35px 25px;
          max-width: 440px;
          width: 100%;
          text-align: center;
          box-shadow: 0 25px 60px rgba(0,0,0,0.9), 0 0 35px rgba(225, 29, 72, 0.2);
        }
        .icon { font-size: 52px; margin-bottom: 10px; }
        h1 { margin: 0 0 8px; font-size: 22px; color: #fff; font-weight: 800; letter-spacing: 0.5px; }
        p { color: #94a3b8; font-size: 13px; line-height: 1.5; margin: 10px 0; }
        .badge {
          display: inline-block;
          background: rgba(225, 29, 72, 0.15);
          color: #fda4af;
          padding: 6px 14px;
          border-radius: 12px;
          font-family: monospace;
          font-size: 13px;
          border: 1px solid rgba(225, 29, 72, 0.3);
          margin-bottom: 20px;
        }
        .form-group {
          margin-top: 15px;
          text-align: left;
        }
        label {
          display: block;
          font-size: 11px;
          font-weight: 700;
          color: #cbd5e1;
          margin-bottom: 6px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        input[type="password"], input[type="text"] {
          width: 100%;
          padding: 12px 14px;
          background: #060608;
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 14px;
          color: #fff;
          font-size: 14px;
          outline: none;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        input:focus {
          border-color: #f43f5e;
          box-shadow: 0 0 0 3px rgba(244, 63, 94, 0.25);
        }
        .btn-unlock {
          width: 100%;
          margin-top: 16px;
          padding: 13px;
          background: linear-gradient(135deg, #e11d48, #be123c);
          color: #fff;
          border: none;
          border-radius: 14px;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.2s;
          box-shadow: 0 8px 20px rgba(225, 29, 72, 0.35);
        }
        .btn-unlock:hover {
          background: linear-gradient(135deg, #f43f5e, #e11d48);
          transform: translateY(-1px);
        }
        .btn-unlock:active { transform: translateY(1px); }
        .msg {
          margin-top: 15px;
          font-size: 13px;
          font-weight: 600;
          padding: 10px;
          border-radius: 10px;
          display: none;
        }
        .msg-error {
          display: block;
          background: rgba(239, 68, 68, 0.2);
          color: #fca5a5;
          border: 1px solid rgba(239, 68, 68, 0.3);
        }
        .msg-success {
          display: block;
          background: rgba(34, 197, 94, 0.2);
          color: #86efac;
          border: 1px solid rgba(34, 197, 94, 0.3);
        }
      </style>
    </head>
    <body>
      <div class="box">
        <div class="icon">🔒</div>
        <h1>KIỂM THỬ RIÊNG TƯ</h1>
        <p>Hệ thống hiện đang khóa người ngoài để test nội bộ.</p>
        <div class="badge">IP của bạn: ${clientIp}</div>

        <form id="unlockForm" onsubmit="handleUnlock(event)">
          <div class="form-group">
            <label for="secretKey">Nhập mã bí mật để mở khóa IP:</label>
            <input type="password" id="secretKey" placeholder="Nhập mã mở khóa bí mật" required autofocus />
          </div>
          <button type="submit" id="submitBtn" class="btn-unlock">🔓 MỞ KHÓA TRUY CẬP</button>
        </form>

        <div id="statusMsg" class="msg"></div>
      </div>

      <script>
        async function handleUnlock(e) {
          e.preventDefault();
          var input = document.getElementById('secretKey');
          var btn = document.getElementById('submitBtn');
          var msg = document.getElementById('statusMsg');
          var key = input.value.trim();

          if (!key) return;

          btn.disabled = true;
          btn.innerText = 'Đang mở khóa...';
          msg.className = 'msg';
          msg.style.display = 'none';

          try {
            var res = await fetch('/api/guard/unlock-ajax', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: key })
            });
            var data = await res.json();

            if (res.ok && data.success) {
              msg.className = 'msg msg-success';
              msg.innerText = '✅ ' + data.message + ' Đang vào hệ thống...';
              msg.style.display = 'block';
              setTimeout(function() {
                window.location.reload();
              }, 1200);
            } else {
              msg.className = 'msg msg-error';
              msg.innerText = '❌ ' + (data.error || 'Mã không đúng, vui lòng thử lại.');
              msg.style.display = 'block';
              btn.disabled = false;
              btn.innerText = '🔓 MỞ KHÓA TRUY CẬP';
              input.focus();
            }
          } catch (err) {
            msg.className = 'msg msg-error';
            msg.innerText = '❌ Lỗi kết nối máy chủ. Thử lại!';
            msg.style.display = 'block';
            btn.disabled = false;
            btn.innerText = '🔓 MỞ KHÓA TRUY CẬP';
          }
        }
      </script>
    </body>
    </html>
  `);
}
