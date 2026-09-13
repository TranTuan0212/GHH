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
                // Tự động nâng cấp mật khẩu admin lên TuLinh@789 nếu đang dùng admin123
                const admin = this.data.users.find(u => u.username === 'admin');
                if (admin && bcryptjs_1.default.compareSync('admin123', admin.passwordHash)) {
                    admin.passwordHash = bcryptjs_1.default.hashSync('TuLinh@789', 10);
                    this.save();
                    console.log('[DB] Đã tự động đổi mật khẩu admin sang TuLinh@789 thành công.');
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
    bindLiveDevice(userId, deviceUuid, deviceModel) {
        // Tìm thiết bị hiện tại của user
        const existing = this.data.userDevices.find(d => d.userId === userId);
        if (existing) {
            if (existing.deviceUuid !== deviceUuid) {
                throw new Error('Tài khoản đã được gán cố định cho thiết bị khác! Hãy liên hệ Admin để Reset.');
            }
            existing.lastLogin = new Date().toISOString();
            this.save();
            return existing;
        }
        const newDevice = {
            id: 'dev-' + Date.now(),
            userId,
            deviceUuid,
            deviceModel,
            isLiveDevice: true,
            lastLogin: new Date().toISOString()
        };
        this.data.userDevices.push(newDevice);
        this.save();
        return newDevice;
    }
    resetUserDevice(userId) {
        this.data.userDevices = this.data.userDevices.filter(d => d.userId !== userId);
        this.save();
        return true;
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
