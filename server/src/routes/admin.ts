import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { exec, execFile } from 'child_process';
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

// Helper kiểm tra zsign đã cài đặt chưa
const isZsignAvailable = (): Promise<boolean> => {
  return new Promise((resolve) => {
    exec('zsign -v', (err) => {
      resolve(!err);
    });
  });
};

// Helper giải nén zip không cần thư viện ngoài (dùng lệnh hệ điều hành)
const extractZipArchive = (zipPath: string, destDir: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? `powershell -Command "Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}'"`
      : `unzip -o -q "${zipPath}" -d "${destDir}"`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve();
      }
    });
  });
};

// Helper quét tìm file theo đuôi đệ quy
const findFilesRecursively = (dir: string, ext: string): string[] => {
  let matches: string[] = [];
  if (!fs.existsSync(dir)) return matches;
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        matches = matches.concat(findFilesRecursively(fullPath, ext));
      } else if (item.toLowerCase().endsWith(ext.toLowerCase())) {
        matches.push(fullPath);
      }
    } catch {}
  }
  return matches;
};

// GET /api/admin/app-files - Danh sách file IPA, chứng chỉ và trạng thái zsign
adminRouter.get('/app-files', async (req: AuthRequest, res: Response) => {
  const appDir = getAppDir();
  if (!fs.existsSync(appDir)) {
    fs.mkdirSync(appDir, { recursive: true });
  }

  const zsignReady = await isZsignAvailable();

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
      isZip: lower.endsWith('.zip'),
      isP12: lower.endsWith('.p12'),
      isProvision: lower.endsWith('.mobileprovision'),
      isCert: lower.endsWith('.mobileprovision') || lower.endsWith('.p12') || lower.endsWith('.cer') || lower.endsWith('.zip')
    };
  });

  const p12Files = findFilesRecursively(appDir, '.p12').map(f => path.basename(f));
  const provFiles = findFilesRecursively(appDir, '.mobileprovision').map(f => path.basename(f));
  const ipaFiles = findFilesRecursively(appDir, '.ipa').filter(f => !f.includes('_temp')).map(f => path.basename(f));

  res.json({
    files,
    zsignReady,
    certSummary: {
      hasP12: p12Files.length > 0,
      p12Files,
      hasProvision: provFiles.length > 0,
      provFiles,
      hasIpa: ipaFiles.length > 0,
      ipaFiles
    }
  });
});

// POST /api/admin/upload-app-file - Upload file .ipa, .zip, hoặc chứng chỉ (.mobileprovision, .p12, .cer)
adminRouter.post('/upload-app-file', (req: AuthRequest, res: Response) => {
  const filename = (req.query.filename as string) || 'SloMoLive.ipa';
  const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');

  const allowedExts = ['.ipa', '.mobileprovision', '.p12', '.cer', '.plist', '.zip'];
  const hasValidExt = allowedExts.some(ext => safeFilename.toLowerCase().endsWith(ext));
  if (!hasValidExt) {
    return res.status(400).json({ error: 'Chỉ chấp nhận file định dạng .ipa, .zip, .mobileprovision, .p12, .cer' });
  }

  const appDir = getAppDir();
  if (!fs.existsSync(appDir)) {
    fs.mkdirSync(appDir, { recursive: true });
  }

  const targetPath = path.join(appDir, safeFilename);
  const writeStream = fs.createWriteStream(targetPath);

  req.pipe(writeStream);

  writeStream.on('finish', async () => {
    const stats = fs.statSync(targetPath);
    let extractedNotice = '';

    // Nếu là file zip, tự động giải nén tìm p12 và mobileprovision
    if (safeFilename.toLowerCase().endsWith('.zip')) {
      try {
        await extractZipArchive(targetPath, appDir);
        extractedNotice = ' và đã tự động giải nén các file chứng chỉ bên trong';
      } catch (err: any) {
        extractedNotice = ` (Lưu ý: giải nén tự động lỗi: ${err.message})`;
      }
    }

    res.json({
      message: `Tải lên file "${safeFilename}" thành công (${(stats.size / 1024 / 1024).toFixed(2)} MB)${extractedNotice}.`,
      filename: safeFilename,
      size: stats.size,
      updatedAt: stats.mtime.toISOString()
    });
  });

  writeStream.on('error', (err) => {
    res.status(500).json({ error: 'Lỗi ghi file: ' + err.message });
  });
});

// POST /api/admin/extract-zip/:filename - Giải nén thủ công file zip đã upload
adminRouter.post('/extract-zip/:filename', async (req: AuthRequest, res: Response) => {
  const safeFilename = path.basename(req.params.filename);
  const appDir = getAppDir();
  const targetPath = path.join(appDir, safeFilename);

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'File zip không tồn tại.' });
  }

  try {
    await extractZipArchive(targetPath, appDir);
    res.json({ message: `Đã giải nén thành công file "${safeFilename}".` });
  } catch (err: any) {
    res.status(500).json({ error: 'Lỗi khi giải nén file zip: ' + err.message });
  }
});

// POST /api/admin/sign-ipa - Tự động ký chứng chỉ doanh nghiệp vào file IPA bằng zsign
adminRouter.post('/sign-ipa', async (req: AuthRequest, res: Response) => {
  const { p12Password, ipaFilename, p12Filename, mobileprovisionFilename } = req.body;

  if (!p12Password || typeof p12Password !== 'string' || p12Password.trim() === '') {
    return res.status(400).json({ error: 'Vui lòng nhập mật khẩu của file chứng chỉ .p12' });
  }

  const zsignReady = await isZsignAvailable();
  if (!zsignReady) {
    return res.status(400).json({
      error: 'Công cụ "zsign" chưa được cài đặt trên VPS. Vui lòng cài zsign trên VPS theo câu lệnh hướng dẫn trước khi ký.',
      needsZsignInstall: true
    });
  }

  const appDir = getAppDir();

  // 1. Xác định file .p12
  let p12Path = p12Filename ? path.join(appDir, path.basename(p12Filename)) : '';
  if (!p12Path || !fs.existsSync(p12Path)) {
    const p12Files = findFilesRecursively(appDir, '.p12');
    if (p12Files.length > 0) {
      p12Path = p12Files[0];
    }
  }

  // 2. Xác định file .mobileprovision
  let provPath = mobileprovisionFilename ? path.join(appDir, path.basename(mobileprovisionFilename)) : '';
  if (!provPath || !fs.existsSync(provPath)) {
    const provFiles = findFilesRecursively(appDir, '.mobileprovision');
    if (provFiles.length > 0) {
      provPath = provFiles[0];
    }
  }

  if (!p12Path || !fs.existsSync(p12Path)) {
    return res.status(400).json({ error: 'Không tìm thấy file chứng chỉ .p12 nào. Vui lòng upload file .p12 hoặc file .zip chứa chứng chỉ.' });
  }

  if (!provPath || !fs.existsSync(provPath)) {
    return res.status(400).json({ error: 'Không tìm thấy file hồ sơ cấp phép .mobileprovision nào. Vui lòng upload file .mobileprovision hoặc file .zip.' });
  }

  // 3. Xác định file .ipa đầu vào
  let inputIpa = ipaFilename ? path.join(appDir, path.basename(ipaFilename)) : '';
  if (!inputIpa || !fs.existsSync(inputIpa)) {
    const ipaFiles = findFilesRecursively(appDir, '.ipa').filter(f => !f.includes('_signed_temp'));
    if (ipaFiles.length > 0) {
      inputIpa = ipaFiles[0];
    }
  }

  if (!inputIpa || !fs.existsSync(inputIpa)) {
    return res.status(400).json({ error: 'Không tìm thấy file .IPA nguồn để ký. Vui lòng tải lên file .ipa trước.' });
  }

  const tempSignedPath = path.join(appDir, `signed_temp_${Date.now()}.ipa`);
  const finalIpaPath = path.join(appDir, 'SloMoLive.ipa');

  // Lệnh ký: zsign -k <p12> -p <password> -m <mobileprovision> -o <output> <input>
  const args = ['-k', p12Path, '-p', p12Password.trim(), '-m', provPath, '-o', tempSignedPath, inputIpa];

  execFile('zsign', args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      if (fs.existsSync(tempSignedPath)) {
        try { fs.unlinkSync(tempSignedPath); } catch {}
      }

      const outputLog = (stdout + '\n' + stderr).trim();
      let userError = 'Ký file IPA thất bại.';
      if (outputLog.toLowerCase().includes('password') || outputLog.toLowerCase().includes('pkcs12')) {
        userError = 'Mật khẩu file chứng chỉ (.p12) KHÔNG ĐÚNG! Vui lòng kiểm tra lại mật khẩu.';
      } else if (outputLog.toLowerCase().includes('provision') || outputLog.toLowerCase().includes('profile')) {
        userError = 'File .mobileprovision không hợp lệ hoặc không khớp với chứng chỉ .p12.';
      }

      return res.status(400).json({
        error: userError,
        details: outputLog
      });
    }

    try {
      if (fs.existsSync(finalIpaPath) && finalIpaPath !== tempSignedPath) {
        try { fs.unlinkSync(finalIpaPath); } catch {}
      }
      fs.renameSync(tempSignedPath, finalIpaPath);

      const stats = fs.statSync(finalIpaPath);

      res.json({
        success: true,
        message: `Đã ký thành công chứng chỉ doanh nghiệp vào app! File "${path.basename(finalIpaPath)}" (${(stats.size / 1024 / 1024).toFixed(2)} MB) đã sẵn sàng. Người dùng có thể cài đặt ngay trên iPhone.`,
        output: stdout
      });
    } catch (fsErr: any) {
      res.status(500).json({ error: 'Lỗi ghi file IPA đã ký: ' + fsErr.message });
    }
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

