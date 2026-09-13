import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
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

// POST /api/admin/users/:id/reset-password - Admin reset mật khẩu user
adminRouter.post('/users/:id/reset-password', (req: AuthRequest, res: Response) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự.' });
  }

  const user = db.getUserById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'Tài khoản không tồn tại.' });
  }

  db.updateUser(user.id, { passwordHash: bcrypt.hashSync(newPassword, 10) });
  res.json({ message: `Đã reset mật khẩu tài khoản "${user.username}" thành công.` });
});

// GET /api/admin/gps-logs - Get latest GPS positions
adminRouter.get('/gps-logs', (req: AuthRequest, res: Response) => {
  const latestGps = db.getLatestGpsLog();
  res.json({ gps: latestGps });
});

// Helper xác định thư mục app
const getAppDir = () => {
  const dir1 = path.resolve(__dirname, '../../../app');
  const dir2 = path.resolve(process.cwd(), 'app');
  return fs.existsSync(dir1) ? dir1 : dir2;
};

// GET /api/admin/app-files - Danh sách file IPA và chứng chỉ trong thư mục app
adminRouter.get('/app-files', (req: AuthRequest, res: Response) => {
  const appDir = getAppDir();
  if (!fs.existsSync(appDir)) {
    fs.mkdirSync(appDir, { recursive: true });
  }

  const files = fs.readdirSync(appDir).map(filename => {
    const filePath = path.join(appDir, filename);
    const stats = fs.statSync(filePath);
    const lower = filename.toLowerCase();
    return {
      name: filename,
      size: stats.size,
      sizeFormatted: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
      updatedAt: stats.mtime.toISOString(),
      isIpa: lower.endsWith('.ipa'),
      isCert: lower.endsWith('.mobileprovision') || lower.endsWith('.p12') || lower.endsWith('.cer')
    };
  });

  res.json({ files });
});

// POST /api/admin/upload-app-file - Upload file .ipa hoặc chứng chỉ (.mobileprovision, .p12, .cer)
adminRouter.post('/upload-app-file', (req: AuthRequest, res: Response) => {
  const filename = (req.query.filename as string) || 'SloMoLive.ipa';
  const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');

  const allowedExts = ['.ipa', '.mobileprovision', '.p12', '.cer', '.plist'];
  const hasValidExt = allowedExts.some(ext => safeFilename.toLowerCase().endsWith(ext));
  if (!hasValidExt) {
    return res.status(400).json({ error: 'Chỉ chấp nhận file định dạng .ipa, .mobileprovision, .p12, .cer' });
  }

  const appDir = getAppDir();
  if (!fs.existsSync(appDir)) {
    fs.mkdirSync(appDir, { recursive: true });
  }

  const targetPath = path.join(appDir, safeFilename);
  const writeStream = fs.createWriteStream(targetPath);

  req.pipe(writeStream);

  writeStream.on('finish', () => {
    const stats = fs.statSync(targetPath);
    res.json({
      message: `Tải lên file "${safeFilename}" thành công (${(stats.size / 1024 / 1024).toFixed(2)} MB).`,
      filename: safeFilename,
      size: stats.size,
      updatedAt: stats.mtime.toISOString()
    });
  });

  writeStream.on('error', (err) => {
    res.status(500).json({ error: 'Lỗi ghi file: ' + err.message });
  });
});

// DELETE /api/admin/app-files/:filename - Xóa file trong app folder
adminRouter.delete('/app-files/:filename', (req: AuthRequest, res: Response) => {
  const safeFilename = path.basename(req.params.filename);
  const appDir = getAppDir();
  const targetPath = path.join(appDir, safeFilename);

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'File không tồn tại.' });
  }

  try {
    fs.unlinkSync(targetPath);
    res.json({ message: `Đã xóa file "${safeFilename}" thành công.` });
  } catch (err: any) {
    res.status(500).json({ error: 'Lỗi khi xóa file: ' + err.message });
  }
});
