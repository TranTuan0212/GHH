import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db';

export const authRouter = Router();

// JWT_SECRET BẮT BUỘC lấy từ biến môi trường — không fallback về giá trị mặc định.
// Trước đây hard-code 'SLOMO_240FPS_SECRET_KEY_2026' ngay trong source: bất kỳ ai đọc được
// code (repo, decompile) đều có thể tự ký token giả, kể cả role ADMIN. Server phải fail-fast
// ngay lúc khởi động nếu thiếu secret, thay vì âm thầm chạy với secret yếu/lộ.
if (!process.env.JWT_SECRET) {
  throw new Error(
    '[auth] Thiếu biến môi trường JWT_SECRET. Đặt JWT_SECRET trong .env (xem .env.example) trước khi khởi động server.'
  );
}
export const JWT_SECRET: string = process.env.JWT_SECRET;

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    role: 'ADMIN' | 'USER';
    platform: 'mobile' | 'web';
    deviceUuid?: string;
  };
}

const authCache = new Map<string, { user: any; validUntil: number }>();

export function authMiddleware(req: AuthRequest, res: Response, next: Function) {
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
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const user = db.getUserById(decoded.id);

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
  } catch (err) {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
}

export function adminMiddleware(req: AuthRequest, res: Response, next: Function) {
  authMiddleware(req, res, () => {
    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Chỉ Admin mới có quyền truy cập.' });
    }
    next();
  });
}

// POST /api/auth/login
authRouter.post('/login', (req: Request, res: Response) => {
  const { username, password, platform, deviceUuid, deviceModel } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập Username và Password.' });
  }

  const user = db.getUserByUsername(username);
  if (!user) {
    return res.status(400).json({ error: 'Tài khoản hoặc mật khẩu không chính xác.' });
  }

  if (!bcrypt.compareSync(password, user.passwordHash)) {
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

  // Requirement 8a: Single mobile device binding for Live Streaming
  if (platform === 'mobile') {
    if (!deviceUuid) {
      return res.status(400).json({ error: 'Thiếu định danh phần cứng thiết bị (deviceUuid).' });
    }
    try {
      boundDevice = db.bindLiveDevice(user.id, deviceUuid, deviceModel || 'iOS Device');
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
  }

  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      platform: platform || 'web',
      deviceUuid: deviceUuid || null
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  return res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      expiresAt: user.expiresAt,
      platform: platform || 'web',
      device: boundDevice
    }
  });
});

// GET /api/auth/me
authRouter.get('/me', authMiddleware, (req: AuthRequest, res: Response) => {
  const user = db.getUserById(req.user!.id);
  const devices = db.getDevicesByUserId(req.user!.id);
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
