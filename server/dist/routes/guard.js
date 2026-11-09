"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.guardRouter = void 0;
const express_1 = require("express");
const ipGuard_1 = require("../middleware/ipGuard");
const auth_1 = require("./auth");
exports.guardRouter = (0, express_1.Router)();
/**
 * 1. MỞ KHÓA IP BẰNG LINK BÍ MẬT:
 * GET /api/guard/unlock?key=RedlineSecret2026
 */
exports.guardRouter.get('/unlock', (req, res) => {
    const key = req.query.key;
    if (key !== ipGuard_1.SECRET_KEY) {
        return res.status(403).send(`
      <body style="background:#0b0b0e;color:#ef4444;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
        <div style="text-align:center;">
          <h1>❌ Khóa bí mật không chính xác</h1>
          <p>Yêu cầu bị từ chối.</p>
        </div>
      </body>
    `);
    }
    const clientIp = (0, ipGuard_1.getClientIp)(req);
    (0, ipGuard_1.addAllowedIp)(clientIp);
    return res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="refresh" content="3;url=/">
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
          transition: transform 0.2s;
        }
        .btn:hover { transform: scale(1.03); }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">🔓</div>
        <h1>MỞ KHÓA IP THÀNH CÔNG!</h1>
        <p>Thiết bị của bạn đã được thêm vào danh sách kiểm thử đặc quyền:</p>
        <div class="ip-pill">${clientIp}</div>
        <p style="font-size: 12px; color: #64748b; margin-top: 20px;">
          Đang tự động chuyển hướng vào hệ thống trong 3 giây...
        </p>
        <a href="/" class="btn">TRUY CẬP HỆ THỐNG NGAY</a>
      </div>
    </body>
    </html>
  `);
});
/**
 * 2. BẬT CHẾ ĐỘ KIỂM THỬ:
 * GET /api/guard/enable?key=RedlineSecret2026
 */
exports.guardRouter.get('/enable', (req, res) => {
    const key = req.query.key;
    if (key !== ipGuard_1.SECRET_KEY)
        return res.status(403).json({ error: 'Sai secret key' });
    (0, ipGuard_1.setGuardEnabled)(true);
    res.json({ success: true, message: 'Đã BẬT Chế Độ Kiểm Thử Riêng Tư. Mọi IP lạ sẽ bị chặn.', enabled: true });
});
/**
 * 3. TẮT CHẾ ĐỘ KIỂM THỬ (Mở cho tất cả):
 * GET /api/guard/disable?key=RedlineSecret2026
 */
exports.guardRouter.get('/disable', (req, res) => {
    const key = req.query.key;
    if (key !== ipGuard_1.SECRET_KEY)
        return res.status(403).json({ error: 'Sai secret key' });
    (0, ipGuard_1.setGuardEnabled)(false);
    res.json({ success: true, message: 'Đã TẮT Chế Độ Kiểm Thử. Hệ thống mở tự do cho mọi IP.', enabled: false });
});
/**
 * 4. XEM TRẠNG THÁI:
 * GET /api/guard/status?key=RedlineSecret2026
 */
exports.guardRouter.get('/status', (req, res) => {
    const key = req.query.key;
    if (key !== ipGuard_1.SECRET_KEY)
        return res.status(403).json({ error: 'Sai secret key' });
    res.json({
        enabled: (0, ipGuard_1.isGuardEnabled)(),
        allowedIps: (0, ipGuard_1.getAllowedIps)(),
        clientIp: (0, ipGuard_1.getClientIp)(req)
    });
});
/**
 * 5. API QUẢN TRỊ ADMIN (Dành cho công tắc trên Dashboard):
 * POST /api/guard/admin/toggle
 */
exports.guardRouter.post('/admin/toggle', auth_1.authMiddleware, (req, res) => {
    if (req.user?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Chỉ Admin mới có quyền bật tắt chế độ kiểm thử.' });
    }
    const { enabled } = req.body;
    const newState = typeof enabled === 'boolean' ? enabled : !(0, ipGuard_1.isGuardEnabled)();
    (0, ipGuard_1.setGuardEnabled)(newState);
    // Tự động whitelist luôn IP của Admin đang thực hiện thao tác
    const adminIp = (0, ipGuard_1.getClientIp)(req);
    (0, ipGuard_1.addAllowedIp)(adminIp);
    res.json({
        success: true,
        enabled: (0, ipGuard_1.isGuardEnabled)(),
        allowedIps: (0, ipGuard_1.getAllowedIps)(),
        message: (0, ipGuard_1.isGuardEnabled)()
            ? 'Đã BẬT Chế Độ Kiểm Thử Riêng Tư. Người ngoài sẽ bị chặn.'
            : 'Đã TẮT Chế Độ Kiểm Thử. Mọi IP đều có thể truy cập.'
    });
});
/**
 * 6. XÓA 1 IP KHỎI WHITELIST:
 * POST /api/guard/admin/remove-ip
 */
exports.guardRouter.post('/admin/remove-ip', auth_1.authMiddleware, (req, res) => {
    if (req.user?.role !== 'ADMIN')
        return res.status(403).json({ error: 'Chỉ Admin mới có quyền.' });
    const { ip } = req.body;
    (0, ipGuard_1.removeAllowedIp)(ip);
    res.json({ success: true, allowedIps: (0, ipGuard_1.getAllowedIps)() });
});
