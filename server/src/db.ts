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

export interface UserDevice {
  id: string;
  userId: string;
  deviceUuid: string;
  deviceModel: string;
  isLiveDevice: boolean;
  lastLogin: string;
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
      } catch (e) {
        console.error('Error reading database file, initializing fresh:', e);
        this.seedDefaultAdmin();
      }
    } else {
      this.seedDefaultAdmin();
    }
  }

  private save() {
    fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  private seedDefaultAdmin() {
    const adminPassword = bcrypt.hashSync('admin123', 10);
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
    console.log('Database initialized with default admin (admin/admin123) and user (demouser/user123)');
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

  bindLiveDevice(userId: string, deviceUuid: string, deviceModel: string): UserDevice {
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

    const newDevice: UserDevice = {
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

  resetUserDevice(userId: string): boolean {
    this.data.userDevices = this.data.userDevices.filter(d => d.userId !== userId);
    this.save();
    return true;
  }

  // Stream Sessions
  getStreamSessions(): StreamSession[] {
    return this.data.streamSessions;
  }

  getActiveStream(userId?: string): StreamSession | undefined {
    if (userId) {
      return this.data.streamSessions.find(s => s.userId === userId && s.status === 'LIVE');
    }
    return this.data.streamSessions.find(s => s.status === 'LIVE');
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
}

export const db = new Database();
