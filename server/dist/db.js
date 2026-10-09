"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const DB_FILE = path_1.default.join(__dirname, '../data/database.json');
class Database {
    data;
    constructor() {
        this.data = {
            users: [],
            userDevices: [],
            voiceLicenses: [],
            streamSessions: [],
            gpsLogs: [],
            cardEntries: [],
            groupNames: {}
        };
        this.init();
    }
    init() {
        const dataDir = path_1.default.dirname(DB_FILE);
        if (!fs_1.default.existsSync(dataDir)) {
            fs_1.default.mkdirSync(dataDir, { recursive: true });
        }
        if (fs_1.default.existsSync(DB_FILE)) {
            try {
                const raw = fs_1.default.readFileSync(DB_FILE, 'utf-8');
                this.data = JSON.parse(raw);
                if (!this.data.voiceLicenses) {
                    this.data.voiceLicenses = [];
                }
                if (!this.data.userDevices) {
                    this.data.userDevices = [];
                }
                // Đảm bảo mật khẩu admin luôn khớp với TuLinh@789 (hoặc cấu hình ADMIN_PASSWORD)
                const admin = this.data.users.find(u => u.username === 'admin');
                if (admin) {
                    const targetPassword = process.env.ADMIN_PASSWORD || 'TuLinh@789';
                    if (!bcryptjs_1.default.compareSync(targetPassword, admin.passwordHash)) {
                        admin.passwordHash = bcryptjs_1.default.hashSync(targetPassword, 10);
                        this.save();
                        console.log('[DB] Đã cập nhật mật khẩu admin về "' + targetPassword + '" thành công.');
                    }
                }
            }
            catch (e) {
                console.error('Error reading database file, initializing fresh:', e);
                this.seedDefaultAdmin();
            }
        }
        else {
            this.seedDefaultAdmin();
        }
    }
    save() {
        fs_1.default.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
    }
    seedDefaultAdmin() {
        const adminPassword = bcryptjs_1.default.hashSync('TuLinh@789', 10);
        const userPassword = bcryptjs_1.default.hashSync('user123', 10);
        const defaultAdmin = {
            id: 'admin-uuid-0001',
            username: 'admin',
            passwordHash: adminPassword,
            role: 'ADMIN',
            isBlocked: false,
            expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
            createdAt: new Date().toISOString()
        };
        const defaultUser = {
            id: 'user-uuid-0002',
            username: 'demouser',
            passwordHash: userPassword,
            role: 'USER',
            isBlocked: false,
            expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(), // 30 ngày
            createdAt: new Date().toISOString()
        };
        this.data.users = [defaultAdmin, defaultUser];
        this.save();
        console.log('Database initialized with default admin (admin/TuLinh@789) and user (demouser/user123)');
    }
    // Users
    getUsers() {
        return this.data.users;
    }
    getUserById(id) {
        return this.data.users.find(u => u.id === id);
    }
    getUserByUsername(username) {
        return this.data.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    }
    createUser(user) {
        this.data.users.push(user);
        this.save();
        return user;
    }
    updateUser(id, updates) {
        const idx = this.data.users.findIndex(u => u.id === id);
        if (idx !== -1) {
            this.data.users[idx] = { ...this.data.users[idx], ...updates };
            // Tự động đồng bộ thời hạn gia hạn sang toàn bộ thiết bị của user
            if (updates.expiresAt) {
                this.data.userDevices.forEach(d => {
                    if (d.userId === id) {
                        d.expiresAt = updates.expiresAt;
                        if (d.deviceFingerprint) {
                            const lic = this.getVoiceLicenseByDevice(d.deviceFingerprint);
                            if (lic && !lic.isLifetime) {
                                lic.expiresAt = updates.expiresAt;
                            }
                        }
                    }
                });
            }
            this.save();
            return this.data.users[idx];
        }
        return undefined;
    }
    deleteUser(id) {
        const initialLen = this.data.users.length;
        this.data.users = this.data.users.filter(u => u.id !== id);
        this.data.userDevices = this.data.userDevices.filter(d => d.userId !== id);
        this.save();
        return this.data.users.length < initialLen;
    }
    // Devices
    getDevicesByUserId(userId) {
        return this.data.userDevices.filter(d => d.userId === userId);
    }
    getDeviceByUuid(deviceUuid) {
        return this.data.userDevices.find(d => d.deviceUuid === deviceUuid);
    }
    unlockDeviceVoice(deviceFingerprint, licenseKey) {
        const normFp = deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        let updated = false;
        this.data.userDevices.forEach(d => {
            if (d.deviceFingerprint) {
                const dNorm = d.deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
                if (dNorm === normFp) {
                    d.voiceUnlocked = true;
                    d.voiceKey = licenseKey;
                    updated = true;
                }
            }
        });
        if (updated) {
            this.save();
        }
    }
    /**
     * Phân định chuẩn 100%:
     * - APP_LIVE: Tối đa 1 máy. Máy thứ 2 bị chặn.
     * - APP_INPUT: Tối đa 2 máy. Máy thứ 3 bị chặn.
     */
    bindDevice(userId, deviceUuid, deviceModel, appType = 'APP_LIVE', deviceFingerprint) {
        const isLive = appType === 'APP_LIVE';
        const userDevices = this.data.userDevices.filter(d => d.userId === userId);
        const user = this.getUserById(userId);
        const userExpiresAt = user?.expiresAt || new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
        if (isLive) {
            // Tìm thiết bị Live hiện tại (kiểm tra cả cờ appType === 'APP_LIVE' hoặc isLiveDevice === true)
            const existingLive = userDevices.find(d => d.appType === 'APP_LIVE' || d.isLiveDevice);
            if (existingLive) {
                if (existingLive.deviceUuid !== deviceUuid) {
                    throw new Error('Tài khoản đã được gán cố định cho 1 thiết bị Live khác! Vui lòng liên hệ Admin để Reset.');
                }
                existingLive.lastLogin = new Date().toISOString();
                existingLive.deviceModel = deviceModel || existingLive.deviceModel;
                if (deviceFingerprint)
                    existingLive.deviceFingerprint = deviceFingerprint;
                existingLive.appType = 'APP_LIVE';
                existingLive.isLiveDevice = true;
                existingLive.activatedAt = existingLive.activatedAt || existingLive.createdAt || new Date().toISOString();
                existingLive.expiresAt = userExpiresAt;
                this.save();
                return existingLive;
            }
            // Tạo mới slot Live duy nhất
            const nowIso = new Date().toISOString();
            const newLive = {
                id: 'dev-live-' + Date.now(),
                userId,
                deviceUuid,
                deviceModel: deviceModel || 'iOS Live Device',
                appType: 'APP_LIVE',
                deviceFingerprint,
                isLiveDevice: true,
                lastLogin: nowIso,
                createdAt: nowIso,
                activatedAt: nowIso,
                expiresAt: userExpiresAt
            };
            this.data.userDevices.push(newLive);
            this.save();
            return newLive;
        }
        else {
            // APP_INPUT: Tối đa 2 máy
            const inputDevices = userDevices.filter(d => d.appType === 'APP_INPUT');
            const existingInput = inputDevices.find(d => d.deviceUuid === deviceUuid);
            if (existingInput) {
                existingInput.lastLogin = new Date().toISOString();
                existingInput.deviceModel = deviceModel || existingInput.deviceModel;
                if (deviceFingerprint)
                    existingInput.deviceFingerprint = deviceFingerprint;
                existingInput.activatedAt = existingInput.activatedAt || existingInput.createdAt || new Date().toISOString();
                existingInput.expiresAt = userExpiresAt;
                this.save();
                return existingInput;
            }
            // Kiểm tra quota 2 máy
            if (inputDevices.length >= 2) {
                throw new Error('Tài khoản đã đạt giới hạn tối đa 2 máy nhập bài! Không thể thêm máy thứ 3.');
            }
            const nowIso = new Date().toISOString();
            const newInput = {
                id: 'dev-input-' + Date.now(),
                userId,
                deviceUuid,
                deviceModel: deviceModel || 'iOS Input Device',
                appType: 'APP_INPUT',
                deviceFingerprint,
                isLiveDevice: false,
                lastLogin: nowIso,
                createdAt: nowIso,
                activatedAt: nowIso,
                expiresAt: userExpiresAt
            };
            this.data.userDevices.push(newInput);
            this.save();
            return newInput;
        }
    }
    bindLiveDevice(userId, deviceUuid, deviceModel) {
        return this.bindDevice(userId, deviceUuid, deviceModel, 'APP_LIVE');
    }
    resetUserDevice(userId) {
        this.data.userDevices = this.data.userDevices.filter(d => d.userId !== userId);
        this.save();
        return true;
    }
    resetUserDeviceByType(userId, appType) {
        const beforeCount = this.data.userDevices.length;
        const removedFingerprints = new Set();
        this.data.userDevices = this.data.userDevices.filter(d => {
            if (d.userId !== userId)
                return true;
            if (appType === 'APP_LIVE')
                return !(d.appType === 'APP_LIVE' || d.isLiveDevice);
            if (d.appType === 'APP_INPUT') {
                if (d.deviceFingerprint)
                    removedFingerprints.add(d.deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''));
                return false;
            }
            return true;
        });
        // Nếu reset máy Nhập của tài khoản này, dọn dẹp các License chưa kích hoạt của user này để cấp key mới tinh
        if (appType === 'APP_INPUT' && this.data.voiceLicenses && removedFingerprints.size > 0) {
            this.data.voiceLicenses = this.data.voiceLicenses.filter(lic => {
                const norm = lic.deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
                if (removedFingerprints.has(norm) && lic.userId === userId && !lic.isUsed) {
                    return false;
                }
                return true;
            });
        }
        this.save();
        return this.data.userDevices.length < beforeCount;
    }
    // Voice Licenses Management
    getAllVoiceLicenses() {
        return this.data.voiceLicenses || [];
    }
    getVoiceLicenseByDevice(deviceFingerprint, userId) {
        const norm = deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        return (this.data.voiceLicenses || []).find(l => {
            const licNorm = l.deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (licNorm !== norm)
                return false;
            if (userId && l.userId) {
                return l.userId === userId;
            }
            return true;
        });
    }
    getVoiceLicenseByKey(licenseKey) {
        const cleanKey = licenseKey.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        return (this.data.voiceLicenses || []).find(l => {
            const lClean = l.licenseKey.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
            return lClean === cleanKey;
        });
    }
    createVoiceLicense(license) {
        if (!this.data.voiceLicenses)
            this.data.voiceLicenses = [];
        this.data.voiceLicenses.push(license);
        this.save();
        return license;
    }
    activateVoiceLicense(licenseKey, deviceFingerprint, deviceModel) {
        if (!this.data.voiceLicenses)
            this.data.voiceLicenses = [];
        const cleanKey = licenseKey.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        const cleanFp = deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        const lic = this.data.voiceLicenses.find(l => {
            const lClean = l.licenseKey.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
            return lClean === cleanKey;
        });
        if (!lic) {
            throw new Error('Mã Key kích hoạt không tồn tại trên hệ thống.');
        }
        const licFp = lic.deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (licFp !== cleanFp) {
            throw new Error('Key này được sinh riêng cho thiết bị khác, không khớp với máy này!');
        }
        // Nếu đã kích hoạt trước đó trên chính thiết bị này: Cho phép khôi phục / kích hoạt lại an toàn
        if (lic.isUsed && lic.activatedAt) {
            lic.deviceModel = deviceModel || lic.deviceModel;
            this.save();
            return lic;
        }
        lic.isUsed = true;
        lic.activatedAt = new Date().toISOString();
        lic.deviceModel = deviceModel || lic.deviceModel;
        this.save();
        return lic;
    }
    renewVoiceLicense(newKey, deviceFingerprint, addedDays) {
        if (!this.data.voiceLicenses)
            this.data.voiceLicenses = [];
        const normFp = deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        let lic = this.data.voiceLicenses.find(l => l.deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') === normFp);
        const now = new Date();
        if (!lic) {
            throw new Error('Thiết bị này chưa từng được đăng ký trong hệ thống.');
        }
        if (addedDays === 'LIFETIME') {
            lic.isLifetime = true;
            lic.expiresAt = new Date(now.getTime() + 100 * 365 * 24 * 3600 * 1000).toISOString();
        }
        else {
            let currentExpiry = new Date(lic.expiresAt);
            if (isNaN(currentExpiry.getTime()) || currentExpiry < now) {
                currentExpiry = now; // Nếu đã hết hạn, tính từ hôm nay
            }
            lic.expiresAt = new Date(currentExpiry.getTime() + addedDays * 24 * 3600 * 1000).toISOString();
            lic.isLifetime = false;
        }
        if (!lic.renewalHistory)
            lic.renewalHistory = [];
        lic.renewalHistory.push({
            key: newKey,
            addedDays,
            renewedAt: now.toISOString(),
            newExpiresAt: lic.expiresAt
        });
        this.save();
        return lic;
    }
    deleteVoiceLicense(id) {
        if (!this.data.voiceLicenses)
            return false;
        const initialLen = this.data.voiceLicenses.length;
        this.data.voiceLicenses = this.data.voiceLicenses.filter(l => l.id !== id);
        this.save();
        return this.data.voiceLicenses.length < initialLen;
    }
    // Stream Sessions
    getStreamSessions() {
        return this.data.streamSessions;
    }
    getStreams() {
        return this.data.streamSessions;
    }
    getActiveStream(userId) {
        if (userId) {
            return this.data.streamSessions.find(s => s.userId === userId && s.status === 'LIVE');
        }
        return this.data.streamSessions.find(s => s.status === 'LIVE');
    }
    getLatestStream(userId) {
        const list = userId
            ? this.data.streamSessions.filter(s => s.userId === userId)
            : this.data.streamSessions;
        if (list.length === 0)
            return undefined;
        // Ưu tiên luồng đang LIVE, nếu không còn LIVE thì trả về phiên vừa kết thúc gần nhất để xem lại DVR
        return list.find(s => s.status === 'LIVE') || list[list.length - 1];
    }
    createStreamSession(session) {
        // Chỉ kết thúc luồng live cũ của chính user này
        this.data.streamSessions.forEach(s => {
            if (s.userId === session.userId && s.status === 'LIVE') {
                s.status = 'ENDED';
                s.endedAt = new Date().toISOString();
            }
        });
        this.data.streamSessions.push(session);
        this.save();
        return session;
    }
    endStreamSession(streamId, vodUrl) {
        const session = this.data.streamSessions.find(s => s.id === streamId || (s.status === 'LIVE' && s.userId === streamId));
        if (session) {
            session.status = 'ENDED';
            session.endedAt = new Date().toISOString();
            if (vodUrl)
                session.vodUrl = vodUrl;
            this.save();
        }
        return session;
    }
    endStreamSessionByStreamKey(streamKey) {
        const session = this.data.streamSessions.find(s => s.streamKey === streamKey && s.status === 'LIVE');
        if (session) {
            session.status = 'ENDED';
            session.endedAt = new Date().toISOString();
            this.save();
        }
        return session;
    }
    removeEndedStreams(userId) {
        const initialCount = this.data.streamSessions.length;
        this.data.streamSessions = this.data.streamSessions.filter(s => {
            if (s.status === 'LIVE')
                return true;
            if (userId && s.userId !== userId)
                return true;
            return false;
        });
        const removed = initialCount - this.data.streamSessions.length;
        if (removed > 0) {
            this.save();
        }
        return removed;
    }
    resetStreamStartTime(streamIdOrKey) {
        const session = this.data.streamSessions.find(s => s.id === streamIdOrKey || s.streamKey === streamIdOrKey);
        if (session) {
            session.startedAt = new Date().toISOString();
            this.save();
        }
        return session;
    }
    // GPS Logs
    addGpsLog(log) {
        this.data.gpsLogs.push(log);
        if (this.data.gpsLogs.length > 1000) {
            this.data.gpsLogs.shift();
        }
        this.save();
    }
    getLatestGpsLog(userId) {
        if (userId) {
            return [...this.data.gpsLogs].reverse().find(g => g.userId === userId);
        }
        return this.data.gpsLogs[this.data.gpsLogs.length - 1];
    }
    // Card Entries theo từng Room (userId)
    getCardEntries(userIdOrStreamId) {
        if (userIdOrStreamId) {
            return this.data.cardEntries.filter(c => c.userId === userIdOrStreamId || c.streamId === userIdOrStreamId);
        }
        return this.data.cardEntries;
    }
    addCardEntry(entry) {
        this.data.cardEntries.push(entry);
        this.save();
        return entry;
    }
    clearCardEntries(userIdOrStreamId) {
        if (userIdOrStreamId) {
            this.data.cardEntries = this.data.cardEntries.filter(c => c.userId !== userIdOrStreamId && c.streamId !== userIdOrStreamId);
        }
        else {
            this.data.cardEntries = [];
        }
        this.save();
    }
    popCardEntry(userIdOrStreamId) {
        if (this.data.cardEntries.length === 0)
            return undefined;
        if (userIdOrStreamId) {
            for (let i = this.data.cardEntries.length - 1; i >= 0; i--) {
                const item = this.data.cardEntries[i];
                if (item.userId === userIdOrStreamId || item.streamId === userIdOrStreamId) {
                    const [removed] = this.data.cardEntries.splice(i, 1);
                    this.save();
                    return removed;
                }
            }
            return undefined;
        }
        const popped = this.data.cardEntries.pop();
        this.save();
        return popped;
    }
    updateCardEntry(id, newCardValue) {
        const entry = this.data.cardEntries.find(c => c.id === id);
        if (entry) {
            entry.cardValue = newCardValue.trim().toUpperCase();
            entry.itemValue = entry.cardValue;
            this.save();
            return entry;
        }
        return undefined;
    }
    deleteCardEntry(id) {
        const index = this.data.cardEntries.findIndex(c => c.id === id);
        if (index !== -1) {
            const [removed] = this.data.cardEntries.splice(index, 1);
            this.save();
            return removed;
        }
        return undefined;
    }
    getGroupNames(roomId = 'default') {
        if (!this.data.groupNames)
            this.data.groupNames = {};
        return this.data.groupNames[roomId] || {};
    }
    setGroupNames(roomId = 'default', names) {
        if (!this.data.groupNames)
            this.data.groupNames = {};
        this.data.groupNames[roomId] = names;
        this.save();
    }
    // Tự động dọn dẹp các dữ liệu bài (cardEntries) và phiên live (streamSessions) cũ đã qua maxAgeSeconds (mặc định 24h)
    cleanupOldData(maxAgeSeconds = 24 * 3600) {
        const nowMs = Date.now();
        const thresholdMs = nowMs - maxAgeSeconds * 1000;
        const initialCards = this.data.cardEntries.length;
        this.data.cardEntries = this.data.cardEntries.filter(c => {
            if (!c.createdAt)
                return true;
            const t = new Date(c.createdAt).getTime();
            return isNaN(t) || t >= thresholdMs;
        });
        const cleanedCards = initialCards - this.data.cardEntries.length;
        const initialSessions = this.data.streamSessions.length;
        this.data.streamSessions = this.data.streamSessions.filter(s => {
            if (s.status === 'LIVE')
                return true;
            const t = s.endedAt ? new Date(s.endedAt).getTime() : new Date(s.startedAt).getTime();
            return isNaN(t) || t >= thresholdMs;
        });
        const cleanedSessions = initialSessions - this.data.streamSessions.length;
        if (cleanedCards > 0 || cleanedSessions > 0) {
            this.save();
        }
        return { cleanedSessions, cleanedCards };
    }
}
exports.db = new Database();
