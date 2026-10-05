"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JWT_SECRET = exports.authRouter = void 0;
exports.authMiddleware = authMiddleware;
exports.adminMiddleware = adminMiddleware;
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = require("../db");
const cryptoLicense_1 = require("../utils/cryptoLicense");
exports.authRouter = (0, express_1.Router)();
// JWT_SECRET BẮT BUỘC lấy từ biến môi trường — không fallback về giá trị mặc định.
// Trước đây hard-code 'SLOMO_240FPS_SECRET_KEY_2026' ngay trong source: bất kỳ ai đọc được
// code (repo, decompile) đều có thể tự ký token giả, kể cả role ADMIN. Server phải fail-fast
// ngay lúc khởi động nếu thiếu secret, thay vì âm thầm chạy với secret yếu/lộ.
if (!process.env.JWT_SECRET) {
    throw new Error('[auth] Thiếu biến môi trường JWT_SECRET. Đặt JWT_SECRET trong .env (xem .env.example) trước khi khởi động server.');
}
exports.JWT_SECRET = process.env.JWT_SECRET;
const authCache = new Map();
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Chưa đăng nhập hoặc thiếu Token xác thực.' });
    }
    const token = authHeader.split(' ')[1];
    const now = Date.now();
    const cached = authCache.get(token);
    if (cached && cached.validUntil > now) {
        req.user = cached.user;
        return next();
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, exports.JWT_SECRET);
        const user = db_1.db.getUserById(decoded.id);
        if (!user) {
            return res.status(401).json({ error: 'Tài khoản không tồn tại.' });
        }
        if (user.isBlocked) {
            return res.status(403).json({ error: 'Tài khoản của bạn đã bị khóa bởi Admin.' });
        }
        if (new Date(user.expiresAt) < new Date()) {
            return res.status(403).json({ error: 'Tài khoản đã hết hạn sử dụng. Vui lòng liên hệ Admin để gia hạn.' });
        }
        req.user = {
            id: user.id,
            username: user.username,
            role: user.role,
            platform: decoded.platform,
            deviceUuid: decoded.deviceUuid
        };
        authCache.set(token, { user: req.user, validUntil: now + 15000 }); // Cache 15 giây
        next();
    }
    catch (err) {
        return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
    }
}
function adminMiddleware(req, res, next) {
    authMiddleware(req, res, () => {
        if (req.user?.role !== 'ADMIN') {
            return res.status(403).json({ error: 'Chỉ Admin mới có quyền truy cập.' });
        }
        next();
    });
}
// POST /api/auth/login
exports.authRouter.post('/login', (req, res) => {
    const { username, password, platform, deviceUuid, deviceModel, appType, deviceFingerprint } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Vui lòng nhập Username và Password.' });
    }
    const user = db_1.db.getUserByUsername(username);
    if (!user) {
        return res.status(400).json({ error: 'Tài khoản hoặc mật khẩu không chính xác.' });
    }
    if (!bcryptjs_1.default.compareSync(password, user.passwordHash)) {
        return res.status(400).json({ error: 'Tài khoản hoặc mật khẩu không chính xác.' });
    }
    if (user.isBlocked) {
        return res.status(403).json({ error: 'Tài khoản của bạn đã bị khóa bởi Admin.' });
    }
    const isExpired = new Date(user.expiresAt) < new Date();
    if (isExpired) {
        return res.status(403).json({ error: 'Tài khoản đã hết hạn sử dụng (' + new Date(user.expiresAt).toLocaleDateString('vi-VN') + '). Vui lòng gia hạn!' });
    }
    let boundDevice = null;
    let licenseToken = null;
    let voiceLicense = null;
    // Phân loại chuẩn xác loại app: APP_LIVE (tối đa 1 máy) vs APP_INPUT (tối đa 2 máy)
    const effectiveAppType = appType === 'APP_INPUT' ? 'APP_INPUT' :
        (appType === 'APP_LIVE' || platform === 'mobile') ? 'APP_LIVE' : null;
    if (effectiveAppType) {
        if (!deviceUuid) {
            return res.status(400).json({ error: 'Thiếu định danh phần cứng thiết bị (deviceUuid).' });
        }
        try {
            boundDevice = db_1.db.bindDevice(user.id, deviceUuid, deviceModel || (effectiveAppType === 'APP_LIVE' ? 'iOS Live Device' : 'iOS Input Device'), effectiveAppType, deviceFingerprint);
            // TỰ ĐỘNG SINH KEY BẢN QUYỀN THEO MÁY KHI ĐĂNG NHẬP (Chờ khách nhập key để kích hoạt)
            if (effectiveAppType === 'APP_INPUT' && deviceFingerprint) {
                voiceLicense = db_1.db.getVoiceLicenseByDevice(deviceFingerprint);
                const now = new Date();
                const userExpires = new Date(user.expiresAt);
                const daysRemaining = Math.max(1, Math.round((userExpires.getTime() - now.getTime()) / (24 * 3600 * 1000)));
                if (!voiceLicense) {
                    // Server TỰ ĐỘNG sinh sẵn Voice Key gán theo mã máy độc bản
                    const autoKey = (0, cryptoLicense_1.generateVoiceLicenseKey)(deviceFingerprint, daysRemaining);
                    voiceLicense = db_1.db.createVoiceLicense({
                        id: 'lic-' + Date.now(),
                        deviceFingerprint,
                        deviceModel: boundDevice.deviceModel,
                        userId: user.id,
                        licenseKey: autoKey,
                        registeredAt: boundDevice.activatedAt || now.toISOString(),
                        expiresAt: user.expiresAt,
                        isLifetime: false,
                        isUsed: false, // Chờ khách nhập key để mở giọng nói
                        activatedAt: undefined
                    });
                    boundDevice.voiceKey = autoKey;
                    boundDevice.voiceUnlocked = false;
                }
                else {
                    // Key đã tồn tại sẵn trên server
                    boundDevice.voiceKey = voiceLicense.licenseKey;
                    voiceLicense.expiresAt = user.expiresAt;
                    if (voiceLicense.isUsed) {
                        // Khách đã kích hoạt key trước đó -> cấp token offline duy trì
                        boundDevice.voiceUnlocked = true;
                        licenseToken = (0, cryptoLicense_1.generateOfflineLicenseToken)(deviceFingerprint, voiceLicense.registeredAt, voiceLicense.expiresAt, voiceLicense.isLifetime);
                    }
                    else {
                        // Khách chưa nhập key -> chưa mở giọng nói
                        boundDevice.voiceUnlocked = false;
                    }
                }
                db_1.db.save();
            }
        }
        catch (err) {
            return res.status(403).json({ error: err.message });
        }
    }
    const token = jsonwebtoken_1.default.sign({
        id: user.id,
        username: user.username,
        role: user.role,
        platform: platform || 'web',
        deviceUuid: deviceUuid || null
    }, exports.JWT_SECRET, { expiresIn: '30d' });
    return res.json({
        token,
        user: {
            id: user.id,
            username: user.username,
            role: user.role,
            expiresAt: user.expiresAt,
            platform: platform || 'web',
            device: boundDevice,
            licenseToken,
            voiceLicense: voiceLicense ? {
                licenseKey: voiceLicense.licenseKey,
                registeredAt: voiceLicense.registeredAt,
                expiresAt: voiceLicense.expiresAt,
                isLifetime: voiceLicense.isLifetime
            } : null
        }
    });
});
// GET /api/auth/me
exports.authRouter.get('/me', authMiddleware, (req, res) => {
    const user = db_1.db.getUserById(req.user.id);
    const devices = db_1.db.getDevicesByUserId(req.user.id);
    res.json({
        user: {
            id: user?.id,
            username: user?.username,
            role: user?.role,
            expiresAt: user?.expiresAt,
            platform: req.user?.platform,
            devices
        }
    });
});
// GET /api/server-info đã được định nghĩa trong index.ts (chi tiết hơn, có connectionType, hints).
// KHÔNG thêm duplicate ở đây.
// POST /api/auth/change-password — user tự đổi mật khẩu của chính mình
exports.authRouter.post('/change-password', authMiddleware, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Vui lòng nhập đầy đủ mật khẩu cũ và mới.' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự.' });
    }
    const user = db_1.db.getUserById(req.user.id);
    if (!user) {
        return res.status(404).json({ error: 'Tài khoản không tồn tại.' });
    }
    if (!bcryptjs_1.default.compareSync(currentPassword, user.passwordHash)) {
        return res.status(400).json({ error: 'Mật khẩu hiện tại không chính xác.' });
    }
    db_1.db.updateUser(user.id, { passwordHash: bcryptjs_1.default.hashSync(newPassword, 10) });
    res.json({ message: 'Đổi mật khẩu thành công! Vui lòng đăng nhập lại.' });
});
