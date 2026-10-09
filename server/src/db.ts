import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: 'ADMIN' | 'USER';
  isBlocked: boolean;
  expiresAt: string; // ISO string
  createdAt: string;
}

export type AppType = 'APP_LIVE' | 'APP_INPUT';

export interface UserDevice {
  id: string;
  userId: string;
  deviceUuid: string;
  deviceModel: string;
  appType: AppType;
  deviceFingerprint?: string;
  isLiveDevice: boolean;
  lastLogin: string;
  createdAt?: string;
  activatedAt?: string;
  expiresAt?: string;
  voiceKey?: string;
  voiceUnlocked?: boolean;
}


export interface VoiceLicense {
  id: string;
  deviceFingerprint: string;
  deviceModel: string;
  userId?: string;
  licenseKey: string;
  registeredAt: string;
  expiresAt: string; // ISO string or 'LIFETIME'
  isLifetime: boolean;
  activatedAt?: string;
  isUsed: boolean;
  renewalHistory?: Array<{
    key: string;
    addedDays: number | 'LIFETIME';
    renewedAt: string;
    newExpiresAt: string;
  }>;
}


export interface StreamSession {
  id: string;
  userId: string;
  username: string;
  streamKey: string;
  status: 'LIVE' | 'ENDED';
  vodUrl: string;
  // URL playlist HLS (http://<host>:8000/live/<streamKey>/index.m3u8) — do NMS/FFmpeg sinh ra.
  // Web player dùng URL này để mở bằng hls.js, không cần server push frame qua socket.
  hlsPlaylistUrl?: string;
  startedAt: string;
  endedAt?: string;
}

export interface GpsLog {
  id: string;
  streamId: string;
  userId: string;
  lat: number;
  lng: number;
  recordedAt: string;
}

export interface DataEntry {
  id: string;
  streamId: string;
  userId: string;
  cardValue: string;
  itemValue?: string;
  groupIndex: number; // 1, 2, 3...
  sequenceOrder: number;
  createdAt: string;
}

export type CardEntry = DataEntry;

interface DatabaseSchema {
  users: User[];
  userDevices: UserDevice[];
  voiceLicenses?: VoiceLicense[];
  streamSessions: StreamSession[];
  gpsLogs: GpsLog[];
  cardEntries: CardEntry[];
  groupNames?: { [roomId: string]: { [groupIndex: number]: string } };
}

const DB_FILE = path.join(__dirname, '../data/database.json');

class Database {
  private data: DatabaseSchema;

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

  private init() {
    const dataDir = path.dirname(DB_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
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
          if (!bcrypt.compareSync(targetPassword, admin.passwordHash)) {
            admin.passwordHash = bcrypt.hashSync(targetPassword, 10);
            this.save();
            console.log('[DB] Đã cập nhật mật khẩu admin về "' + targetPassword + '" thành công.');
          }
        }
      } catch (e) {
        console.error('Error reading database file, initializing fresh:', e);
        this.seedDefaultAdmin();
      }
    } else {
      this.seedDefaultAdmin();
    }
  }

  public save() {
    fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  private seedDefaultAdmin() {
    const adminPassword = bcrypt.hashSync('TuLinh@789', 10);
    const userPassword = bcrypt.hashSync('user123', 10);

    const defaultAdmin: User = {
      id: 'admin-uuid-0001',
      username: 'admin',
      passwordHash: adminPassword,
      role: 'ADMIN',
      isBlocked: false,
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString()
    };

    const defaultUser: User = {
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
  getUsers(): User[] {
    return this.data.users;
  }

  getUserById(id: string): User | undefined {
    return this.data.users.find(u => u.id === id);
  }

  getUserByUsername(username: string): User | undefined {
    return this.data.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  }

  createUser(user: User): User {
    this.data.users.push(user);
    this.save();
    return user;
  }

  updateUser(id: string, updates: Partial<User>): User | undefined {
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
                lic.expiresAt = updates.expiresAt!;
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


  deleteUser(id: string): boolean {
    const initialLen = this.data.users.length;
    this.data.users = this.data.users.filter(u => u.id !== id);
    this.data.userDevices = this.data.userDevices.filter(d => d.userId !== id);
    this.save();
    return this.data.users.length < initialLen;
  }

  // Devices
  getDevicesByUserId(userId: string): UserDevice[] {
    return this.data.userDevices.filter(d => d.userId === userId);
  }

  getDeviceByUuid(deviceUuid: string): UserDevice | undefined {
    return this.data.userDevices.find(d => d.deviceUuid === deviceUuid);
  }

  unlockDeviceVoice(deviceFingerprint: string, licenseKey: string): void {
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
  bindDevice(
    userId: string,
    deviceUuid: string,
    deviceModel: string,
    appType: AppType = 'APP_LIVE',
    deviceFingerprint?: string
  ): UserDevice {
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
        if (deviceFingerprint) existingLive.deviceFingerprint = deviceFingerprint;
        existingLive.appType = 'APP_LIVE';
        existingLive.isLiveDevice = true;
        existingLive.activatedAt = existingLive.activatedAt || existingLive.createdAt || new Date().toISOString();
        existingLive.expiresAt = userExpiresAt;
        this.save();
        return existingLive;
      }

      // Tạo mới slot Live duy nhất
      const nowIso = new Date().toISOString();
      const newLive: UserDevice = {
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
    } else {
      // APP_INPUT: Tối đa 2 máy
      const inputDevices = userDevices.filter(d => d.appType === 'APP_INPUT');
      const existingInput = inputDevices.find(d => d.deviceUuid === deviceUuid);

      if (existingInput) {
        existingInput.lastLogin = new Date().toISOString();
        existingInput.deviceModel = deviceModel || existingInput.deviceModel;
        if (deviceFingerprint) existingInput.deviceFingerprint = deviceFingerprint;
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
      const newInput: UserDevice = {
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


  bindLiveDevice(userId: string, deviceUuid: string, deviceModel: string): UserDevice {
    return this.bindDevice(userId, deviceUuid, deviceModel, 'APP_LIVE');
  }

  resetUserDevice(userId: string): boolean {
    this.data.userDevices = this.data.userDevices.filter(d => d.userId !== userId);
    this.save();
    return true;
  }

  resetUserDeviceByType(userId: string, appType: AppType): boolean {
    const beforeCount = this.data.userDevices.length;
    const removedFingerprints = new Set<string>();

    this.data.userDevices = this.data.userDevices.filter(d => {
      if (d.userId !== userId) return true;
      if (appType === 'APP_LIVE') return !(d.appType === 'APP_LIVE' || d.isLiveDevice);
      if (d.appType === 'APP_INPUT') {
        if (d.deviceFingerprint) removedFingerprints.add(d.deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''));
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
  getAllVoiceLicenses(): VoiceLicense[] {
    return this.data.voiceLicenses || [];
  }

  getVoiceLicenseByDevice(deviceFingerprint: string, userId?: string): VoiceLicense | undefined {
    const norm = deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (this.data.voiceLicenses || []).find(l => {
      const licNorm = l.deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (licNorm !== norm) return false;
      if (userId && l.userId) {
        return l.userId === userId;
      }
      return true;
    });
  }

  getVoiceLicenseByKey(licenseKey: string): VoiceLicense | undefined {
    const cleanKey = licenseKey.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (this.data.voiceLicenses || []).find(l => {
      const lClean = l.licenseKey.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      return lClean === cleanKey;
    });
  }

  createVoiceLicense(license: VoiceLicense): VoiceLicense {
    if (!this.data.voiceLicenses) this.data.voiceLicenses = [];
    this.data.voiceLicenses.push(license);
    this.save();
    return license;
  }

  activateVoiceLicense(licenseKey: string, deviceFingerprint: string, deviceModel: string): VoiceLicense {
    if (!this.data.voiceLicenses) this.data.voiceLicenses = [];
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

  renewVoiceLicense(
    newKey: string,
    deviceFingerprint: string,
    addedDays: number | 'LIFETIME'
  ): VoiceLicense {
    if (!this.data.voiceLicenses) this.data.voiceLicenses = [];
    const normFp = deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

    let lic = this.data.voiceLicenses.find(l => l.deviceFingerprint.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') === normFp);
    const now = new Date();

    if (!lic) {
      throw new Error('Thiết bị này chưa từng được đăng ký trong hệ thống.');
    }

    if (addedDays === 'LIFETIME') {
      lic.isLifetime = true;
      lic.expiresAt = new Date(now.getTime() + 100 * 365 * 24 * 3600 * 1000).toISOString();
    } else {
      let currentExpiry = new Date(lic.expiresAt);
      if (isNaN(currentExpiry.getTime()) || currentExpiry < now) {
        currentExpiry = now; // Nếu đã hết hạn, tính từ hôm nay
      }
      lic.expiresAt = new Date(currentExpiry.getTime() + addedDays * 24 * 3600 * 1000).toISOString();
      lic.isLifetime = false;
    }

    if (!lic.renewalHistory) lic.renewalHistory = [];
    lic.renewalHistory.push({
      key: newKey,
      addedDays,
      renewedAt: now.toISOString(),
      newExpiresAt: lic.expiresAt
    });

    this.save();
    return lic;
  }

  deleteVoiceLicense(id: string): boolean {
    if (!this.data.voiceLicenses) return false;
    const initialLen = this.data.voiceLicenses.length;
    this.data.voiceLicenses = this.data.voiceLicenses.filter(l => l.id !== id);
    this.save();
    return this.data.voiceLicenses.length < initialLen;
  }


  // Stream Sessions
  getStreamSessions(): StreamSession[] {
    return this.data.streamSessions;
  }

  getStreams(): StreamSession[] {
    return this.data.streamSessions;
  }

  getActiveStream(userId?: string): StreamSession | undefined {
    if (userId) {
      return this.data.streamSessions.find(s => s.userId === userId && s.status === 'LIVE');
    }
    return this.data.streamSessions.find(s => s.status === 'LIVE');
  }

  getLatestStream(userId?: string): StreamSession | undefined {
    const list = userId
      ? this.data.streamSessions.filter(s => s.userId === userId)
      : this.data.streamSessions;
    if (list.length === 0) return undefined;
    // Ưu tiên luồng đang LIVE, nếu không còn LIVE thì trả về phiên vừa kết thúc gần nhất để xem lại DVR
    return list.find(s => s.status === 'LIVE') || list[list.length - 1];
  }

  createStreamSession(session: StreamSession): StreamSession {
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

  endStreamSession(streamId: string, vodUrl?: string): StreamSession | undefined {
    const session = this.data.streamSessions.find(s => s.id === streamId || (s.status === 'LIVE' && s.userId === streamId));
    if (session) {
      session.status = 'ENDED';
      session.endedAt = new Date().toISOString();
      if (vodUrl) session.vodUrl = vodUrl;
      this.save();
    }
    return session;
  }

  endStreamSessionByStreamKey(streamKey: string): StreamSession | undefined {
    const session = this.data.streamSessions.find(s => s.streamKey === streamKey && s.status === 'LIVE');
    if (session) {
      session.status = 'ENDED';
      session.endedAt = new Date().toISOString();
      this.save();
    }
    return session;
  }

  removeEndedStreams(userId?: string): number {
    const initialCount = this.data.streamSessions.length;
    this.data.streamSessions = this.data.streamSessions.filter(s => {
      if (s.status === 'LIVE') return true;
      if (userId && s.userId !== userId) return true;
      return false;
    });
    const removed = initialCount - this.data.streamSessions.length;
    if (removed > 0) {
      this.save();
    }
    return removed;
  }

  resetStreamStartTime(streamIdOrKey: string): StreamSession | undefined {
    const session = this.data.streamSessions.find(s => s.id === streamIdOrKey || s.streamKey === streamIdOrKey);
    if (session) {
      session.startedAt = new Date().toISOString();
      this.save();
    }
    return session;
  }

  // GPS Logs
  addGpsLog(log: GpsLog) {
    this.data.gpsLogs.push(log);
    if (this.data.gpsLogs.length > 1000) {
      this.data.gpsLogs.shift();
    }
    this.save();
  }

  getLatestGpsLog(userId?: string): GpsLog | undefined {
    if (userId) {
      return [...this.data.gpsLogs].reverse().find(g => g.userId === userId);
    }
    return this.data.gpsLogs[this.data.gpsLogs.length - 1];
  }

  // Card Entries theo từng Room (userId)
  getCardEntries(userIdOrStreamId?: string): CardEntry[] {
    if (userIdOrStreamId) {
      return this.data.cardEntries.filter(
        c => c.userId === userIdOrStreamId || c.streamId === userIdOrStreamId
      );
    }
    return this.data.cardEntries;
  }

  addCardEntry(entry: CardEntry): CardEntry {
    this.data.cardEntries.push(entry);
    this.save();
    return entry;
  }

  clearCardEntries(userIdOrStreamId?: string) {
    if (userIdOrStreamId) {
      this.data.cardEntries = this.data.cardEntries.filter(
        c => c.userId !== userIdOrStreamId && c.streamId !== userIdOrStreamId
      );
    } else {
      this.data.cardEntries = [];
    }
    this.save();
  }

  popCardEntry(userIdOrStreamId?: string): CardEntry | undefined {
    if (this.data.cardEntries.length === 0) return undefined;
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

  updateCardEntry(id: string, newCardValue: string): CardEntry | undefined {
    const entry = this.data.cardEntries.find(c => c.id === id);
    if (entry) {
      entry.cardValue = newCardValue.trim().toUpperCase();
      entry.itemValue = entry.cardValue;
      this.save();
      return entry;
    }
    return undefined;
  }

  deleteCardEntry(id: string): CardEntry | undefined {
    const index = this.data.cardEntries.findIndex(c => c.id === id);
    if (index !== -1) {
      const [removed] = this.data.cardEntries.splice(index, 1);
      this.save();
      return removed;
    }
    return undefined;
  }

  getGroupNames(roomId: string = 'default'): { [groupIndex: number]: string } {
    if (!this.data.groupNames) this.data.groupNames = {};
    return this.data.groupNames[roomId] || {};
  }

  setGroupNames(roomId: string = 'default', names: { [groupIndex: number]: string }) {
    if (!this.data.groupNames) this.data.groupNames = {};
    this.data.groupNames[roomId] = names;
    this.save();
  }

  // Tự động dọn dẹp các dữ liệu bài (cardEntries) và phiên live (streamSessions) cũ đã qua maxAgeSeconds (mặc định 24h)
  cleanupOldData(maxAgeSeconds: number = 24 * 3600): { cleanedSessions: number; cleanedCards: number } {
    const nowMs = Date.now();
    const thresholdMs = nowMs - maxAgeSeconds * 1000;

    const initialCards = this.data.cardEntries.length;
    this.data.cardEntries = this.data.cardEntries.filter(c => {
      if (!c.createdAt) return true;
      const t = new Date(c.createdAt).getTime();
      return isNaN(t) || t >= thresholdMs;
    });
    const cleanedCards = initialCards - this.data.cardEntries.length;

    const initialSessions = this.data.streamSessions.length;
    this.data.streamSessions = this.data.streamSessions.filter(s => {
      if (s.status === 'LIVE') return true;
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

export const db = new Database();
