import { Router, Request, Response } from 'express';
import {
  VALID_KEYS,
  SECRET_KEY,
  getClientIp,
  isGuardEnabled,
  setGuardEnabled,
  getAllowedIps,
  addAllowedIp,
  removeAllowedIp
} from '../middleware/ipGuard';
import { authMiddleware, AuthRequest } from './auth';

export const guardRouter = Router();

/**
 * 1. MỞ KHÓA IP TRỰC TIẾP TỪ FORM (AJAX):
 * POST /api/guard/unlock-ajax
 */
guardRouter.post('/unlock-ajax', (req: Request, res: Response) => {
  const { key } = req.body;
  const trimmedKey = (key || '').trim();

  if (!trimmedKey || !VALID_KEYS.includes(trimmedKey)) {
    return res.status(403).json({
      success: false,
      error: 'Mã bí mật không chính xác. Vui lòng kiểm tra lại.'
    });
  }

  const clientIp = getClientIp(req);
  addAllowedIp(clientIp);

  return res.json({
    success: true,
    message: `Đã mở khóa IP (${clientIp}) thành công!`,
    ip: clientIp
  });
});

/**
 * 2. MỞ KHÓA IP BẰNG LINK URL (GET):
 * GET /api/guard/unlock?key=RedlineSecret2026
 */
guardRouter.get('/unlock', (req: Request, res: Response) => {
  const key = ((req.query.key as string) || '').trim();
  if (!VALID_KEYS.includes(key)) {
    return res.status(403).send(`
      <body style="background:#0b0b0e;color:#ef4444;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
        <div style="text-align:center;">
          <h1>❌ Khóa bí mật không chính xác</h1>
          <p>Yêu cầu bị từ chối.</p>
        </div>
      </body>
    `);
  }

  const clientIp = getClientIp(req);
  addAllowedIp(clientIp);

  return res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="refresh" content="2;url=/">
      <title>Mở Khóa IP Thành Công</title>
      <style>
        body {
          margin: 0;
          background: #0b0b0e;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
        }
        .card {
          background: rgba(24, 24, 32, 0.95);
          border: 1px solid rgba(34, 197, 94, 0.4);
          border-radius: 24px;
          padding: 40px;
          max-width: 480px;
          text-align: center;
          box-shadow: 0 20px 50px rgba(0,0,0,0.9), 0 0 35px rgba(34, 197, 94, 0.2);
        }
        .icon { font-size: 54px; margin-bottom: 12px; }
        h1 { margin: 0 0 8px; font-size: 24px; color: #4ade80; font-weight: 800; }
        p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin: 12px 0; }
        .ip-pill {
          display: inline-block;
          background: rgba(34, 197, 94, 0.15);
          color: #86efac;
          border: 1px solid rgba(34, 197, 94, 0.3);
          padding: 8px 18px;
          border-radius: 14px;
          font-family: monospace;
          font-size: 15px;
          font-weight: bold;
        }
        .btn {
          display: inline-block;
          margin-top: 25px;
          background: linear-gradient(135deg, #22c55e, #16a34a);
          color: #fff;
          text-decoration: none;
          padding: 12px 30px;
          border-radius: 14px;
          font-weight: bold;
          font-size: 14px;
          box-shadow: 0 10px 20px rgba(34, 197, 94, 0.3);
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">🔓</div>
        <h1>MỞ KHÓA IP THÀNH CÔNG!</h1>
        <p>Thiết bị của bạn đã được thêm vào danh sách kiểm thử:</p>
        <div class="ip-pill">${clientIp}</div>
        <p style="font-size: 12px; color: #64748b; margin-top: 20px;">
          Đang tự động chuyển hướng vào hệ thống trong 2 giây...
        </p>
        <a href="/" class="btn">TRUY CẬP HỆ THỐNG NGAY</a>
      </div>
    </body>
    </html>
  `);
});

/**
 * 3. BẬT CHẾ ĐỘ KIỂM THỬ:
 * GET /api/guard/enable?key=RedlineSecret2026
 */
guardRouter.get('/enable', (req: Request, res: Response) => {
  const key = req.query.key as string;
  if (!VALID_KEYS.includes(key)) return res.status(403).json({ error: 'Sai secret key' });
  setGuardEnabled(true);
  res.json({ success: true, message: 'Đã BẬT Chế Độ Kiểm Thử Riêng Tư. Mọi IP lạ sẽ bị chặn.', enabled: true });
});

/**
 * 4. TẮT CHẾ ĐỘ KIỂM THỬ:
 * GET /api/guard/disable?key=RedlineSecret2026
 */
guardRouter.get('/disable', (req: Request, res: Response) => {
  const key = req.query.key as string;
  if (!VALID_KEYS.includes(key)) return res.status(403).json({ error: 'Sai secret key' });
  setGuardEnabled(false);
  res.json({ success: true, message: 'Đã TẮT Chế Độ Kiểm Thử. Hệ thống mở tự do cho mọi IP.', enabled: false });
});

/**
 * 5. XEM TRẠNG THÁI:
 * GET /api/guard/status?key=RedlineSecret2026
 */
guardRouter.get('/status', (req: Request, res: Response) => {
  const key = req.query.key as string;
  if (!VALID_KEYS.includes(key)) return res.status(403).json({ error: 'Sai secret key' });
  res.json({
    enabled: isGuardEnabled(),
    allowedIps: getAllowedIps(),
    clientIp: getClientIp(req)
  });
});

/**
 * 6. API ADMIN TOGGLE:
 * POST /api/guard/admin/toggle
 */
guardRouter.post('/admin/toggle', authMiddleware, (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Chỉ Admin mới có quyền.' });
  }

  const { enabled } = req.body;
  const newState = typeof enabled === 'boolean' ? enabled : !isGuardEnabled();
  setGuardEnabled(newState);

  const adminIp = getClientIp(req);
  addAllowedIp(adminIp);

  res.json({
    success: true,
    enabled: isGuardEnabled(),
    allowedIps: getAllowedIps(),
    message: isGuardEnabled()
      ? 'Đã BẬT Chế Độ Kiểm Thử Riêng Tư.'
      : 'Đã TẮT Chế Độ Kiểm Thử.'
  });
});
