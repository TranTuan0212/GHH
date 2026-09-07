export interface User {
  id: string;
  username: string;
  role: 'ADMIN' | 'USER';
  isBlocked: boolean;
  expiresAt: string;
  isExpired?: boolean;
  createdAt?: string;
  assignedRoom?: string;
  devices?: UserDevice[];
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
  roomId?: string;
  vodUrl?: string;
  startedAt: string;
  endedAt?: string;
}

export interface GpsLog {
  id: string;
  streamId: string;
  userId: string;
  roomId?: string;
  lat: number;
  lng: number;
  recordedAt: string;
}

export interface DataEntry {
  id: string;
  streamId: string;
  userId: string;
  roomId?: string;
  cardValue: string;
  itemValue?: string;
  groupIndex: number; // 1, 2, 3...
  sequenceOrder: number;
  createdAt: string;
}

export type CardEntry = DataEntry;
