import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { db, User } from '../db';
import { adminMiddleware, AuthRequest } from './auth';

export const adminRouter = Router();
adminRouter.use(adminMiddleware);

// GET /api/admin/users - List users
adminRouter.get('/users', (req: AuthRequest, res: Response) => {
  const users = db.getUsers().map(u => {
    const devices = db.getDevicesByUserId(u.id);
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      isBlocked: u.isBlocked,
      expiresAt: u.expiresAt,
      isExpired: new Date(u.expiresAt) < new Date(),
      createdAt: u.createdAt,
      devices
    };
  });
  res.json({ users });
});

// POST /api/admin/users - Create User
adminRouter.post('/users', (req: AuthRequest, res: Response) => {
  const { username, password, daysValid, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username và Password không được để trống.' });
  }

  const existing = db.getUserByUsername(username);
  if (existing) {
    return res.status(400).json({ error: 'Tên tài khoản này đã tồn tại.' });
  }

  const days = parseInt(daysValid) || 30;
  const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();

  const newUser: User = {
    id: 'usr-' + Date.now(),
    username: username.trim(),
    passwordHash: bcrypt.hashSync(password, 10),
    role: role === 'ADMIN' ? 'ADMIN' : 'USER',
    isBlocked: false,
    expiresAt,
    createdAt: new Date().toISOString()
  };

  db.createUser(newUser);

  res.status(201).json({
    message: 'Tạo tài khoản thành công.',
    user: {
      id: newUser.id,
      username: newUser.username,
      role: newUser.role,
      expiresAt: newUser.expiresAt
    }
  });
});

// POST /api/admin/users/:id/renew - Extend expiration
adminRouter.post('/users/:id/renew', (req: AuthRequest, res: Response) => {
  const { days } = req.body;
  const addDays = parseInt(days) || 30;

  const user = db.getUserById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'Tài khoản không tồn tại.' });
  }

  let currentExpires = new Date(user.expiresAt);
  if (currentExpires < new Date()) {
    currentExpires = new Date(); // Nếu đã hết hạn, tính từ mốc hôm nay
  }

  const newExpiresAt = new Date(currentExpires.getTime() + addDays * 24 * 3600 * 1000).toISOString();
  db.updateUser(user.id, { expiresAt: newExpiresAt, isBlocked: false });

  res.json({
    message: `Đã gia hạn tài khoản thêm ${addDays} ngày. Hạn mới: ${new Date(newExpiresAt).toLocaleDateString('vi-VN')}`,
    expiresAt: newExpiresAt
  });
});

// POST /api/admin/users/:id/toggle-block - Block / Unblock
adminRouter.post('/users/:id/toggle-block', (req: AuthRequest, res: Response) => {
  const user = db.getUserById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'Tài khoản không tồn tại.' });
  }

  if (user.role === 'ADMIN') {
    return res.status(400).json({ error: 'Không thể khóa tài khoản Admin chính.' });
  }

  const updated = db.updateUser(user.id, { isBlocked: !user.isBlocked });
  res.json({
    message: updated?.isBlocked ? 'Đã khóa tài khoản.' : 'Đã mở khóa tài khoản.',
    isBlocked: updated?.isBlocked
  });
});

// POST /api/admin/users/:id/reset-device - Reset device binding
adminRouter.post('/users/:id/reset-device', (req: AuthRequest, res: Response) => {
  const user = db.getUserById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'Tài khoản không tồn tại.' });
  }

  db.resetUserDevice(user.id);
  res.json({ message: 'Đã reset gán thiết bị điện thoại thành công. User có thể gán iPhone mới.' });
});

// DELETE /api/admin/users/:id
adminRouter.delete('/users/:id', (req: AuthRequest, res: Response) => {
  const user = db.getUserById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'Tài khoản không tồn tại.' });
  }

  if (user.role === 'ADMIN') {
    return res.status(400).json({ error: 'Không thể xóa tài khoản Admin chính.' });
  }

  db.deleteUser(user.id);
  res.json({ message: 'Đã xóa tài khoản thành công.' });
});

// GET /api/admin/gps-logs - Get latest GPS positions
adminRouter.get('/gps-logs', (req: AuthRequest, res: Response) => {
  const latestGps = db.getLatestGpsLog();
  res.json({ gps: latestGps });
});
