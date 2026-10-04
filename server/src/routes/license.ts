import { Router, Request, Response } from 'express';
import { db, VoiceLicense } from '../db';
import { adminMiddleware, AuthRequest } from './auth';
import {
  generateVoiceLicenseKey,
  generateOfflineLicenseToken,
  verifyDeviceFingerprint,
  normalizeFingerprint
} from '../utils/cryptoLicense';

export const licenseRouter = Router();

// Anti-brute-force cache: Map<Key/IP, { count: number; lockedUntil: number }>
const bruteForceMap = new Map<string, { count: number; lockedUntil: number }>();

function checkRateLimit(identifier: string): { allowed: boolean; remainingSec?: number } {
  const now = Date.now();
  const entry = bruteForceMap.get(identifier);
  if (!entry) return { allowed: true };

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

function recordFailedAttempt(identifier: string) {
  const now = Date.now();
  const entry = bruteForceMap.get(identifier) || { count: 0, lockedUntil: 0 };
  entry.count += 1;

  if (entry.count >= 5) {
    // Khóa 15 phút nếu thử sai quá 5 lần
    entry.lockedUntil = now + 15 * 60 * 1000;
  }
  bruteForceMap.set(identifier, entry);
}

function clearFailedAttempt(identifier: string) {
  bruteForceMap.delete(identifier);
}

/**
 * POST /api/license/activate
 * Kích hoạt bản quyền giọng nói lần đầu (cần mạng).
 * Sau khi kích hoạt thành công, server trả về License Token được ký số để app dùng Offline 100%.
 */
licenseRouter.post('/activate', (req: Request, res: Response) => {
  const { licenseKey, deviceFingerprint, deviceModel } = req.body;
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

  if (!licenseKey || !deviceFingerprint) {
    return res.status(400).json({ error: 'Vui lòng cung cấp licenseKey và deviceFingerprint.' });
  }

  const normFp = normalizeFingerprint(deviceFingerprint);
  const normKey = licenseKey.trim().toUpperCase().replace(/\s+/g, '');

  // 1. Kiểm tra cấu trúc mã máy và Checksum bảo vệ
  if (!verifyDeviceFingerprint(normFp)) {
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
  const existingLicense = db.getVoiceLicenseByKey(normKey);
  if (!existingLicense) {
    recordFailedAttempt(`${clientIp}_${normFp}`);
    return res.status(400).json({ error: 'Mã Key kích hoạt không tồn tại trên hệ thống.' });
  }

  // 4. Kiểm tra Key có khớp với đúng mã máy này không
  if (normalizeFingerprint(existingLicense.deviceFingerprint) !== normFp) {
    recordFailedAttempt(`${clientIp}_${normFp}`);
    return res.status(403).json({
      error: 'Key này được cấp riêng cho thiết bị khác, không khớp với máy này!'
    });
  }

  // 5. Kiểm tra Key đã được kích hoạt trước đó chưa
  if (existingLicense.isUsed && existingLicense.activatedAt) {
    return res.status(409).json({
      error: `Key này đã được kích hoạt trước đó vào lúc ${new Date(existingLicense.activatedAt).toLocaleString('vi-VN')}!`
    });
  }

  try {
    const activated = db.activateVoiceLicense(normKey, normFp, deviceModel);
    clearFailedAttempt(`${clientIp}_${normFp}`);

    // Tạo Offline License Token có chữ ký số bí mật
    const licenseToken = generateOfflineLicenseToken(
      normFp,
      activated.registeredAt,
      activated.expiresAt,
      activated.isLifetime
    );

    return res.json({
      success: true,
      message: 'Kích hoạt bản quyền giọng nói thành công!',
      licenseToken,
      registeredAt: activated.registeredAt,
      expiresAt: activated.expiresAt,
      isLifetime: activated.isLifetime,
      deviceModel: activated.deviceModel,
      deviceFingerprint: activated.deviceFingerprint
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Lỗi trong quá trình kích hoạt.' });
  }
});

/**
 * POST /api/license/renew
 * Gia hạn thời hạn bản quyền giọng nói (cần mạng khi nạp key gia hạn).
 * Tự động cộng dồn thời gian vào hạn hiện tại.
 */
licenseRouter.post('/renew', (req: Request, res: Response) => {
  const { renewKey, deviceFingerprint } = req.body;
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

  if (!renewKey || !deviceFingerprint) {
    return res.status(400).json({ error: 'Vui lòng cung cấp renewKey và deviceFingerprint.' });
  }

  const normFp = normalizeFingerprint(deviceFingerprint);
  const normKey = renewKey.trim().toUpperCase().replace(/\s+/g, '');

  if (!verifyDeviceFingerprint(normFp)) {
    return res.status(400).json({ error: 'Mã định danh máy không hợp lệ.' });
  }

  const rateLimitCheck = checkRateLimit(`${clientIp}_${normFp}`);
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({
      error: `Thiết bị tạm thời bị khóa do nhập sai quá 5 lần. Thử lại sau ${rateLimitCheck.remainingSec} giây.`
    });
  }

  const keyDoc = db.getVoiceLicenseByKey(normKey);
  if (!keyDoc) {
    recordFailedAttempt(`${clientIp}_${normFp}`);
    return res.status(400).json({ error: 'Mã Key gia hạn không tồn tại trên hệ thống.' });
  }

  if (normalizeFingerprint(keyDoc.deviceFingerprint) !== normFp) {
    recordFailedAttempt(`${clientIp}_${normFp}`);
    return res.status(403).json({ error: 'Key gia hạn này không khớp với thiết bị này!' });
  }

  if (keyDoc.isUsed) {
    return res.status(409).json({ error: 'Key gia hạn này đã được sử dụng trước đó!' });
  }

  // Xác định số ngày cần cộng thêm
  let addedDays: number | 'LIFETIME' = 30;
  if (keyDoc.isLifetime) {
    addedDays = 'LIFETIME';
  } else {
    // Tính diff ngày giữa registeredAt và expiresAt của keyDoc
    const start = new Date(keyDoc.registeredAt).getTime();
    const end = new Date(keyDoc.expiresAt).getTime();
    const days = Math.round((end - start) / (24 * 3600 * 1000));
    addedDays = days > 0 ? days : 30;
  }

  try {
    const renewed = db.renewVoiceLicense(normKey, normFp, addedDays);
    keyDoc.isUsed = true;
    keyDoc.activatedAt = new Date().toISOString();

    clearFailedAttempt(`${clientIp}_${normFp}`);

    const newLicenseToken = generateOfflineLicenseToken(
      normFp,
      renewed.registeredAt,
      renewed.expiresAt,
      renewed.isLifetime
    );

    return res.json({
      success: true,
      message: `Gia hạn thành công! Hạn mới: ${renewed.isLifetime ? 'Vĩnh viễn' : new Date(renewed.expiresAt).toLocaleString('vi-VN')}`,
      licenseToken: newLicenseToken,
      registeredAt: renewed.registeredAt,
      expiresAt: renewed.expiresAt,
      isLifetime: renewed.isLifetime
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Lỗi trong quá trình gia hạn.' });
  }
});

/**
 * GET /api/license/status/:deviceFingerprint
 * Kiểm tra trạng thái bản quyền của máy trên server
 */
licenseRouter.get('/status/:deviceFingerprint', (req: Request, res: Response) => {
  const normFp = normalizeFingerprint(req.params.deviceFingerprint);
  const lic = db.getVoiceLicenseByDevice(normFp);

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
licenseRouter.use('/admin', adminMiddleware);

/**
 * POST /api/license/admin/generate
 * Admin tạo Key mở giọng nói cho 1 máy cụ thể
 */
licenseRouter.post('/admin/generate', (req: AuthRequest, res: Response) => {
  const { deviceFingerprint, daysValid, deviceModel, note } = req.body;

  if (!deviceFingerprint) {
    return res.status(400).json({ error: 'Mã định danh máy (deviceFingerprint) là bắt buộc.' });
  }

  const normFp = normalizeFingerprint(deviceFingerprint);
  if (!verifyDeviceFingerprint(normFp)) {
    return res.status(400).json({
      error: 'Mã định danh máy không đúng định dạng hoặc sai mã kiểm tra Checksum. Vui lòng kiểm tra lại!'
    });
  }

  const isLifetime = daysValid === -1 || daysValid === 'LIFETIME';
  const duration = isLifetime ? 'LIFETIME' : (parseInt(daysValid) || 30);

  // Sinh Key bảo mật không thể đoán mò bằng HMAC-SHA256
  const licenseKey = generateVoiceLicenseKey(normFp, duration);

  const now = new Date();
  const expiresAt = isLifetime
    ? new Date(now.getTime() + 100 * 365 * 24 * 3600 * 1000).toISOString()
    : new Date(now.getTime() + (duration as number) * 24 * 3600 * 1000).toISOString();

  const newLic: VoiceLicense = {
    id: 'lic-' + Date.now(),
    deviceFingerprint: normFp,
    deviceModel: deviceModel || 'iOS Device',
    licenseKey,
    registeredAt: now.toISOString(),
    expiresAt,
    isLifetime,
    isUsed: false
  };

  db.createVoiceLicense(newLic);

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
licenseRouter.get('/admin/list', (req: AuthRequest, res: Response) => {
  const licenses = db.getAllVoiceLicenses().map(l => {
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
licenseRouter.delete('/admin/:id', (req: AuthRequest, res: Response) => {
  const deleted = db.deleteVoiceLicense(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Không tìm thấy License để xóa.' });
  }
  return res.json({ message: 'Đã xóa bản quyền thành công.' });
});
