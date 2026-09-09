import express from 'express';
import http from 'http';
import cors from 'cors';
import os from 'os';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
import { streamRouter, setSocketServer } from './routes/stream';
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

// TEMP DEBUG LOGGING — giúp xác định request /api có tới server không, tới qua host nào,
// và mất bao lâu để trả response. Xoá sau khi debug xong.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const start = Date.now();
  console.log(`[REQ] ${req.method} ${req.path} | host=${req.headers.host} | from=${req.ip}`);
  res.on('finish', () => {
    console.log(`[RES] ${req.method} ${req.path} | status=${res.statusCode} | ${Date.now() - start}ms`);
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log(`[REQ-DROPPED] ${req.method} ${req.path} | client closed connection after ${Date.now() - start}ms`);
    }
  });
  next();
});

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
// QUAN TRỌNG: khi iPhone kết nối qua tunnel, trả về URL RTMP dựa trên Host header thay vì IP LAN.
app.get('/api/server-info', (req, res) => {
  const ips = getLocalIpAddresses();
  const primaryIp = ips[0] || 'localhost';
  const { rtmpHost, rtmpPort } = resolveRtmpHostForClient(req);
  res.json({
    status: 'ok',
    ips,
    primaryIp,
    serverUrl: `http://${primaryIp}:${PORT}`,
    // iOS cần biết cổng RTMP (1935) để push, và đường HLS (8000) để admin preview nếu cần.
    rtmpIngestUrl: `rtmp://${rtmpHost}:${rtmpPort}/live`,
    hlsBaseUrl: resolveHlsBaseUrl(req),
    port: PORT
  });
});

/**
 * Xác định host:port RTMP phù hợp với client đang kết nối.
 * - Nếu request qua Cloudflare tunnel / ngrok -> trả về host đó.
 * - Nếu request qua IP LAN -> trả về IP LAN.
 * - Override qua header X-RTMP-Host / X-RTMP-Port.
 */
function resolveRtmpHostForClient(req: express.Request): { rtmpHost: string; rtmpPort: number } {
  const overrideHost = (req.headers['x-rtmp-host'] as string | undefined)?.trim();
  const overridePort = parseInt((req.headers['x-rtmp-port'] as string | undefined) || '');

  if (overrideHost) {
    return { rtmpHost: overrideHost, rtmpPort: overridePort || 1935 };
  }

  const hostHeader = (req.headers.host || '').split(':')[0];

  if (hostHeader.endsWith('trycloudflare.com') || hostHeader.endsWith('.ngrok.io') || hostHeader.endsWith('.ngrok-free.app')) {
    return { rtmpHost: hostHeader, rtmpPort: overridePort || 1935 };
  }

  const ips = getLocalIpAddresses();
  const primaryIp = ips[0] || 'localhost';
  if (hostHeader === primaryIp) {
    return { rtmpHost: primaryIp, rtmpPort: 1935 };
  }

  return { rtmpHost: primaryIp, rtmpPort: 1935 };
}

/**
 * QUAN TRỌNG: proxy /live/* (HLS .m3u8 + .ts do NMS/ffmpeg sinh ra ở port 8000 nội bộ) qua
 * chính port 4000 này. Lý do:
 *   - Cloudflare Quick Tunnel chỉ forward 1 port (4000). Nếu trả về link
 *     "http://<lan-ip>:8000/live/..." thì trình duyệt (đang mở trang qua HTTPS tunnel) sẽ
 *     bị chặn bởi Mixed Content (http trong trang https) VÀ CORS Private Network Access
 *     (domain public không được phép gọi thẳng vào IP LAN riêng).
 *   - Proxy qua cùng port/host mà trình duyệt đang kết nối -> luôn same-origin, same-protocol,
 *     không còn Mixed Content, không còn CORS/private-network nữa, không cần mở thêm tunnel.
 */
app.use('/live', (req, res) => {
  const targetPath = req.originalUrl; // đã bao gồm /live/...
  const proxyReq = http.request(
    {
      hostname: 'localhost',
      port: 8000,
      path: targetPath,
      method: req.method,
      headers: { ...req.headers, host: 'localhost:8000' }
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    }
  );
  proxyReq.on('error', (err) => {
    console.error('[HLS Proxy] Lỗi khi proxy tới localhost:8000:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'HLS media server (port 8000) không phản hồi.' });
  });
  req.pipe(proxyReq, { end: true });
});

/**
 * Xác định base URL public mà trình duyệt/app dùng để tải HLS (.m3u8/.ts), LUÔN cùng
 * host:port + protocol với chính request đang gọi /api/... -> nhờ có proxy /live ở trên nên
 * điều này đúng cho cả 3 trường hợp: LAN, Cloudflare tunnel (HTTPS), hay override thủ công.
 */
function resolveHlsBaseUrl(req: { headers: any; protocol?: string }): string {
  const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol || 'http';
  const host = (req.headers.host as string) || `localhost:${PORT}`;
  return `${proto}://${host}/live`;
}


const webDistPath = path.resolve(__dirname, '../../web/dist');
app.use(express.static(webDistPath));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexPath = path.join(webDistPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) next();
  });
});

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

function normalizeDataItem(rawStr: string): string {
  let s = rawStr.trim();
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
  return s.toUpperCase();
}

// Socket.io chỉ lo: room join, card add/edit/delete, GPS, stream lifecycle.
// Toàn bộ video đi qua NMS/RTMP -> HLS (.ts + .m3u8) và web player tự fetch playlist, không
// broadcast frame qua socket nữa.
io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  socket.on('join_room', (data) => {
    const roomId = data?.roomId || 'default';
    const role = data?.role;

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
    // QUAN TRỌNG: dùng resolveRtmpHostForClient để khi mobile kết nối qua tunnel thì socket cũng
    // nhận được URL đúng dạng tunnel, không phải IP LAN.
    const fakeReq = { headers: socket.handshake.headers } as any;
    const { rtmpHost, rtmpPort } = resolveRtmpHostForClient(fakeReq);

    socket.emit('initial_state', {
      roomId,
      activeStream: activeStream || null,
      latestGps: latestGps || null,
      cardEntries,
      groupNames: db.getGroupNames(roomId),
      serverIps: ips,
      serverUrl: `http://${primaryIp}:${PORT}`,
      rtmpIngestUrl: `rtmp://${rtmpHost}:${rtmpPort}/live`,
      hlsBaseUrl: resolveHlsBaseUrl(fakeReq)
    });
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

// Start Native RTMP/HLS Media Server — đây là nơi duy nhất lưu trữ video (segment .ts + playlist .m3u8).
startNativeMediaServer();

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIpAddresses();
  console.log(`Backend Server running on port ${PORT} (Bound to 0.0.0.0)`);
  console.log(`Địa chỉ kết nối từ iPhone trong cùng mạng Wi-Fi:`);
  ips.forEach(ip => {
    console.log(`   -> http://${ip}:${PORT}`);
    console.log(`   -> RTMP ingest: rtmp://${ip}:1935/live`);
    console.log(`   -> HLS playlist: http://${ip}:8000/live/<streamKey>/index.m3u8`);
  });
});
