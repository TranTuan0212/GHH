"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("./env");
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const socket_io_1 = require("socket.io");
const auth_1 = require("./routes/auth");
const admin_1 = require("./routes/admin");
const stream_1 = require("./routes/stream");
const db_1 = require("./db");
const mediaServer_1 = require("./mediaServer");
const network_1 = require("./utils/network");
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
// Gracefully handle aborted socket requests (e.g. client dropped network or switched camera)
process.on('uncaughtException', (err) => {
    if (err.type === 'request.aborted' || err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.message === 'request aborted') {
        return;
    }
    console.error('[Process Error]', err);
});
const io = new socket_io_1.Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE']
    },
    maxHttpBufferSize: 1e7
});
(0, stream_1.setSocketServer)(io);
(0, mediaServer_1.setStreamEndedHandler)((streamKey) => {
    const ended = db_1.db.endStreamSessionByStreamKey(streamKey);
    if (!ended)
        return;
    io.to(`room_${ended.userId}`).emit('stream_status_changed', { roomId: ended.userId, status: 'ENDED', session: ended });
    io.to('room_admin').emit('stream_status_changed', { roomId: ended.userId, status: 'ENDED', session: ended });
});
const PORT = parseInt(process.env.PORT || '4000');
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '10mb' }));
// TEMP DEBUG LOGGING — giúp xác định request /api có tới server không, tới qua host nào,
// và mất bao lâu để trả response. Xoá sau khi debug xong.
app.use((req, res, next) => {
    if (!req.path.startsWith('/api'))
        return next();
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
app.use((err, req, res, next) => {
    if (err.type === 'request.aborted' || err.code === 'ECONNRESET' || err.message === 'request aborted') {
        return res.status(400).end();
    }
    next(err);
});
// API Routes
app.use('/api/auth', auth_1.authRouter);
app.use('/api/admin', admin_1.adminRouter);
app.use('/api/stream', stream_1.streamRouter);
// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', serverTime: new Date().toISOString() });
});
// Server Info (returns detected host LAN IP addresses for mobile app connection)
// QUAN TRỌNG: khi iPhone kết nối qua tunnel, trả về URL RTMP dựa trên Host header thay vì IP LAN.
app.get('/api/server-info', (req, res) => {
    const ips = (0, network_1.getLocalIpAddresses)();
    const primaryIp = ips[0] || 'localhost';
    const hostHeader = (req.headers.host || '').split(':')[0];
    const { rtmpHost, rtmpPort } = (0, network_1.resolveRtmpHostForClient)(req);
    // Phân loại kết nối để iOS app hiển thị cảnh báo phù hợp
    const connectionType = (0, network_1.classifyConnection)(hostHeader, primaryIp);
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
const MEDIA_ROOT = path_1.default.join(__dirname, '../media');
app.use('/replay', express_1.default.static(path_1.default.join(MEDIA_ROOT, 'replay'), {
    setHeaders: (res, filePath) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        if (filePath.endsWith('.m3u8')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        }
        else if (filePath.endsWith('.ts')) {
            res.setHeader('Content-Type', 'video/MP2T');
        }
    }
}));
app.use('/live', express_1.default.static(path_1.default.join(MEDIA_ROOT, 'live'), {
    setHeaders: (res, filePath) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        if (filePath.endsWith('.m3u8')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        }
        else if (filePath.endsWith('.ts')) {
            res.setHeader('Content-Type', 'video/MP2T');
        }
    }
}));
/**
 * Xác định base URL public mà trình duyệt/app dùng để tải HLS (.m3u8/.ts), LUÔN cùng
 * host:port + protocol với chính request đang gọi /api/... -> nhờ có proxy /live ở trên nên
 * điều này đúng cho cả 3 trường hợp: LAN, Cloudflare tunnel (HTTPS), hay override thủ công.
 */
function resolveHlsBaseUrl(req) {
    const forwardedProto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim();
    const proto = forwardedProto || req.protocol || 'http';
    const host = req.headers.host || `localhost:${PORT}`;
    return `${proto}://${host}/live`;
}
function resolveReplayHlsBaseUrl(req) {
    const forwardedProto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim();
    const proto = forwardedProto || req.protocol || 'http';
    const host = req.headers.host || `localhost:${PORT}`;
    return `${proto}://${host}/replay`;
}
const webDistPath = path_1.default.resolve(__dirname, '../../web/dist');
app.use(express_1.default.static(webDistPath));
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/replay') || req.path.startsWith('/live')) {
        return res.status(404).json({ error: 'Not found' });
    }
    const indexPath = path_1.default.join(webDistPath, 'index.html');
    res.sendFile(indexPath, (err) => {
        if (err)
            next();
    });
});
function normalizeDataItem(rawStr) {
    let s = rawStr.trim();
    if (!s)
        return '';
    s = s.replace(/\s+/g, ' ');
    return s.toUpperCase();
}
// Socket.io chỉ lo: room join, card add/edit/delete, GPS, stream lifecycle.
// Toàn bộ video đi qua NMS/RTMP -> HLS (.ts + .m3u8) và web player tự fetch playlist, không
// broadcast frame qua socket nữa.
/** Giới hạn tối đa số viewer (không tính ADMIN và chủ phòng) được vào mỗi phòng */
const MAX_VIEWERS_PER_ROOM = 2;
/** Map<roomId, Map<socketId, userId>> — chỉ chứa socket của viewer thường */
const roomViewers = new Map();
io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);
    socket.on('join_room', (data) => {
        const roomId = data?.roomId || 'default';
        const role = data?.role;
        const userId = data?.userId || '';
        // Rời tất cả phòng cũ trước khi vào phòng mới
        Array.from(socket.rooms).forEach((r) => {
            if (r !== socket.id)
                socket.leave(r);
        });
        // Dọn viewer tracking ở phòng cũ nếu có
        const prevRoomId = socket._viewerRoomId;
        if (prevRoomId && socket._isViewer) {
            const prev = roomViewers.get(prevRoomId);
            if (prev) {
                prev.delete(socket.id);
                if (prev.size === 0)
                    roomViewers.delete(prevRoomId);
            }
        }
        socket._viewerRoomId = undefined;
        socket._isViewer = false;
        const isAdmin = role === 'ADMIN';
        const isOwner = !!(userId && userId === roomId); // chủ phòng: userId trùng roomId
        const isViewer = !isAdmin && !isOwner;
        // Kiểm tra giới hạn viewer
        if (isViewer) {
            if (!roomViewers.has(roomId))
                roomViewers.set(roomId, new Map());
            const viewers = roomViewers.get(roomId);
            if (viewers.size >= MAX_VIEWERS_PER_ROOM) {
                console.log(`[Socket] Viewer limit reached for room ${roomId} (${viewers.size}/${MAX_VIEWERS_PER_ROOM}). Rejecting ${socket.id}`);
                socket.emit('viewer_limit_reached', { max: MAX_VIEWERS_PER_ROOM, current: viewers.size });
                socket.disconnect(true);
                return;
            }
            viewers.set(socket.id, userId);
            socket._viewerRoomId = roomId;
            socket._isViewer = true;
            console.log(`[Socket] Viewer joined room ${roomId}: ${viewers.size}/${MAX_VIEWERS_PER_ROOM}`);
        }
        socket.join(`room_${roomId}`);
        if (isAdmin) {
            socket.join('room_admin');
        }
        const activeStream = db_1.db.getLatestStream(roomId);
        const latestGps = db_1.db.getLatestGpsLog(roomId);
        const cardEntries = db_1.db.getCardEntries(roomId);
        const ips = (0, network_1.getLocalIpAddresses)();
        const primaryIp = ips[0] || 'localhost';
        // QUAN TRỌNG: dùng resolveRtmpHostForClient để khi mobile kết nối qua tunnel thì socket cũng
        // nhận được URL đúng dạng tunnel, không phải IP LAN.
        const fakeReq = { headers: socket.handshake.headers };
        const { rtmpHost, rtmpPort } = (0, network_1.resolveRtmpHostForClient)(fakeReq);
        socket.emit('initial_state', {
            roomId,
            activeStream: activeStream || null,
            latestGps: latestGps || null,
            cardEntries,
            groupNames: db_1.db.getGroupNames(roomId),
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
            db_1.db.addGpsLog(gpsLog);
            io.to(`room_${targetRoomId}`).emit('gps_updated', gpsLog);
            io.to('room_admin').emit('gps_updated', gpsLog);
        }
    });
    socket.on('add_card', (data) => {
        const { cardValue, groupCount, userId, roomId, targetGroup } = data;
        const targetRoomId = roomId || userId || 'default';
        if (cardValue) {
            const rawItems = cardValue.toString().split(',').map((c) => c.trim()).filter((c) => c.length > 0);
            const numGroups = parseInt(groupCount) || 3;
            rawItems.forEach((itemStr) => {
                const existingEntries = db_1.db.getCardEntries(targetRoomId);
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
                db_1.db.addCardEntry(newEntry);
            });
            const updated = db_1.db.getCardEntries(targetRoomId);
            io.to(`room_${targetRoomId}`).emit('card_added', { roomId: targetRoomId, allEntries: updated });
            io.to('room_admin').emit('card_added', { roomId: targetRoomId, allEntries: updated });
        }
    });
    socket.on('edit_card', (data) => {
        const { id, newCardValue, roomId, userId } = data;
        const targetRoomId = roomId || userId || 'default';
        if (id && newCardValue) {
            db_1.db.updateCardEntry(id, newCardValue);
            const updated = db_1.db.getCardEntries(targetRoomId);
            io.to(`room_${targetRoomId}`).emit('card_added', { roomId: targetRoomId, allEntries: updated });
            io.to('room_admin').emit('card_added', { roomId: targetRoomId, allEntries: updated });
        }
    });
    socket.on('delete_card', (data) => {
        const { id, roomId, userId } = data;
        const targetRoomId = roomId || userId || 'default';
        if (id) {
            db_1.db.deleteCardEntry(id);
            const updated = db_1.db.getCardEntries(targetRoomId);
            io.to(`room_${targetRoomId}`).emit('card_added', { roomId: targetRoomId, allEntries: updated });
            io.to('room_admin').emit('card_added', { roomId: targetRoomId, allEntries: updated });
        }
    });
    socket.on('set_group_names', (data) => {
        const { groupNames, roomId, userId } = data;
        const targetRoomId = roomId || userId || 'default';
        if (groupNames) {
            db_1.db.setGroupNames(targetRoomId, groupNames);
            io.to(`room_${targetRoomId}`).emit('group_names_updated', { roomId: targetRoomId, groupNames });
            io.to('room_admin').emit('group_names_updated', { roomId: targetRoomId, groupNames });
        }
    });
    socket.on('undo_card', (data) => {
        const targetRoomId = data?.roomId || data?.userId || 'default';
        db_1.db.popCardEntry(targetRoomId);
        const updated = db_1.db.getCardEntries(targetRoomId);
        io.to(`room_${targetRoomId}`).emit('card_added', { roomId: targetRoomId, allEntries: updated });
        io.to('room_admin').emit('card_added', { roomId: targetRoomId, allEntries: updated });
    });
    socket.on('clear_cards', (data) => {
        const targetRoomId = data?.roomId || data?.userId || 'default';
        db_1.db.clearCardEntries(targetRoomId);
        io.to(`room_${targetRoomId}`).emit('cards_cleared', { roomId: targetRoomId });
        io.to('room_admin').emit('cards_cleared', { roomId: targetRoomId });
    });
    socket.on('finish_round', (data) => {
        const targetRoomId = data?.roomId || data?.userId || 'default';
        db_1.db.clearCardEntries(targetRoomId);
        const liveSession = db_1.db.getActiveStream(targetRoomId);
        const latestSession = db_1.db.getLatestStream(targetRoomId);
        if (liveSession && liveSession.streamKey) {
            // 1. Nếu stream đang LIVE: làm mới bộ đệm replay về 0s và cập nhật startedAt của round mới
            (0, mediaServer_1.resetReplaySession)(liveSession.streamKey);
            db_1.db.resetStreamStartTime(liveSession.streamKey);
            const updated = db_1.db.getActiveStream(targetRoomId);
            io.to(`room_${targetRoomId}`).emit('stream_status_changed', { roomId: targetRoomId, status: 'LIVE', session: updated });
            io.to('room_admin').emit('stream_status_changed', { roomId: targetRoomId, status: 'LIVE', session: updated });
        }
        else if (latestSession) {
            // 2. Nếu stream đã kết thúc (không còn LIVE): người dùng bấm "Xong Phiên" hoàn tất xem lại
            // Xóa toàn bộ file replay trên đĩa và xóa phiên kết thúc khỏi database
            if (latestSession.streamKey) {
                (0, mediaServer_1.resetReplaySession)(latestSession.streamKey);
            }
            db_1.db.removeEndedStreams(targetRoomId);
            io.to(`room_${targetRoomId}`).emit('stream_status_changed', { roomId: targetRoomId, status: 'IDLE', session: null });
            io.to('room_admin').emit('stream_status_changed', { roomId: targetRoomId, status: 'IDLE', session: null });
        }
        const ts = Date.now();
        io.to(`room_${targetRoomId}`).emit('round_finished', { roomId: targetRoomId, timestamp: ts });
        io.to(`room_${targetRoomId}`).emit('cards_cleared', { roomId: targetRoomId });
        io.to('room_admin').emit('round_finished', { roomId: targetRoomId, timestamp: ts });
        io.to('room_admin').emit('cards_cleared', { roomId: targetRoomId });
    });
    // ĐÃ XOÁ: socket.on('toggle_stream', ...)
    // Lý do: đây là đường khởi tạo/kết thúc stream SONG SONG với REST API chính thức
    // (POST /api/stream/start|end), dùng quy tắc streamKey khác ('live_' + roomId, không có
    // timestamp) và KHÔNG hề đụng tới RTMP/FFmpeg thật (mediaServer.ts). Vì db.createStreamSession()
    // tự động ENDED mọi phiên LIVE cũ cùng userId, nếu event này từng bị gọi trong lúc một phiên
    // live RTMP thật đang chạy, nó sẽ khiến DB báo ENDED trong khi FFmpeg/HLS vẫn tiếp tục ghi file
    // — làm sai lệch trạng thái hiển thị cho client. Đã grep toàn bộ codebase xác nhận không có
    // client (web/iOS) nào emit 'toggle_stream' nên xoá an toàn. Nếu cần điều khiển live từ web,
    // hãy gọi qua REST API /api/stream/start và /api/stream/end.
    socket.on('disconnect', () => {
        // Dọn viewer slot khi socket ngắt kết nối
        const roomId = socket._viewerRoomId;
        if (roomId && socket._isViewer) {
            const viewers = roomViewers.get(roomId);
            if (viewers) {
                viewers.delete(socket.id);
                if (viewers.size === 0)
                    roomViewers.delete(roomId);
                console.log(`[Socket] Viewer left room ${roomId}: ${viewers?.size ?? 0}/${MAX_VIEWERS_PER_ROOM}`);
            }
        }
        console.log(`[Socket] Client disconnected: ${socket.id}`);
    });
});
// Start Native RTMP/HLS Media Server — đây là nơi duy nhất lưu trữ video (segment .ts + playlist .m3u8).
(0, mediaServer_1.startNativeMediaServer)();
server.listen(PORT, '0.0.0.0', () => {
    const ips = (0, network_1.getLocalIpAddresses)();
    console.log(`Backend Server running on port ${PORT} (Bound to 0.0.0.0)`);
    console.log(`Địa chỉ kết nối từ iPhone trong cùng mạng Wi-Fi:`);
    ips.forEach(ip => {
        console.log(`   -> http://${ip}:${PORT}`);
        console.log(`   -> RTMP ingest: rtmp://${ip}:1935/live`);
        console.log(`   -> HLS playlist: http://${ip}:8000/live/<streamKey>/index.m3u8`);
    });
});
