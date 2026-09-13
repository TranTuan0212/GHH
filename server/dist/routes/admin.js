"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminRouter = void 0;
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const child_process_1 = require("child_process");
const db_1 = require("../db");
const auth_1 = require("./auth");
exports.adminRouter = (0, express_1.Router)();
exports.adminRouter.use(auth_1.adminMiddleware);
// GET /api/admin/users - List users
exports.adminRouter.get('/users', (req, res) => {
    const users = db_1.db.getUsers().map(u => {
        const devices = db_1.db.getDevicesByUserId(u.id);
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
exports.adminRouter.post('/users', (req, res) => {
    const { username, password, daysValid, role } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username và Password không được để trống.' });
    }
    const existing = db_1.db.getUserByUsername(username);
    if (existing) {
        return res.status(400).json({ error: 'Tên tài khoản này đã tồn tại.' });
    }
    const days = parseInt(daysValid) || 30;
    const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
    const newUser = {
        id: 'usr-' + Date.now(),
        username: username.trim(),
        passwordHash: bcryptjs_1.default.hashSync(password, 10),
        role: role === 'ADMIN' ? 'ADMIN' : 'USER',
        isBlocked: false,
        expiresAt,
        createdAt: new Date().toISOString()
    };
    db_1.db.createUser(newUser);
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
exports.adminRouter.post('/users/:id/renew', (req, res) => {
    const { days } = req.body;
    const addDays = parseInt(days) || 30;
    const user = db_1.db.getUserById(req.params.id);
    if (!user) {
        return res.status(404).json({ error: 'Tài khoản không tồn tại.' });
    }
    let currentExpires = new Date(user.expiresAt);
    if (currentExpires < new Date()) {
        currentExpires = new Date(); // Nếu đã hết hạn, tính từ mốc hôm nay
    }
    const newExpiresAt = new Date(currentExpires.getTime() + addDays * 24 * 3600 * 1000).toISOString();
    db_1.db.updateUser(user.id, { expiresAt: newExpiresAt, isBlocked: false });
    res.json({
        message: `Đã gia hạn tài khoản thêm ${addDays} ngày. Hạn mới: ${new Date(newExpiresAt).toLocaleDateString('vi-VN')}`,
        expiresAt: newExpiresAt
    });
});
// POST /api/admin/users/:id/toggle-block - Block / Unblock
exports.adminRouter.post('/users/:id/toggle-block', (req, res) => {
    const user = db_1.db.getUserById(req.params.id);
    if (!user) {
        return res.status(404).json({ error: 'Tài khoản không tồn tại.' });
    }
    if (user.role === 'ADMIN') {
        return res.status(400).json({ error: 'Không thể khóa tài khoản Admin chính.' });
    }
    const updated = db_1.db.updateUser(user.id, { isBlocked: !user.isBlocked });
    res.json({
        message: updated?.isBlocked ? 'Đã khóa tài khoản.' : 'Đã mở khóa tài khoản.',
        isBlocked: updated?.isBlocked
    });
});
// POST /api/admin/users/:id/reset-device - Reset device binding
exports.adminRouter.post('/users/:id/reset-device', (req, res) => {
    const user = db_1.db.getUserById(req.params.id);
    if (!user) {
        return res.status(404).json({ error: 'Tài khoản không tồn tại.' });
    }
    db_1.db.resetUserDevice(user.id);
    res.json({ message: 'Đã reset gán thiết bị điện thoại thành công. User có thể gán iPhone mới.' });
});
// DELETE /api/admin/users/:id
exports.adminRouter.delete('/users/:id', (req, res) => {
    const user = db_1.db.getUserById(req.params.id);
    if (!user) {
        return res.status(404).json({ error: 'Tài khoản không tồn tại.' });
    }
    if (user.role === 'ADMIN') {
        return res.status(400).json({ error: 'Không thể xóa tài khoản Admin chính.' });
    }
    db_1.db.deleteUser(user.id);
    res.json({ message: 'Đã xóa tài khoản thành công.' });
});
// POST /api/admin/users/:id/reset-password - Admin reset mật khẩu user
exports.adminRouter.post('/users/:id/reset-password', (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự.' });
    }
    const user = db_1.db.getUserById(req.params.id);
    if (!user) {
        return res.status(404).json({ error: 'Tài khoản không tồn tại.' });
    }
    db_1.db.updateUser(user.id, { passwordHash: bcryptjs_1.default.hashSync(newPassword, 10) });
    res.json({ message: `Đã reset mật khẩu tài khoản "${user.username}" thành công.` });
});
// GET /api/admin/gps-logs - Get latest GPS positions
exports.adminRouter.get('/gps-logs', (req, res) => {
    const latestGps = db_1.db.getLatestGpsLog();
    res.json({ gps: latestGps });
});
// Helper xác định thư mục app
const getAppDir = () => {
    const dir1 = path_1.default.resolve(__dirname, '../../../app');
    const dir2 = path_1.default.resolve(process.cwd(), 'app');
    return fs_1.default.existsSync(dir1) ? dir1 : dir2;
};
// Helper kiểm tra zsign đã cài đặt chưa
const isZsignAvailable = () => {
    return new Promise((resolve) => {
        (0, child_process_1.exec)('zsign -v', (err) => {
            resolve(!err);
        });
    });
};
// Helper giải nén zip không cần thư viện ngoài (dùng lệnh hệ điều hành)
const extractZipArchive = (zipPath, destDir) => {
    return new Promise((resolve, reject) => {
        if (!fs_1.default.existsSync(destDir)) {
            fs_1.default.mkdirSync(destDir, { recursive: true });
        }
        const isWin = process.platform === 'win32';
        const cmd = isWin
            ? `powershell -Command "Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}'"`
            : `unzip -o -q "${zipPath}" -d "${destDir}"`;
        (0, child_process_1.exec)(cmd, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr || err.message));
            }
            else {
                resolve();
            }
        });
    });
};
// Helper quét tìm file theo đuôi đệ quy
const findFilesRecursively = (dir, ext) => {
    let matches = [];
    if (!fs_1.default.existsSync(dir))
        return matches;
    const items = fs_1.default.readdirSync(dir);
    for (const item of items) {
        const fullPath = path_1.default.join(dir, item);
        try {
            const stat = fs_1.default.statSync(fullPath);
            if (stat.isDirectory()) {
                matches = matches.concat(findFilesRecursively(fullPath, ext));
            }
            else if (item.toLowerCase().endsWith(ext.toLowerCase())) {
                matches.push(fullPath);
            }
        }
        catch { }
    }
    return matches;
};
// GET /api/admin/app-files - Danh sách file IPA, chứng chỉ và trạng thái zsign
exports.adminRouter.get('/app-files', async (req, res) => {
    const appDir = getAppDir();
    if (!fs_1.default.existsSync(appDir)) {
        fs_1.default.mkdirSync(appDir, { recursive: true });
    }
    const zsignReady = await isZsignAvailable();
    const files = fs_1.default.readdirSync(appDir).map(filename => {
        const filePath = path_1.default.join(appDir, filename);
        const stats = fs_1.default.statSync(filePath);
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
    const p12Files = findFilesRecursively(appDir, '.p12').map(f => path_1.default.basename(f));
    const provFiles = findFilesRecursively(appDir, '.mobileprovision').map(f => path_1.default.basename(f));
    const ipaFiles = findFilesRecursively(appDir, '.ipa').filter(f => !f.includes('_temp')).map(f => path_1.default.basename(f));
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
exports.adminRouter.post('/upload-app-file', (req, res) => {
    const filename = req.query.filename || 'SloMoLive.ipa';
    const safeFilename = path_1.default.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const allowedExts = ['.ipa', '.mobileprovision', '.p12', '.cer', '.plist', '.zip'];
    const hasValidExt = allowedExts.some(ext => safeFilename.toLowerCase().endsWith(ext));
    if (!hasValidExt) {
        return res.status(400).json({ error: 'Chỉ chấp nhận file định dạng .ipa, .zip, .mobileprovision, .p12, .cer' });
    }
    const appDir = getAppDir();
    if (!fs_1.default.existsSync(appDir)) {
        fs_1.default.mkdirSync(appDir, { recursive: true });
    }
    const targetPath = path_1.default.join(appDir, safeFilename);
    const writeStream = fs_1.default.createWriteStream(targetPath);
    req.pipe(writeStream);
    writeStream.on('finish', async () => {
        const stats = fs_1.default.statSync(targetPath);
        let extractedNotice = '';
        // Nếu là file zip, tự động giải nén tìm p12 và mobileprovision
        if (safeFilename.toLowerCase().endsWith('.zip')) {
            try {
                await extractZipArchive(targetPath, appDir);
                extractedNotice = ' và đã tự động giải nén các file chứng chỉ bên trong';
            }
            catch (err) {
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
exports.adminRouter.post('/extract-zip/:filename', async (req, res) => {
    const safeFilename = path_1.default.basename(req.params.filename);
    const appDir = getAppDir();
    const targetPath = path_1.default.join(appDir, safeFilename);
    if (!fs_1.default.existsSync(targetPath)) {
        return res.status(404).json({ error: 'File zip không tồn tại.' });
    }
    try {
        await extractZipArchive(targetPath, appDir);
        res.json({ message: `Đã giải nén thành công file "${safeFilename}".` });
    }
    catch (err) {
        res.status(500).json({ error: 'Lỗi khi giải nén file zip: ' + err.message });
    }
});
// POST /api/admin/sign-ipa - Tự động ký chứng chỉ doanh nghiệp vào file IPA bằng zsign
exports.adminRouter.post('/sign-ipa', async (req, res) => {
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
    let p12Path = p12Filename ? path_1.default.join(appDir, path_1.default.basename(p12Filename)) : '';
    if (!p12Path || !fs_1.default.existsSync(p12Path)) {
        const p12Files = findFilesRecursively(appDir, '.p12');
        if (p12Files.length > 0) {
            p12Path = p12Files[0];
        }
    }
    // 2. Xác định file .mobileprovision
    let provPath = mobileprovisionFilename ? path_1.default.join(appDir, path_1.default.basename(mobileprovisionFilename)) : '';
    if (!provPath || !fs_1.default.existsSync(provPath)) {
        const provFiles = findFilesRecursively(appDir, '.mobileprovision');
        if (provFiles.length > 0) {
            provPath = provFiles[0];
        }
    }
    if (!p12Path || !fs_1.default.existsSync(p12Path)) {
        return res.status(400).json({ error: 'Không tìm thấy file chứng chỉ .p12 nào. Vui lòng upload file .p12 hoặc file .zip chứa chứng chỉ.' });
    }
    if (!provPath || !fs_1.default.existsSync(provPath)) {
        return res.status(400).json({ error: 'Không tìm thấy file hồ sơ cấp phép .mobileprovision nào. Vui lòng upload file .mobileprovision hoặc file .zip.' });
    }
    // 3. Xác định file .ipa đầu vào
    let inputIpa = ipaFilename ? path_1.default.join(appDir, path_1.default.basename(ipaFilename)) : '';
    if (!inputIpa || !fs_1.default.existsSync(inputIpa)) {
        const ipaFiles = findFilesRecursively(appDir, '.ipa').filter(f => !f.includes('_signed_temp'));
        if (ipaFiles.length > 0) {
            inputIpa = ipaFiles[0];
        }
    }
    if (!inputIpa || !fs_1.default.existsSync(inputIpa)) {
        return res.status(400).json({ error: 'Không tìm thấy file .IPA nguồn để ký. Vui lòng tải lên file .ipa trước.' });
    }
    const tempSignedPath = path_1.default.join(appDir, `signed_temp_${Date.now()}.ipa`);
    const finalIpaPath = path_1.default.join(appDir, 'SloMoLive.ipa');
    // Lệnh ký: zsign -k <p12> -p <password> -m <mobileprovision> -o <output> <input>
    const args = ['-k', p12Path, '-p', p12Password.trim(), '-m', provPath, '-o', tempSignedPath, inputIpa];
    (0, child_process_1.execFile)('zsign', args, { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
            if (fs_1.default.existsSync(tempSignedPath)) {
                try {
                    fs_1.default.unlinkSync(tempSignedPath);
                }
                catch { }
            }
            const outputLog = (stdout + '\n' + stderr).trim();
            let userError = 'Ký file IPA thất bại.';
            if (outputLog.toLowerCase().includes('password') || outputLog.toLowerCase().includes('pkcs12')) {
                userError = 'Mật khẩu file chứng chỉ (.p12) KHÔNG ĐÚNG! Vui lòng kiểm tra lại mật khẩu.';
            }
            else if (outputLog.toLowerCase().includes('provision') || outputLog.toLowerCase().includes('profile')) {
                userError = 'File .mobileprovision không hợp lệ hoặc không khớp với chứng chỉ .p12.';
            }
            return res.status(400).json({
                error: userError,
                details: outputLog
            });
        }
        try {
            if (fs_1.default.existsSync(finalIpaPath) && finalIpaPath !== tempSignedPath) {
                try {
                    fs_1.default.unlinkSync(finalIpaPath);
                }
                catch { }
            }
            fs_1.default.renameSync(tempSignedPath, finalIpaPath);
            const stats = fs_1.default.statSync(finalIpaPath);
            res.json({
                success: true,
                message: `Đã ký thành công chứng chỉ doanh nghiệp vào app! File "${path_1.default.basename(finalIpaPath)}" (${(stats.size / 1024 / 1024).toFixed(2)} MB) đã sẵn sàng. Người dùng có thể cài đặt ngay trên iPhone.`,
                output: stdout
            });
        }
        catch (fsErr) {
            res.status(500).json({ error: 'Lỗi ghi file IPA đã ký: ' + fsErr.message });
        }
    });
});
// DELETE /api/admin/app-files/:filename - Xóa file trong app folder
exports.adminRouter.delete('/app-files/:filename', (req, res) => {
    const safeFilename = path_1.default.basename(req.params.filename);
    const appDir = getAppDir();
    const targetPath = path_1.default.join(appDir, safeFilename);
    if (!fs_1.default.existsSync(targetPath)) {
        return res.status(404).json({ error: 'File không tồn tại.' });
    }
    try {
        fs_1.default.unlinkSync(targetPath);
        res.json({ message: `Đã xóa file "${safeFilename}" thành công.` });
    }
    catch (err) {
        res.status(500).json({ error: 'Lỗi khi xóa file: ' + err.message });
    }
});
