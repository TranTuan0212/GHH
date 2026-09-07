import express from 'express';
import http from 'http';
import cors from 'cors';
import os from 'os';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
import { streamRouter, setSocketServer, getDvrBuffer, latestLiveFrames } from './routes/stream';
import { db } from './db';
import { startNativeMediaServer } from './mediaServer';

const app = express();
const server = http.createServer(app);

// Gracefully handle aborted socket requests (e.g. client dropped network or switched camera)
process.on('uncaughtException', (err: any) => {
  if (err.type === 'request.aborted' || err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.message === 'request aborted') {
    return;
  }
  console.error('[Process Error]', err);
});

const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  },
  maxHttpBufferSize: 1e7
});

setSocketServer(io);

const PORT = parseInt(process.env.PORT || '4000');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Gracefully catch aborted HTTP requests without polluting terminal
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.type === 'request.aborted' || err.code === 'ECONNRESET' || err.message === 'request aborted') {
    return res.status(400).end();
  }
  next(err);
});

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/stream', streamRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', serverTime: new Date().toISOString() });
});

// Server Info (returns detected host LAN IP addresses for mobile app connection)
app.get('/api/server-info', (req, res) => {
  const ips = getLocalIpAddresses();
  const primaryIp = ips[0] || 'localhost';
  res.json({
    status: 'ok',
    ips,
    primaryIp,
    serverUrl: `http://${primaryIp}:${PORT}`,
    port: PORT
  });
});

// Serve Web Frontend Static Files
const webDistPath = path.resolve(__dirname, '../../web/dist');
app.use(express.static(webDistPath));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexPath = path.join(webDistPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) next();
  });
});

// Helper to get Local LAN IP Address
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// Format and normalize clean data item tags (No gambling references)
function normalizeDataItem(rawStr: string): string {
  let s = rawStr.trim();
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
  return s.toUpperCase();
}

// Socket.io Realtime Sync với phân tách Room theo tài khoản
io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // Khi client kết nối, gia nhập Room của tài khoản tương ứng
  socket.on('join_room', (data) => {
    const roomId = data?.roomId || 'default';
    const role = data?.role;

    // Rời khỏi các room cũ (trừ chính socket.id)
    Array.from(socket.rooms).forEach((r) => {
      if (r !== socket.id) socket.leave(r);
    });

    socket.join(`room_${roomId}`);
    if (role === 'ADMIN') {
      socket.join('room_admin');
    }

    const activeStream = db.getActiveStream(roomId);
    const latestGps = db.getLatestGpsLog(roomId);
    const cardEntries = db.getCardEntries(roomId);
    const ips = getLocalIpAddresses();
    const primaryIp = ips[0] || 'localhost';

    socket.emit('initial_state', {
      roomId,
      activeStream: activeStream || null,
      latestGps: latestGps || null,
      cardEntries,
      groupNames: db.getGroupNames(roomId),
      latestFrame: latestLiveFrames[roomId] || null,
      dvrFrames: getDvrBuffer(roomId),
      serverIps: ips,
      serverUrl: `http://${primaryIp}:${PORT}`
    });
  });

  // Mobile gửi khung hình Live 240fps cho Room của mình
  socket.on('send_video_frame', (data) => {
    if (data && data.frame) {
      const roomId = data.roomId || data.userId || 'default';
      const frameObj = {
        roomId,
        frame: data.frame,
        timestamp: data.timestamp || Date.now()
      };
      latestLiveFrames[roomId] = frameObj;
      const buffer = getDvrBuffer(roomId);
      buffer.push(frameObj);
      if (buffer.length > 1800) buffer.shift();

      // Chỉ gửi cho người xem trong Room này và Admin
      io.to(`room_${roomId}`).emit('live_frame_received', frameObj);
      io.to('room_admin').emit('live_frame_received', frameObj);
    }
  });

  socket.on('send_gps', (data) => {
    const { userId, streamId, lat, lng, roomId } = data;
    const targetRoomId = roomId || userId || 'default';
    if (lat && lng) {
      const gpsLog = {
        id: 'gps-' + Date.now(),
        streamId: targetRoomId,
        userId: targetRoomId,
        lat,
        lng,
        recordedAt: new Date().toISOString()
      };
      db.addGpsLog(gpsLog);
      io.to(`room_${targetRoomId}`).emit('gps_updated', gpsLog);
      io.to('room_admin').emit('gps_updated', gpsLog);
    }
  });

  // Phân loại dữ liệu cho Room
  socket.on('add_card', (data) => {
    const { cardValue, groupCount, userId, roomId, targetGroup } = data;
    const targetRoomId = roomId || userId || 'default';
    if (cardValue) {
      const rawItems = cardValue.toString().split(',').map((c: string) => c.trim()).filter((c: string) => c.length > 0);
      const numGroups = parseInt(groupCount) || 3;

      rawItems.forEach((itemStr: string) => {
        const existingEntries = db.getCardEntries(targetRoomId);
        const normalized = normalizeDataItem(itemStr);
        const sequenceOrder = existingEntries.length + 1;
        const groupIndex = targetGroup ? parseInt(targetGroup) : (((sequenceOrder - 1) % numGroups) + 1);

        const newEntry = {
          id: 'item-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
          streamId: targetRoomId,
          userId: targetRoomId,
          cardValue: normalized,
          groupIndex,
          sequenceOrder,
          createdAt: new Date().toISOString()
        };

        db.addCardEntry(newEntry);
      });

      const updated = db.getCardEntries(targetRoomId);
      io.to(`room_${targetRoomId}`).emit('card_added', { roomId: targetRoomId, allEntries: updated });
      io.to('room_admin').emit('card_added', { roomId: targetRoomId, allEntries: updated });
    }
  });

  socket.on('edit_card', (data) => {
    const { id, newCardValue, roomId, userId } = data;
    const targetRoomId = roomId || userId || 'default';
    if (id && newCardValue) {
      db.updateCardEntry(id, newCardValue);
      const updated = db.getCardEntries(targetRoomId);
      io.to(`room_${targetRoomId}`).emit('card_added', { roomId: targetRoomId, allEntries: updated });
      io.to('room_admin').emit('card_added', { roomId: targetRoomId, allEntries: updated });
    }
  });

  socket.on('delete_card', (data) => {
    const { id, roomId, userId } = data;
    const targetRoomId = roomId || userId || 'default';
    if (id) {
      db.deleteCardEntry(id);
      const updated = db.getCardEntries(targetRoomId);
      io.to(`room_${targetRoomId}`).emit('card_added', { roomId: targetRoomId, allEntries: updated });
      io.to('room_admin').emit('card_added', { roomId: targetRoomId, allEntries: updated });
    }
  });

  socket.on('set_group_names', (data) => {
    const { groupNames, roomId, userId } = data;
    const targetRoomId = roomId || userId || 'default';
    if (groupNames) {
      db.setGroupNames(targetRoomId, groupNames);
      io.to(`room_${targetRoomId}`).emit('group_names_updated', { roomId: targetRoomId, groupNames });
      io.to('room_admin').emit('group_names_updated', { roomId: targetRoomId, groupNames });
    }
  });

  socket.on('undo_card', (data) => {
    const targetRoomId = data?.roomId || data?.userId || 'default';
    db.popCardEntry(targetRoomId);
    const updated = db.getCardEntries(targetRoomId);
    io.to(`room_${targetRoomId}`).emit('card_added', { roomId: targetRoomId, allEntries: updated });
    io.to('room_admin').emit('card_added', { roomId: targetRoomId, allEntries: updated });
  });

  socket.on('clear_cards', (data) => {
    const targetRoomId = data?.roomId || data?.userId || 'default';
    db.clearCardEntries(targetRoomId);
    io.to(`room_${targetRoomId}`).emit('cards_cleared', { roomId: targetRoomId });
    io.to('room_admin').emit('cards_cleared', { roomId: targetRoomId });
  });

  socket.on('finish_round', (data) => {
    const targetRoomId = data?.roomId || data?.userId || 'default';
    db.clearCardEntries(targetRoomId);
    const buffer = getDvrBuffer(targetRoomId);
    buffer.length = 0;
    io.to(`room_${targetRoomId}`).emit('round_finished', { roomId: targetRoomId });
    io.to(`room_${targetRoomId}`).emit('cards_cleared', { roomId: targetRoomId });
    io.to('room_admin').emit('round_finished', { roomId: targetRoomId });
    io.to('room_admin').emit('cards_cleared', { roomId: targetRoomId });
  });

  socket.on('toggle_stream', (data) => {
    const targetRoomId = data.roomId || data.userId || 'default';
    if (data.status === 'LIVE') {
      const session = db.createStreamSession({
        id: 'stream-' + Date.now(),
        userId: targetRoomId,
        username: data.username || targetRoomId,
        streamKey: 'live_' + targetRoomId,
        status: 'LIVE',
        vodUrl: '',
        startedAt: new Date().toISOString()
      });
      io.to(`room_${targetRoomId}`).emit('stream_status_changed', { roomId: targetRoomId, status: 'LIVE', session });
      io.to('room_admin').emit('stream_status_changed', { roomId: targetRoomId, status: 'LIVE', session });
    } else {
      const session = db.endStreamSession(data.streamId || targetRoomId);
      io.to(`room_${targetRoomId}`).emit('stream_status_changed', { roomId: targetRoomId, status: 'ENDED', session });
      io.to('room_admin').emit('stream_status_changed', { roomId: targetRoomId, status: 'ENDED', session });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// Start Native RTMP/HLS Media Server
startNativeMediaServer();

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIpAddresses();
  console.log(`🚀 Backend Server running on port ${PORT} (Bound to 0.0.0.0)`);
  console.log(`📌 Địa chỉ kết nối từ iPhone trong cùng mạng Wi-Fi:`);
  ips.forEach(ip => {
    console.log(`   👉 http://${ip}:${PORT}`);
  });
});
