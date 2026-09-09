import { Router, Response } from 'express';
import { db, CardEntry, GpsLog, StreamSession } from '../db';
import { authMiddleware, AuthRequest } from './auth';
import os from 'os';
import { cleanupStreamSession } from '../mediaServer';

export const streamRouter = Router();

let globalIo: any = null;
export function setSocketServer(io: any) {
  globalIo = io;
}

function getPrimaryIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

/**
 * Video segment storage: toàn bộ .ts + .m3u8 do NMS/FFmpeg sinh ra tại:
 *   <media_root>/live/<streamKey>/
 *
 * Đơn vị lưu trữ = segment video đã nén. Không còn buffer ảnh rời trong RAM.
 * Xem chi tiết quản lý DVR window ở mediaServer.ts.
 */

// POST /api/stream/start
streamRouter.post('/start', authMiddleware, (req: AuthRequest, res: Response) => {
  if (req.user?.platform !== 'mobile') {
    return res.status(403).json({ error: 'Chỉ ứng dụng iOS di động mới có quyền khởi tạo Live Stream!' });
  }

  const roomId = req.user.id;
  const streamKey = 'live_' + roomId + '_' + Date.now();
  const primaryIp = getPrimaryIp();

  const newStream: StreamSession = {
    id: 'stream-' + Date.now(),
    userId: roomId,
    username: req.user.username,
    streamKey,
    status: 'LIVE',
    hlsPlaylistUrl: `http://${primaryIp}:8000/live/${streamKey}/index.m3u8`,
    vodUrl: '',
    startedAt: new Date().toISOString()
  };

  db.createStreamSession(newStream);
  db.clearCardEntries(roomId);

  if (globalIo) {
    globalIo.to(`room_${roomId}`).emit('stream_status_changed', { roomId, status: 'LIVE', session: newStream });
    globalIo.to('room_admin').emit('stream_status_changed', { roomId, status: 'LIVE', session: newStream });
  }

  res.json({
    message: 'Khởi tạo luồng Live Stream 240fps thành công.',
    stream: newStream,
    rtmpIngestUrl: `rtmp://${primaryIp}:1935/live`,
    streamKey
  });
});

// POST /api/stream/end — cleanup segment files + end session
streamRouter.post('/end', authMiddleware, (req: AuthRequest, res: Response) => {
  const roomId = req.user?.id || req.body.streamId;
  const session = db.getActiveStream(roomId);
  const streamKey = session?.streamKey;
  const ended = db.endStreamSession(roomId);

  // Xoá toàn bộ file .ts + .m3u8 của session này ngay lập tức
  // để giải phóng dung lượng ổ đĩa.
  if (streamKey) {
    cleanupStreamSession(streamKey);
  }

  if (globalIo) {
    globalIo.to(`room_${roomId}`).emit('stream_status_changed', { roomId, status: 'ENDED', session: ended });
    globalIo.to('room_admin').emit('stream_status_changed', { roomId, status: 'ENDED', session: ended });
  }

  res.json({ message: 'Đã dừng Live Stream và dọn dẹp segment video.', stream: ended });
});

// POST /api/stream/gps
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

// GET /api/stream/active
streamRouter.get('/active', (req, res) => {
  const targetRoomId = (req.query.roomId as string) || (req.query.userId as string);
  const activeStream = db.getActiveStream(targetRoomId);
  const latestGps = db.getLatestGpsLog(targetRoomId);
  const cardEntries = db.getCardEntries(targetRoomId);

  res.json({
    roomId: targetRoomId || 'default',
    stream: activeStream || null,
    gps: latestGps || null,
    cardEntries
  });
});

// GET /api/stream/items (or /cards)
const getEntriesHandler = (req: any, res: Response) => {
  res.json({ entries: db.getCardEntries() });
};
streamRouter.get('/items', getEntriesHandler);
streamRouter.get('/cards', getEntriesHandler);

// POST /api/stream/items (or /cards)
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

  res.json({ message: 'Đã phân loại mã dữ liệu thành công', entry: newEntry });
};
streamRouter.post('/items', authMiddleware, addEntryHandler);
streamRouter.post('/cards', authMiddleware, addEntryHandler);

// DELETE /api/stream/items (or /cards)
const clearEntriesHandler = (req: AuthRequest, res: Response) => {
  db.clearCardEntries();
  if (globalIo) {
    globalIo.emit('cards_cleared');
  }
  res.json({ message: 'Đã xóa toàn bộ danh sách dữ liệu.' });
};
streamRouter.delete('/items', authMiddleware, clearEntriesHandler);
streamRouter.delete('/cards', authMiddleware, clearEntriesHandler);
