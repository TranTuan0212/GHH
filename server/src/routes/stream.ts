import { Router, Response } from 'express';
import { db, CardEntry, GpsLog, StreamSession } from '../db';
import { authMiddleware, AuthRequest } from './auth';

export const streamRouter = Router();

// Store latest live frame buffer for instant Web DVR playback per room
export const dvrFrameBuffers: { [roomId: string]: { frame: string; timestamp: number }[] } = {};
export const latestLiveFrames: { [roomId: string]: { frame: string; timestamp: number } | null } = {};
export const dvrBinaryBuffers: { [roomId: string]: Buffer[] } = {};

export function getDvrBuffer(roomId: string = 'default') {
  if (!dvrFrameBuffers[roomId]) {
    dvrFrameBuffers[roomId] = [];
  }
  return dvrFrameBuffers[roomId];
}

export function getDvrBinaryBuffer(roomId: string = 'default') {
  if (!dvrBinaryBuffers[roomId]) {
    dvrBinaryBuffers[roomId] = [];
  }
  return dvrBinaryBuffers[roomId];
}

// Fallback exports for index.ts
export const dvrFrameBuffer = getDvrBuffer('default');
export let latestLiveFrame: { frame: string; timestamp: number } | null = null;

// Socket.io instance placeholder (set in index.ts)
let globalIo: any = null;
export function setSocketServer(io: any) {
  globalIo = io;
}

// POST /api/stream/frame - Mobile iOS client uploads video frame
streamRouter.post('/frame', authMiddleware, (req: AuthRequest, res: Response) => {
  const { frame, timestamp } = req.body;
  const roomId = req.user?.id || req.body.roomId || 'default';
  if (!frame) {
    return res.status(400).json({ error: 'Thiếu dữ liệu khung hình video.' });
  }

  const frameObj = {
    roomId,
    frame,
    timestamp: timestamp || Date.now()
  };

  latestLiveFrames[roomId] = frameObj;
  latestLiveFrame = frameObj;
  const buffer = getDvrBuffer(roomId);
  buffer.push(frameObj);
  // Keep last 1800 frames (~30 seconds - 1 min of high quality DVR frame buffer)
  if (buffer.length > 1800) {
    buffer.shift();
  }

  if (globalIo) {
    globalIo.to(`room_${roomId}`).emit('live_frame_received', frameObj);
    globalIo.to('room_admin').emit('live_frame_received', frameObj);
  }

  res.json({ status: 'ok' });
});

// GET /api/stream/active - Public or authenticated info about current live stream
streamRouter.get('/active', (req, res) => {
  const targetRoomId = (req.query.roomId as string) || (req.query.userId as string);
  const activeStream = db.getActiveStream(targetRoomId);
  const latestGps = db.getLatestGpsLog(targetRoomId);
  const cardEntries = db.getCardEntries(targetRoomId);

  res.json({
    roomId: targetRoomId || 'default',
    stream: activeStream || null,
    gps: latestGps || null,
    cardEntries,
    latestFrame: (targetRoomId && latestLiveFrames[targetRoomId]) || latestLiveFrame
  });
});

// POST /api/stream/start - Mobile starts streaming
streamRouter.post('/start', authMiddleware, (req: AuthRequest, res: Response) => {
  if (req.user?.platform !== 'mobile') {
    return res.status(403).json({ error: 'Chỉ ứng dụng iOS di động mới có quyền khởi tạo Live Stream!' });
  }

  const roomId = req.user.id;
  const streamKey = 'live_' + roomId + '_' + Date.now();
  const newStream: StreamSession = {
    id: 'stream-' + Date.now(),
    userId: roomId,
    username: req.user.username,
    streamKey,
    status: 'LIVE',
    vodUrl: '',
    startedAt: new Date().toISOString()
  };

  db.createStreamSession(newStream);
  db.clearCardEntries(roomId);
  const buffer = getDvrBuffer(roomId);
  buffer.length = 0;
  latestLiveFrames[roomId] = null;

  if (globalIo) {
    globalIo.to(`room_${roomId}`).emit('stream_status_changed', { roomId, status: 'LIVE', session: newStream });
    globalIo.to('room_admin').emit('stream_status_changed', { roomId, status: 'LIVE', session: newStream });
  }

  res.json({
    message: 'Khởi tạo luồng Live Stream 240fps thành công cho Room.',
    stream: newStream,
    rtmpIngestUrl: `rtmp://localhost:1935/live/${streamKey}`
  });
});

// POST /api/stream/end - Mobile ends streaming
streamRouter.post('/end', authMiddleware, (req: AuthRequest, res: Response) => {
  const roomId = req.user?.id || req.body.streamId;
  const ended = db.endStreamSession(roomId);

  if (globalIo) {
    globalIo.to(`room_${roomId}`).emit('stream_status_changed', { roomId, status: 'ENDED', session: ended });
    globalIo.to('room_admin').emit('stream_status_changed', { roomId, status: 'ENDED', session: ended });
  }

  res.json({ message: 'Đã dừng Live Stream Room.', stream: ended });
});

// POST /api/stream/gps - Mobile sends periodic GPS updates
streamRouter.post('/gps', authMiddleware, (req: AuthRequest, res: Response) => {
  const { lat, lng, streamId } = req.body;

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'Tọa độ GPS lat/lng không hợp lệ.' });
  }

  const gpsLog: GpsLog = {
    id: 'gps-' + Date.now(),
    streamId: streamId || db.getActiveStream()?.id || 'default-stream',
    userId: req.user!.id,
    lat,
    lng,
    recordedAt: new Date().toISOString()
  };

  db.addGpsLog(gpsLog);

  if (globalIo) {
    globalIo.emit('gps_updated', gpsLog);
  }

  res.json({ status: 'ok', gps: gpsLog });
});

// GET /api/stream/items (or /cards) - Get data entries
const getEntriesHandler = (req: any, res: Response) => {
  const entries = db.getCardEntries();
  res.json({ entries });
};
streamRouter.get('/items', getEntriesHandler);
streamRouter.get('/cards', getEntriesHandler);

// POST /api/stream/items (or /cards) - Add a new data entry (Round Robin auto-grouped)
const addEntryHandler = (req: AuthRequest, res: Response) => {
  const { cardValue, groupCount } = req.body;

  if (!cardValue) {
    return res.status(400).json({ error: 'Vui lòng nhập mã dữ liệu.' });
  }

  const numGroups = parseInt(groupCount) || 3;
  const existingEntries = db.getCardEntries();
  const sequenceOrder = existingEntries.length + 1;
  const groupIndex = ((sequenceOrder - 1) % numGroups) + 1;

  const newEntry: CardEntry = {
    id: 'item-' + Date.now(),
    streamId: db.getActiveStream()?.id || 'live-session',
    userId: req.user!.id,
    cardValue: cardValue.toString().toUpperCase(),
    groupIndex,
    sequenceOrder,
    createdAt: new Date().toISOString()
  };

  db.addCardEntry(newEntry);

  if (globalIo) {
    globalIo.emit('card_added', { entry: newEntry, allEntries: db.getCardEntries() });
  }

  res.json({ message: 'Đã phân loại mã dữ liệu vào nhóm thành công', entry: newEntry });
};
streamRouter.post('/items', authMiddleware, addEntryHandler);
streamRouter.post('/cards', authMiddleware, addEntryHandler);

// DELETE /api/stream/items (or /cards) - Clear entries
const clearEntriesHandler = (req: AuthRequest, res: Response) => {
  db.clearCardEntries();
  if (globalIo) {
    globalIo.emit('cards_cleared');
  }
  res.json({ message: 'Đã xóa toàn bộ danh sách dữ liệu.' });
};
streamRouter.delete('/items', authMiddleware, clearEntriesHandler);
streamRouter.delete('/cards', authMiddleware, clearEntriesHandler);
