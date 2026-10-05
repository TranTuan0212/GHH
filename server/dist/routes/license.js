"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.licenseRouter = void 0;
const express_1 = require("express");
const db_1 = require("../db");
const auth_1 = require("./auth");
const cryptoLicense_1 = require("../utils/cryptoLicense");
exports.licenseRouter = (0, express_1.Router)();
// Anti-brute-force cache: Map<Key/IP, { count: number; lockedUntil: number }>
const bruteForceMap = new Map();
function checkRateLimit(identifier) {
    const now = Date.now();
    const entry = bruteForceMap.get(identifier);
    if (!entry)
        return { allowed: true };
    if (entry.lockedUntil > now) {
        return { allowed: false, remainingSec: Math.ceil((entry.lockedUntil - now) / 1000) };
    }
    // Khóa đã hết hạn, reset lại
    if (entry.lockedUntil > 0 && entry.lockedUntil <= now) {
        bruteForceMap.delete(identifier);
        return { allowed: true };
    }
    return { allowed: true };
}
function recordFailedAttempt(identifier) {
    const now = Date.now();
    const entry = bruteForceMap.get(identifier) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= 5) {
        // Khóa 15 phút nếu thử sai quá 5 lần
        entry.lockedUntil = now + 15 * 60 * 1000;
    }
    bruteForceMap.set(identifier, entry);
}
function clearFailedAttempt(identifier) {
    bruteForceMap.delete(identifier);
}
/**
 * POST /api/license/activate
 * Kích hoạt bản quyền giọng nói lần đầu (cần mạng).
 * Sau khi kích hoạt thành công, server trả về License Token được ký số để app dùng Offline 100%.
 */
exports.licenseRouter.post('/activate', (req, res) => {
    const { licenseKey, deviceFingerprint, deviceModel } = req.body;
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (!licenseKey || !deviceFingerprint) {
        return res.status(400).json({ error: 'Vui lòng cung cấp licenseKey và deviceFingerprint.' });
    }
    const normFp = (0, cryptoLicense_1.normalizeFingerprint)(deviceFingerprint);
    const normKey = licenseKey.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    // 1. Kiểm tra cấu trúc mã máy và Checksum bảo vệ
    if (!(0, cryptoLicense_1.verifyDeviceFingerprint)(normFp)) {
        return res.status(400).json({
            error: 'Mã định danh máy (deviceFingerprint) không hợp lệ hoặc sai checksum.'
        });
    }
    // 2. Chống Brute-force / Dò đoán key
    const rateLimitCheck = checkRateLimit(`${clientIp}_${normFp}`);
    if (!rateLimitCheck.allowed) {
        return res.status(429).json({
            error: `Thiết bị tạm thời bị khóa do nhập sai quá 5 lần. Vui lòng thử lại sau ${rateLimitCheck.remainingSec} giây.`
        });
    }
    // 3. Tìm key trong DB
    const existingLicense = db_1.db.getVoiceLicenseByKey(normKey);
    if (!existingLicense) {
        recordFailedAttempt(`${clientIp}_${normFp}`);
        return res.status(400).json({ error: 'Mã Key kích hoạt không tồn tại trên hệ thống.' });
    }
    // 4. Kiểm tra Key có khớp với đúng mã máy này không
    if ((0, cryptoLicense_1.normalizeFingerprint)(existingLicense.deviceFingerprint) !== normFp) {
        recordFailedAttempt(`${clientIp}_${normFp}`);
        return res.status(403).json({
            error: 'Key này được cấp riêng cho thiết bị khác, không khớp với máy này!'
        });
    }
    // 5. Kiểm tra thời hạn nếu Key này đã từng kích hoạt trước đó trên chính máy này
    if (existingLicense.isUsed && existingLicense.activatedAt) {
        const isExpired = !existingLicense.isLifetime && new Date(existingLicense.expiresAt) < new Date();
        if (isExpired) {
            return res.status(403).json({
                error: `Key bản quyền của thiết bị này đã hết hạn vào ngày ${new Date(existingLicense.expiresAt).toLocaleDateString('vi-VN')}. Vui lòng liên hệ Admin để gia hạn!`
            });
        }
    }
    try {
        const wasAlreadyUsed = existingLicense.isUsed;
        const activated = db_1.db.activateVoiceLicense(normKey, normFp, deviceModel);
        clearFailedAttempt(`${clientIp}_${normFp}`);
        // Đồng bộ trạng thái mở khóa sang danh sách thiết bị
        db_1.db.unlockDeviceVoice(normFp, activated.licenseKey);
        // Tạo Offline License Token có chữ ký số bí mật
        const licenseToken = (0, cryptoLicense_1.generateOfflineLicenseToken)(normFp, activated.registeredAt, activated.expiresAt, activated.isLifetime);
        return res.json({
            success: true,
            message: wasAlreadyUsed ? 'Khôi phục bản quyền giọng nói thành công!' : 'Kích hoạt bản quyền giọng nói thành công!',
            licenseToken,
            registeredAt: activated.registeredAt,
            expiresAt: activated.expiresAt,
            isLifetime: activated.isLifetime,
            deviceModel: activated.deviceModel,
            deviceFingerprint: activated.deviceFingerprint
        });
    }
    catch (err) {
        return res.status(500).json({ error: err.message || 'Lỗi trong quá trình kích hoạt.' });
    }
});
/**
 * POST /api/license/renew
 * Gia hạn thời hạn bản quyền giọng nói (cần mạng khi nạp key gia hạn).
 * Tự động cộng dồn thời gian vào hạn hiện tại.
 */
exports.licenseRouter.post('/renew', (req, res) => {
    const { renewKey, deviceFingerprint } = req.body;
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (!renewKey || !deviceFingerprint) {
        return res.status(400).json({ error: 'Vui lòng cung cấp renewKey và deviceFingerprint.' });
    }
    const normFp = (0, cryptoLicense_1.normalizeFingerprint)(deviceFingerprint);
    const normKey = renewKey.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!(0, cryptoLicense_1.verifyDeviceFingerprint)(normFp)) {
        return res.status(400).json({ error: 'Mã định danh máy không hợp lệ.' });
    }
    const rateLimitCheck = checkRateLimit(`${clientIp}_${normFp}`);
    if (!rateLimitCheck.allowed) {
        return res.status(429).json({
            error: `Thiết bị tạm thời bị khóa do nhập sai quá 5 lần. Thử lại sau ${rateLimitCheck.remainingSec} giây.`
        });
    }
    const keyDoc = db_1.db.getVoiceLicenseByKey(normKey);
    if (!keyDoc) {
        recordFailedAttempt(`${clientIp}_${normFp}`);
        return res.status(400).json({ error: 'Mã Key gia hạn không tồn tại trên hệ thống.' });
    }
    if ((0, cryptoLicense_1.normalizeFingerprint)(keyDoc.deviceFingerprint) !== normFp) {
        recordFailedAttempt(`${clientIp}_${normFp}`);
        return res.status(403).json({ error: 'Key gia hạn này không khớp với thiết bị này!' });
    }
    if (keyDoc.isUsed) {
        return res.status(409).json({ error: 'Key gia hạn này đã được sử dụng trước đó!' });
    }
    // Xác định số ngày cần cộng thêm
    let addedDays = 30;
    if (keyDoc.isLifetime) {
        addedDays = 'LIFETIME';
    }
    else {
        // Tính diff ngày giữa registeredAt và expiresAt của keyDoc
        const start = new Date(keyDoc.registeredAt).getTime();
        const end = new Date(keyDoc.expiresAt).getTime();
        const days = Math.round((end - start) / (24 * 3600 * 1000));
        addedDays = days > 0 ? days : 30;
    }
    try {
        const renewed = db_1.db.renewVoiceLicense(normKey, normFp, addedDays);
        keyDoc.isUsed = true;
        keyDoc.activatedAt = new Date().toISOString();
        clearFailedAttempt(`${clientIp}_${normFp}`);
        const newLicenseToken = (0, cryptoLicense_1.generateOfflineLicenseToken)(normFp, renewed.registeredAt, renewed.expiresAt, renewed.isLifetime);
        return res.json({
            success: true,
            message: `Gia hạn thành công! Hạn mới: ${renewed.isLifetime ? 'Vĩnh viễn' : new Date(renewed.expiresAt).toLocaleString('vi-VN')}`,
            licenseToken: newLicenseToken,
            registeredAt: renewed.registeredAt,
            expiresAt: renewed.expiresAt,
            isLifetime: renewed.isLifetime
        });
    }
    catch (err) {
        return res.status(500).json({ error: err.message || 'Lỗi trong quá trình gia hạn.' });
    }
});
/**
 * GET /api/license/status/:deviceFingerprint
 * Kiểm tra trạng thái bản quyền của máy trên server
 */
exports.licenseRouter.get('/status/:deviceFingerprint', (req, res) => {
    const normFp = (0, cryptoLicense_1.normalizeFingerprint)(req.params.deviceFingerprint);
    const lic = db_1.db.getVoiceLicenseByDevice(normFp);
    if (!lic) {
        return res.json({ registered: false, message: 'Chưa đăng ký trên hệ thống.' });
    }
    const now = new Date();
    const expiresAt = new Date(lic.expiresAt);
    const isExpired = !lic.isLifetime && expiresAt < now;
    return res.json({
        registered: true,
        isUsed: lic.isUsed,
        activatedAt: lic.activatedAt,
        registeredAt: lic.registeredAt,
        expiresAt: lic.expiresAt,
        isLifetime: lic.isLifetime,
        isExpired,
        deviceModel: lic.deviceModel
    });
});
// ================= ADMIN ENDPOINTS =================
exports.licenseRouter.use('/admin', auth_1.adminMiddleware);
/**
 * POST /api/license/admin/generate
 * Admin tạo Key mở giọng nói cho 1 máy cụ thể
 */
exports.licenseRouter.post('/admin/generate', (req, res) => {
    const { deviceFingerprint, daysValid, deviceModel, note } = req.body;
    if (!deviceFingerprint) {
        return res.status(400).json({ error: 'Mã định danh máy (deviceFingerprint) là bắt buộc.' });
    }
    const normFp = (0, cryptoLicense_1.normalizeFingerprint)(deviceFingerprint);
    if (!(0, cryptoLicense_1.verifyDeviceFingerprint)(normFp)) {
        return res.status(400).json({
            error: 'Mã định danh máy không đúng định dạng hoặc sai mã kiểm tra Checksum. Vui lòng kiểm tra lại!'
        });
    }
    const isLifetime = daysValid === -1 || daysValid === 'LIFETIME';
    const duration = isLifetime ? 'LIFETIME' : (parseInt(daysValid) || 30);
    // Sinh Key bảo mật không thể đoán mò bằng HMAC-SHA256
    const licenseKey = (0, cryptoLicense_1.generateVoiceLicenseKey)(normFp, duration);
    const now = new Date();
    const expiresAt = isLifetime
        ? new Date(now.getTime() + 100 * 365 * 24 * 3600 * 1000).toISOString()
        : new Date(now.getTime() + duration * 24 * 3600 * 1000).toISOString();
    const newLic = {
        id: 'lic-' + Date.now(),
        deviceFingerprint: normFp,
        deviceModel: deviceModel || 'iOS Device',
        licenseKey,
        registeredAt: now.toISOString(),
        expiresAt,
        isLifetime,
        isUsed: false
    };
    db_1.db.createVoiceLicense(newLic);
    return res.status(201).json({
        message: 'Tạo Key kích hoạt giọng nói thành công!',
        licenseKey,
        deviceFingerprint: normFp,
        deviceModel: newLic.deviceModel,
        durationDays: duration,
        expiresAt: newLic.expiresAt,
        isLifetime
    });
});
/**
 * GET /api/license/admin/list
 * Admin lấy toàn bộ danh sách License Key và máy đã kích hoạt
 */
exports.licenseRouter.get('/admin/list', (req, res) => {
    const licenses = db_1.db.getAllVoiceLicenses().map(l => {
        const isExpired = !l.isLifetime && new Date(l.expiresAt) < new Date();
        return {
            ...l,
            isExpired,
            status: !l.isUsed ? 'CHƯA_KÍCH_HOẠT' : (isExpired ? 'HẾT_HẠN' : 'HOẠT_ĐỘNG')
        };
    });
    return res.json({ licenses });
});
/**
 * DELETE /api/license/admin/:id
 * Admin xóa bỏ Key hoặc thu hồi bản quyền
 */
exports.licenseRouter.delete('/admin/:id', (req, res) => {
    const deleted = db_1.db.deleteVoiceLicense(req.params.id);
    if (!deleted) {
        return res.status(404).json({ error: 'Không tìm thấy License để xóa.' });
    }
    return res.json({ message: 'Đã xóa bản quyền thành công.' });
});
