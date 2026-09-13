"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.streamRouter = void 0;
exports.setSocketServer = setSocketServer;
const express_1 = require("express");
const db_1 = require("../db");
const auth_1 = require("./auth");
const mediaServer_1 = require("../mediaServer");
const network_1 = require("../utils/network");
exports.streamRouter = (0, express_1.Router)();
let globalIo = null;
function setSocketServer(io) {
    globalIo = io;
}
/**
 * Video segment storage: toàn bộ .ts + .m3u8 do NMS/FFmpeg sinh ra tại:
 *   <media_root>/live/<streamKey>/
 *
 * Đơn vị lưu trữ = segment video đã nén. Không còn buffer ảnh rời trong RAM.
 * Xem chi tiết quản lý DVR window ở mediaServer.ts.
 */
function resolveHlsBaseUrl(req) {
    const forwardedProto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim();
    const proto = forwardedProto || req.protocol || 'http';
    const host = req.headers.host || 'localhost:4000';
    // QUAN TRỌNG: /live được proxy qua chính port 4000 (xem index.ts) nên base URL này luôn
    // cùng origin/protocol với trang web -> không còn Mixed Content / CORS private-network.
    return `${proto}://${host}/live`;
}
// POST /api/stream/start
exports.streamRouter.post('/start', auth_1.authMiddleware, (req, res) => {
    if (req.user?.platform !== 'mobile') {
        return res.status(403).json({ error: 'Chỉ ứng dụng iOS di động mới có quyền khởi tạo Live Stream!' });
    }
    const roomId = req.user.id;
    const streamKey = 'live_' + roomId + '_' + Date.now();
    // QUAN TRỌNG: khi iOS app kết nối qua Cloudflare tunnel / public domain, request đến server qua
    // domain đó. Ta phải trả lại URL RTMP mà iPhone có thể truy cập được từ mạng của nó, KHÔNG phải
    // IP LAN của server (vì IP LAN chỉ truy cập được khi cùng Wi-Fi).
    //
    // Logic:
    //   1. Nếu request qua tunnel (Host header chứa trycloudflare.com / ngrok / custom domain):
    //      trả về URL cùng host đó, port RTMP cũng phải được expose qua tunnel tương ứng.
    //      User cần setup tunnel mở port 1935 (vd: cloudflared tunnel --url tcp://localhost:1935)
    //   2. Nếu request qua LAN (Host header là IP LAN): trả về IP LAN như cũ.
    //   3. Fallback: primaryIp LAN.
    const { rtmpHost, rtmpPort } = (0, network_1.resolveRtmpHostForClient)(req);
    const newStream = {
        id: 'stream-' + Date.now(),
        userId: roomId,
        username: req.user.username,
        streamKey,
        status: 'LIVE',
        hlsPlaylistUrl: `${resolveHlsBaseUrl(req)}/${streamKey}/index.m3u8`,
        vodUrl: '',
        startedAt: new Date().toISOString()
    };
    db_1.db.createStreamSession(newStream);
    // KHÔNG tự xóa cardEntries khi start live — người dùng phải xóa thủ công.
    // Trước đây clear ở đây làm mất toàn bộ dữ liệu bài mỗi lần bắt đầu live.
    // db.clearCardEntries(roomId);
    if (globalIo) {
        globalIo.to(`room_${roomId}`).emit('stream_status_changed', { roomId, status: 'LIVE', session: newStream });
        globalIo.to('room_admin').emit('stream_status_changed', { roomId, status: 'LIVE', session: newStream });
    }
    res.json({
        message: 'Khởi tạo luồng Live Stream 240fps thành công.',
        stream: newStream,
        rtmpIngestUrl: `rtmp://${rtmpHost}:${rtmpPort}/live`,
        streamKey
    });
});
// resolveRtmpHostForClient được dùng chung từ ../utils/network (đã gộp bản trùng lặp ở đây và
// ở index.ts để tránh 2 nơi lệch logic khi thêm domain tunnel mới).
// POST /api/stream/end — stop ffmpeg nhưng GIỮ LẠI file replay để người xem có thể tua
exports.streamRouter.post('/end', auth_1.authMiddleware, (req, res) => {
    const roomId = req.user?.id || req.body.streamId;
    let session = db_1.db.getActiveStream(roomId);
    if (!session) {
        // Nếu RTMP ngắt trước đó vài mili giây, getActiveStream sẽ trả về undefined.
        // Dùng getLatestStream để tìm lại chính phiên vừa kết thúc, tuyệt đối không để null.
        session = db_1.db.getLatestStream(roomId);
    }
    const streamKey = session?.streamKey;
    const ended = db_1.db.endStreamSession(session?.id || roomId) || session;
    // CHỈ dừng ffmpeg process, KHÔNG xóa file .ts/.m3u8
    // Mục đích DVR: người xem vẫn tua lại được sau khi live kết thúc.
    // File cũ sẽ được cron tự xóa sau CRON_MAX_AGE_SECONDS (mặc định 24h).
    if (streamKey) {
        (0, mediaServer_1.stopFfmpegOnly)(streamKey);
    }
    if (globalIo && ended) {
        globalIo.to(`room_${roomId}`).emit('stream_status_changed', { roomId, status: 'ENDED', session: ended });
        globalIo.to('room_admin').emit('stream_status_changed', { roomId, status: 'ENDED', session: ended });
    }
    res.json({ message: 'Đã dừng Live Stream. Video replay vẫn được giữ lại để xem lại.', stream: ended });
});
// POST /api/stream/gps
exports.streamRouter.post('/gps', auth_1.authMiddleware, (req, res) => {
    const { lat, lng, streamId } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
        return res.status(400).json({ error: 'Tọa độ GPS lat/lng không hợp lệ.' });
    }
    const gpsLog = {
        id: 'gps-' + Date.now(),
        streamId: streamId || db_1.db.getActiveStream()?.id || 'default-stream',
        userId: req.user.id,
        lat,
        lng,
        recordedAt: new Date().toISOString()
    };
    db_1.db.addGpsLog(gpsLog);
    if (globalIo) {
        globalIo.emit('gps_updated', gpsLog);
    }
    res.json({ status: 'ok', gps: gpsLog });
});
// GET /api/stream/active
exports.streamRouter.get('/active', (req, res) => {
    const targetRoomId = req.query.roomId || req.query.userId;
    const activeStream = db_1.db.getLatestStream(targetRoomId);
    const latestGps = db_1.db.getLatestGpsLog(targetRoomId);
    const cardEntries = db_1.db.getCardEntries(targetRoomId);
    res.json({
        roomId: targetRoomId || 'default',
        stream: activeStream || null,
        gps: latestGps || null,
        cardEntries
    });
});
// GET /api/stream/items (or /cards)
const getEntriesHandler = (req, res) => {
    res.json({ entries: db_1.db.getCardEntries() });
};
exports.streamRouter.get('/items', getEntriesHandler);
exports.streamRouter.get('/cards', getEntriesHandler);
// POST /api/stream/items (or /cards)
const addEntryHandler = (req, res) => {
    const { cardValue, groupCount } = req.body;
    if (!cardValue) {
        return res.status(400).json({ error: 'Vui lòng nhập mã dữ liệu.' });
    }
    const numGroups = parseInt(groupCount) || 3;
    const existingEntries = db_1.db.getCardEntries();
    const sequenceOrder = existingEntries.length + 1;
    const groupIndex = ((sequenceOrder - 1) % numGroups) + 1;
    const newEntry = {
        id: 'item-' + Date.now(),
        streamId: db_1.db.getActiveStream()?.id || 'live-session',
        userId: req.user.id,
        cardValue: cardValue.toString().toUpperCase(),
        groupIndex,
        sequenceOrder,
        createdAt: new Date().toISOString()
    };
    db_1.db.addCardEntry(newEntry);
    if (globalIo) {
        globalIo.emit('card_added', { entry: newEntry, allEntries: db_1.db.getCardEntries() });
    }
    res.json({ message: 'Đã phân loại mã dữ liệu thành công', entry: newEntry });
};
exports.streamRouter.post('/items', auth_1.authMiddleware, addEntryHandler);
exports.streamRouter.post('/cards', auth_1.authMiddleware, addEntryHandler);
// DELETE /api/stream/items (or /cards)
const clearEntriesHandler = (req, res) => {
    db_1.db.clearCardEntries();
    if (globalIo) {
        globalIo.emit('cards_cleared');
    }
    res.json({ message: 'Đã xóa toàn bộ danh sách dữ liệu.' });
};
exports.streamRouter.delete('/items', auth_1.authMiddleware, clearEntriesHandler);
exports.streamRouter.delete('/cards', auth_1.authMiddleware, clearEntriesHandler);
// GET /api/stream/cleanup-status — Xem thống kê trạng thái dọn dẹp 24h
exports.streamRouter.get('/cleanup-status', (_req, res) => {
    res.json({
        status: 'ok',
        ...(0, mediaServer_1.getCleanupStatus)()
    });
});
// POST /api/stream/trigger-cleanup — Kích hoạt quét dọn dẹp ngay lập tức (Test auto-xóa)
exports.streamRouter.post('/trigger-cleanup', auth_1.authMiddleware, (_req, res) => {
    const report = (0, mediaServer_1.runCronCleanupOnce)();
    res.json({
        message: 'Đã kích hoạt quét dọn dẹp dữ liệu cũ thành công',
        report,
        currentStatus: (0, mediaServer_1.getCleanupStatus)()
    });
});
