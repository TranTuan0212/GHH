"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SECRET_KEY = void 0;
exports.saveGuardConfig = saveGuardConfig;
exports.getClientIp = getClientIp;
exports.isGuardEnabled = isGuardEnabled;
exports.setGuardEnabled = setGuardEnabled;
exports.getAllowedIps = getAllowedIps;
exports.addAllowedIp = addAllowedIp;
exports.removeAllowedIp = removeAllowedIp;
exports.ipGuardMiddleware = ipGuardMiddleware;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const GUARD_CONFIG_FILE = path_1.default.join(__dirname, '../../data/guard_config.json');
exports.SECRET_KEY = 'RedlineSecret2026';
// Trạng thái mặc định: BẬT chế độ kiểm thử riêng tư
let guardState = {
    enabled: true,
    allowedIps: ['127.0.0.1', '::1', 'localhost']
};
// Tải cấu hình từ đĩa nếu có
function loadGuardConfig() {
    try {
        if (fs_1.default.existsSync(GUARD_CONFIG_FILE)) {
            const raw = fs_1.default.readFileSync(GUARD_CONFIG_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            guardState = {
                enabled: parsed.enabled ?? true,
                allowedIps: Array.isArray(parsed.allowedIps) ? parsed.allowedIps : ['127.0.0.1', '::1']
            };
        }
    }
    catch (err) {
        console.error('[IPGuard] Lỗi khi đọc guard_config.json:', err);
    }
}
// Lưu cấu hình xuống đĩa
function saveGuardConfig() {
    try {
        const dir = path_1.default.dirname(GUARD_CONFIG_FILE);
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        fs_1.default.writeFileSync(GUARD_CONFIG_FILE, JSON.stringify(guardState, null, 2), 'utf8');
    }
    catch (err) {
        console.error('[IPGuard] Lỗi khi lưu guard_config.json:', err);
    }
}
loadGuardConfig();
/**
 * Lấy IP thực của Client (Hỗ trợ Cloudflare, Nginx, Proxy)
 */
function getClientIp(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp)
        return cfIp.trim();
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const firstIp = forwarded.split(',')[0].trim();
        if (firstIp)
            return firstIp;
    }
    const realIp = req.headers['x-real-ip'];
    if (realIp)
        return realIp.trim();
    const remote = req.socket.remoteAddress || req.ip || '';
    return remote.replace(/^.*:/, ''); // Chuyển ::ffff:192.168.1.1 -> 192.168.1.1
}
function isGuardEnabled() {
    return guardState.enabled;
}
function setGuardEnabled(enabled) {
    guardState.enabled = enabled;
    saveGuardConfig();
}
function getAllowedIps() {
    return guardState.allowedIps;
}
function addAllowedIp(ip) {
    if (!ip)
        return false;
    const cleanIp = ip.trim();
    if (!guardState.allowedIps.includes(cleanIp)) {
        guardState.allowedIps.push(cleanIp);
        saveGuardConfig();
        return true;
    }
    return false;
}
function removeAllowedIp(ip) {
    const cleanIp = ip.trim();
    const idx = guardState.allowedIps.indexOf(cleanIp);
    if (idx !== -1) {
        guardState.allowedIps.splice(idx, 1);
        saveGuardConfig();
        return true;
    }
    return false;
}
/**
 * Middleware chặn các IP lạ khi chế độ kiểm thử BẬT
 */
function ipGuardMiddleware(req, res, next) {
    // Nếu tắt chế độ kiểm thử -> cho qua tất cả
    if (!guardState.enabled) {
        return next();
    }
    // Luôn cho phép các đường dẫn liên quan đến guard mở khóa
    if (req.path.startsWith('/api/guard')) {
        return next();
    }
    // Luôn cho phép static assets cần thiết hoặc localhost
    const clientIp = getClientIp(req);
    if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === 'localhost') {
        return next();
    }
    // Kiểm tra IP có trong Whitelist không
    const isAllowed = guardState.allowedIps.some((allowed) => {
        return allowed === clientIp || clientIp.includes(allowed) || allowed.includes(clientIp);
    });
    if (isAllowed) {
        return next();
    }
    // Nếu không được phép -> Chặn 403
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(403).json({
            error: '403 Forbidden: Hệ thống đang trong Chế Độ Kiểm Thử Riêng Tư. IP của bạn chưa được cấp phép.'
        });
    }
    return res.status(403).send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>403 - Kiểm Thử Riêng Tư</title>
      <style>
        body {
          margin: 0;
          padding: 0;
          background: #0b0b0e;
          color: #f43f5e;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
        }
        .box {
          background: rgba(20, 20, 28, 0.9);
          border: 1px solid rgba(244, 63, 94, 0.3);
          border-radius: 20px;
          padding: 40px;
          max-width: 460px;
          text-align: center;
          box-shadow: 0 20px 40px rgba(0,0,0,0.8), 0 0 30px rgba(244, 63, 94, 0.15);
        }
        h1 { margin: 0 0 10px; font-size: 26px; color: #fff; font-weight: 800; }
        p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin: 15px 0; }
        .badge {
          display: inline-block;
          background: rgba(244, 63, 94, 0.15);
          color: #fda4af;
          padding: 6px 14px;
          border-radius: 12px;
          font-family: monospace;
          font-size: 13px;
          border: 1px solid rgba(244, 63, 94, 0.3);
        }
      </style>
    </head>
    <body>
      <div class="box">
        <div style="font-size: 48px; margin-bottom: 10px;">🔒</div>
        <h1>CHẾ ĐỘ KIỂM THỬ RIÊNG TƯ</h1>
        <p>Hệ thống hiện đang khóa quyền truy cập ngoài để phục vụ kiểm thử nội bộ.</p>
        <p>Địa chỉ IP của bạn:</p>
        <div class="badge">${clientIp}</div>
        <p style="font-size: 12px; color: #64748b; margin-top: 25px;">
          Nếu bạn là quản trị viên, vui lòng truy cập đường dẫn bí mật để mở khóa IP thiết bị này.
        </p>
      </div>
    </body>
    </html>
  `);
}
