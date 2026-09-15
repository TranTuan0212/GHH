import './env';
import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { Server as SocketIOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { authRouter, JWT_SECRET } from './routes/auth';
import { adminRouter } from './routes/admin';
import { streamRouter, setSocketServer } from './routes/stream';
import { db } from './db';
import { startNativeMediaServer, setStreamEndedHandler, resetReplaySession } from './mediaServer';
import { getLocalIpAddresses, resolveRtmpHostForClient, classifyConnection } from './utils/network';

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

// Middleware xác thực JWT cho mọi kết nối Socket.IO
io.use((socket, next) => {
  const token = (socket.handshake.auth?.token as string) ||
                (socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '') as string) ||
                (socket.handshake.query?.token as string);

  if (!token) {
    (socket as any).user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const user = db.getUserById(decoded.id);
    if (!user) {
      return next(new Error('Tài khoản không tồn tại.'));
    }
    if (user.isBlocked) {
      return next(new Error('Tài khoản đã bị khóa bởi Admin.'));
    }
    if (new Date(user.expiresAt) < new Date()) {
      return next(new Error('Tài khoản đã hết hạn sử dụng.'));
    }

    (socket as any).user = {
      id: user.id,
      username: user.username,
      role: user.role,
      platform: decoded.platform
    };
    next();
  } catch (err) {
    return next(new Error('Token xác thực Socket không hợp lệ hoặc đã hết hạn.'));
  }
});

setSocketServer(io);
setStreamEndedHandler((streamKey) => {
  let ended = db.endStreamSessionByStreamKey(streamKey);
  if (!ended) {
    ended = db.getStreams().find(s => s.streamKey === streamKey);
  }
  if (!ended) return;
  io.to(`room_${ended.userId}`).emit('stream_status_changed', { roomId: ended.userId, status: 'ENDED', session: ended });
  io.to('room_admin').emit('stream_status_changed', { roomId: ended.userId, status: 'ENDED', session: ended });
});

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
  const hostHeader = (req.headers.host || '').split(':')[0];
  const { rtmpHost, rtmpPort } = resolveRtmpHostForClient(req);

  // Phân loại kết nối để iOS app hiển thị cảnh báo phù hợp
  const connectionType = classifyConnection(hostHeader, primaryIp);

  res.json({
    status: 'ok',
    ips,
    primaryIp,
    serverUrl: `http://${primaryIp}:${PORT}`,
    // iOS cần biết cổng RTMP (1935) để push, và đường HLS (8000) để admin preview nếu cần.
    rtmpIngestUrl: `rtmp://${rtmpHost}:${rtmpPort}/live`,
    hlsBaseUrl: resolveHlsBaseUrl(req),
    replayHlsBaseUrl: resolveReplayHlsBaseUrl(req),
    port: PORT,
    rtmpPort: 1935,
    // Thông tin giúp iOS app ra quyết định:
    connectionType,
    hostHeader,
    hints: {
      sameWifi: 'iPhone cùng Wi-Fi: dùng IP LAN vào Server URL',
      cloudflare: 'Cloudflare Tunnel HTTP: HTTP chạy được, RTMP cần tunnel riêng cho port 1935',
      ngrok: 'Ngrok TCP: HTTP + RTMP (cùng host) đều chạy qua tunnel',
      cellular: 'iPhone dùng 4G/5G: PHẢI có public RTMP URL (không dùng IP LAN)'
    }
  });
});

/**
 * QUAN TRỌNG: proxy /live/* (HLS .m3u8 + .ts do NMS/ffmpeg sinh ra ở port 8000 nội bộ) qua
 * chính port 4000 này. Lý do:
 *   - Cloudflare Quick Tunnel chỉ forward 1 port (4000). Nếu trả về link
 *     "http://<lan-ip>:8000/live/..." thì trình duyệt (đang mở trang qua HTTPS tunnel) sẽ
 *     bị chặn bởi Mixed Content (http trong trang https) VÀ CORS Private Network Access
 *     (domain public không được phép gọi thẳng vào IP LAN riêng).
 *   - Proxy qua cùng port/host mà trình duyệt đang kết nối -> luôn same-origin, same-protocol,
 *     không còn Mixed Content, không còn CORS/private-network nữa, không cần mở thêm tunnel.
 *
 * NMS serve mediaroot tại port 8000 với path prefix /live/ (vd: /live/<streamKey>/index.m3u8),
 * nên proxy chỉ cần forward nguyên originalUrl tới localhost:8000 là đúng.
/**
 * Phục vụ trực tiếp HLS (.m3u8 + .ts) từ thư mục ổ đĩa media/replay và media/live.
 * - Giải quyết triệt để lỗi 404: NodeMediaServer port 8000 không có route /replay,
 *   khiến request /replay/.../index.m3u8 bị 404 dù file đã được FFmpeg ghi trên đĩa.
 * - express.static hỗ trợ HTTP Range requests chuẩn (cực kỳ quan trọng để tua/seek video mượt).
 * - Cấu hình CORS mở và no-cache cho .m3u8 để cập nhật playlist mới nhất.
 */
const MEDIA_ROOT = path.join(__dirname, '../media');

app.use('/replay', express.static(path.join(MEDIA_ROOT, 'replay'), {
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/MP2T');
    }
  }
}));

app.use('/live', express.static(path.join(MEDIA_ROOT, 'live'), {
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/MP2T');
    }
  }
}));

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

function resolveReplayHlsBaseUrl(req: { headers: any; protocol?: string }): string {
  const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol || 'http';
  const host = (req.headers.host as string) || `localhost:${PORT}`;
  return `${proto}://${host}/replay`;
}


// ==========================================
// Apple OTA iOS IPA Installation Service
// ==========================================
const appDir = fs.existsSync(path.resolve(__dirname, '../../app'))
  ? path.resolve(__dirname, '../../app')
  : path.resolve(process.cwd(), 'app');

app.get('/ios/manifest.plist', (req, res) => {
  const host = req.headers.host || 'slomoview.stream';
  const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol || 'https';
  // Apple itms-services bắt buộc HTTPS (trừ localhost test)
  const scheme = proto === 'http' && !host.includes('localhost') && !host.includes('127.0.0.1') ? 'https' : proto;

  // Tìm file .ipa trong thư mục app
  let ipaFilename = 'SloMoLive.ipa';
  if (fs.existsSync(appDir)) {
    const files = fs.readdirSync(appDir);
    const found = files.find(f => f.toLowerCase().endsWith('.ipa'));
    if (found) ipaFilename = found;
  }

  const ipaUrl = `${scheme}://${host}/ios/${ipaFilename}`;
  const iconUrl = `${scheme}://${host}/vite.svg`;

  const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>items</key>
    <array>
        <dict>
            <key>assets</key>
            <array>
                <dict>
                    <key>kind</key>
                    <string>software-package</string>
                    <key>url</key>
                    <string>${ipaUrl}</string>
                </dict>
                <dict>
                    <key>kind</key>
                    <string>display-image</string>
                    <key>needs-shine</key>
                    <false/>
                    <key>url</key>
                    <string>${iconUrl}</string>
                </dict>
                <dict>
                    <key>kind</key>
                    <string>full-size-image</string>
                    <key>needs-shine</key>
                    <false/>
                    <key>url</key>
                    <string>${iconUrl}</string>
                </dict>
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>com.slomo.live</string>
                <key>bundle-version</key>
                <string>1.0.0</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>SloMo Live 240FPS</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>`;

  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(plistXml);
});

// Phục vụ trực tiếp file IPA từ folder app
app.use('/ios', express.static(appDir, {
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (filePath.toLowerCase().endsWith('.ipa')) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(filePath) + '"');
    }
  }
}));

const webDistPath = path.resolve(__dirname, '../../web/dist');
app.use(express.static(webDistPath));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/replay') || req.path.startsWith('/live') || req.path.startsWith('/ios')) {
    return res.status(404).json({ error: 'Not found' });
  }
  const indexPath = path.join(webDistPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) next();
  });
});

function normalizeDataItem(rawStr: string): string {
  let s = rawStr.trim();
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
  return s.toUpperCase();
}

// Socket.io chỉ lo: room join, card add/edit/delete, GPS, stream lifecycle.
// Toàn bộ video đi qua NMS/RTMP -> HLS (.ts + .m3u8) và web player tự fetch playlist, không
// broadcast frame qua socket nữa.

/** Giới hạn tối đa số viewer (không tính ADMIN và chủ phòng) được vào mỗi phòng */
const MAX_VIEWERS_PER_ROOM = 2;
/** Map<roomId, Map<socketId, userId>> — chỉ chứa socket của viewer thường */
const roomViewers = new Map<string, Map<string, string>>();

io.on('connection', (socket) => {
  const user = (socket as any).user;
  console.log(`[Socket] Client connected: ${socket.id} | User: ${user ? `${user.username} (${user.role})` : 'Anonymous'}`);

  const canControlRoom = (targetRoomId: string): boolean => {
    if (!user) return false;
    return user.role === 'ADMIN' || user.id === targetRoomId;
  };

  socket.on('join_room', (data) => {
    if (!user) {
      console.warn(`[Socket] Từ chối kết nối Socket chưa xác thực token: ${socket.id}`);
      socket.emit('error_message', 'Bạn cần đăng nhập với tài khoản hợp lệ.');
      socket.disconnect(true);
      return;
    }

    // Nếu là ADMIN: được phép chuyển sang bất kỳ phòng nào; nếu là USER thường: cố định ở phòng của chính mình
    const roomId = (user.role === 'ADMIN' && data?.roomId) ? data.roomId : user.id;

    // Rời tất cả phòng cũ trước khi vào phòng mới
    Array.from(socket.rooms).forEach((r) => {
      if (r !== socket.id) socket.leave(r);
    });

    // Dọn viewer tracking ở phòng cũ nếu có
    const prevRoomId = (socket as any)._viewerRoomId as string | undefined;
    if (prevRoomId && (socket as any)._isViewer) {
      const prev = roomViewers.get(prevRoomId);
      if (prev) {
        prev.delete(socket.id);
        if (prev.size === 0) roomViewers.delete(prevRoomId);
      }
    }
    (socket as any)._viewerRoomId = undefined;
    (socket as any)._isViewer = false;

    const isAdmin = user.role === 'ADMIN';
    const isOwner = user.id === roomId;
    const isViewer = !isAdmin && !isOwner;

    // Kiểm tra giới hạn viewer: Admin và chủ phòng được miễn giới hạn!
    if (isViewer) {
      if (!roomViewers.has(roomId)) roomViewers.set(roomId, new Map());
      const viewers = roomViewers.get(roomId)!;
      if (viewers.size >= MAX_VIEWERS_PER_ROOM) {
        console.log(`[Socket] Viewer limit reached for room ${roomId} (${viewers.size}/${MAX_VIEWERS_PER_ROOM}). Rejecting ${socket.id}`);
        socket.emit('viewer_limit_reached', { max: MAX_VIEWERS_PER_ROOM, current: viewers.size });
        socket.disconnect(true);
        return;
      }
      viewers.set(socket.id, user.id);
      (socket as any)._viewerRoomId = roomId;
      (socket as any)._isViewer = true;
      console.log(`[Socket] Viewer joined room ${roomId}: ${viewers.size}/${MAX_VIEWERS_PER_ROOM}`);
    }

    socket.join(`room_${roomId}`);
    if (isAdmin) {
      socket.join('room_admin');
    }

    const activeStream = db.getLatestStream(roomId);
    const latestGps = db.getLatestGpsLog(roomId);
    const cardEntries = db.getCardEntries(roomId);
    const ips = getLocalIpAddresses();
    const primaryIp = ips[0] || 'localhost';

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
    if (!user) return;
    const targetRoomId = (user.role === 'ADMIN' && data?.roomId) ? data.roomId : user.id;
    const { lat, lng } = data;
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
    }
  });

  socket.on('add_card', (data) => {
    if (!user) return;
    const targetRoomId = (user.role === 'ADMIN' && data?.roomId) ? data.roomId : user.id;
    if (!canControlRoom(targetRoomId)) {
      console.warn(`[Socket] Từ chối add_card trái phép từ ${user.username} vào phòng ${targetRoomId}`);
      return;
    }

    const { cardValue, groupCount, targetGroup } = data;
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
    }
  });

  socket.on('edit_card', (data) => {
    if (!user) return;
    const targetRoomId = (user.role === 'ADMIN' && data?.roomId) ? data.roomId : user.id;
    if (!canControlRoom(targetRoomId)) return;

    const { id, newCardValue } = data;
    if (id && newCardValue) {
      db.updateCardEntry(id, newCardValue);
      const updated = db.getCardEntries(targetRoomId);
      io.to(`room_${targetRoomId}`).emit('card_added', { roomId: targetRoomId, allEntries: updated });
    }
  });

  socket.on('delete_card', (data) => {
    if (!user) return;
    const targetRoomId = (user.role === 'ADMIN' && data?.roomId) ? data.roomId : user.id;
    if (!canControlRoom(targetRoomId)) return;

    const { id } = data;
    if (id) {
      db.deleteCardEntry(id);
      const updated = db.getCardEntries(targetRoomId);
      io.to(`room_${targetRoomId}`).emit('card_added', { roomId: targetRoomId, allEntries: updated });
    }
  });

  socket.on('set_group_names', (data) => {
    if (!user) return;
    const targetRoomId = (user.role === 'ADMIN' && data?.roomId) ? data.roomId : user.id;
    if (!canControlRoom(targetRoomId)) return;

    const { groupNames } = data;
    if (groupNames) {
      db.setGroupNames(targetRoomId, groupNames);
      io.to(`room_${targetRoomId}`).emit('group_names_updated', { roomId: targetRoomId, groupNames });
    }
  });

  socket.on('undo_card', (data) => {
    if (!user) return;
    const targetRoomId = (user.role === 'ADMIN' && data?.roomId) ? data.roomId : user.id;
    if (!canControlRoom(targetRoomId)) return;

    db.popCardEntry(targetRoomId);
    const updated = db.getCardEntries(targetRoomId);
    io.to(`room_${targetRoomId}`).emit('card_added', { roomId: targetRoomId, allEntries: updated });
  });

  socket.on('clear_cards', (data) => {
    if (!user) return;
    const targetRoomId = (user.role === 'ADMIN' && data?.roomId) ? data.roomId : user.id;
    if (!canControlRoom(targetRoomId)) return;

    db.clearCardEntries(targetRoomId);
    io.to(`room_${targetRoomId}`).emit('cards_cleared', { roomId: targetRoomId });
  });

  socket.on('finish_round', (data) => {
    if (!user) return;
    const targetRoomId = (user.role === 'ADMIN' && data?.roomId) ? data.roomId : user.id;
    if (!canControlRoom(targetRoomId)) return;

    db.clearCardEntries(targetRoomId);

    const liveSession = db.getActiveStream(targetRoomId);
    const latestSession = db.getLatestStream(targetRoomId);

    if (liveSession && liveSession.streamKey) {
      resetReplaySession(liveSession.streamKey);
      db.resetStreamStartTime(liveSession.streamKey);
      const updated = db.getActiveStream(targetRoomId) || liveSession;
      io.to(`room_${targetRoomId}`).emit('stream_status_changed', { roomId: targetRoomId, status: 'LIVE', session: updated });
      io.to('room_admin').emit('stream_status_changed', { roomId: targetRoomId, status: 'LIVE', session: updated });
    } else if (latestSession) {
      if (latestSession.streamKey) {
        resetReplaySession(latestSession.streamKey);
      }
      db.removeEndedStreams(targetRoomId);
      io.to(`room_${targetRoomId}`).emit('stream_status_changed', { roomId: targetRoomId, status: 'IDLE', session: null });
      io.to('room_admin').emit('stream_status_changed', { roomId: targetRoomId, status: 'IDLE', session: null });
    }

    const ts = Date.now();
    io.to(`room_${targetRoomId}`).emit('round_finished', { roomId: targetRoomId, timestamp: ts });
    io.to(`room_${targetRoomId}`).emit('cards_cleared', { roomId: targetRoomId });
  });

  socket.on('disconnect', () => {
    const roomId = (socket as any)._viewerRoomId as string | undefined;
    if (roomId && (socket as any)._isViewer) {
      const viewers = roomViewers.get(roomId);
      if (viewers) {
        viewers.delete(socket.id);
        if (viewers.size === 0) roomViewers.delete(roomId);
        console.log(`[Socket] Viewer left room ${roomId}: ${viewers?.size ?? 0}/${MAX_VIEWERS_PER_ROOM}`);
      }
    }
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
