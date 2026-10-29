"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hlsSessions = void 0;
exports.setStreamEndedHandler = setStreamEndedHandler;
exports.setStreamStartedHandler = setStreamStartedHandler;
exports.cleanupStreamSession = cleanupStreamSession;
exports.stopFfmpegOnly = stopFfmpegOnly;
exports.resetReplaySession = resetReplaySession;
exports.startHlsSession = startHlsSession;
exports.timeoutCheckOnce = timeoutCheckOnce;
exports.runCronCleanupOnce = runCronCleanupOnce;
exports.getCleanupStatus = getCleanupStatus;
exports.getMediaStorageStats = getMediaStorageStats;
exports.startNativeMediaServer = startNativeMediaServer;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const db_1 = require("./db");
/**
 * MediaMTX-Powered Industrial Media Engine
 *
 * Kiến trúc:
 * 1. MediaMTX nhận RTMP trực tiếp từ iOS trên port 1935 (chuẩn C/Golang siêu tốc, zero parse error).
 * 2. WebRTC Live (WHEP): MediaMTX phát thẳng H.264 Full HD từ iPhone tới Trình duyệt qua :8889/live/{streamKey}/whep
 *    (Zero transcoding, Zero CPU, Zero delay <100ms, mượt 60fps/120fps).
 * 3. AI Worker: Python worker kết nối RTSP rtsp://127.0.0.1:8554/live/{streamKey} để xử lý 120fps.
 * 4. Replay DVR Master: Node.js chỉ chạy duy nhất 1 tiến trình FFmpeg cực nhẹ copy luồng RTSP sang HLS
 *    (-c:v copy, không nén lại CPU) xuất segment 0.5s để tua chậm 120fps.
 */
const MEDIA_ROOT = path_1.default.join(__dirname, '../media');
const DVR_WINDOW_SECONDS = parseInt(process.env.DVR_WINDOW_SECONDS || '', 10) || 6 * 60 * 60;
const SESSION_TIMEOUT_SECONDS = parseInt(process.env.SESSION_TIMEOUT_SECONDS || '', 10) || 30 * 60;
const CRON_MAX_AGE_SECONDS = parseInt(process.env.CRON_MAX_AGE_SECONDS || '', 10) || 24 * 60 * 60;
const HLS_SEGMENT_SECONDS = 0.5;
exports.hlsSessions = new Map();
let streamEndedHandler;
let streamStartedHandler;
function setStreamEndedHandler(handler) {
    streamEndedHandler = handler;
}
function setStreamStartedHandler(handler) {
    streamStartedHandler = handler;
}
// Map streamKey -> pending disconnect timer (Grace Period 20s cho mạng 4G/5G)
const pendingDisconnects = new Map();
const GRACE_PERIOD_MS = 20_000;
function getStreamDir(rendition, streamKey) {
    return path_1.default.join(MEDIA_ROOT, rendition, streamKey);
}
function cleanupStreamSession(streamKey) {
    if (pendingDisconnects.has(streamKey)) {
        clearTimeout(pendingDisconnects.get(streamKey));
        pendingDisconnects.delete(streamKey);
    }
    const session = exports.hlsSessions.get(streamKey);
    if (session) {
        for (const process of session.ffmpegProcesses) {
            if (!process.killed) {
                try {
                    process.kill('SIGTERM');
                }
                catch { }
            }
        }
        exports.hlsSessions.delete(streamKey);
    }
    let deleted = 0;
    for (const rendition of ['live', 'replay']) {
        const dir = getStreamDir(rendition, streamKey);
        try {
            if (fs_1.default.existsSync(dir)) {
                const files = fs_1.default.readdirSync(dir);
                for (const file of files) {
                    if (file.endsWith('.ts') || file.endsWith('.m3u8') || file.endsWith('.mp4')) {
                        fs_1.default.unlinkSync(path_1.default.join(dir, file));
                        deleted++;
                    }
                }
                try {
                    fs_1.default.rmdirSync(dir);
                }
                catch { }
            }
        }
        catch (err) {
            console.error(`[MediaServer] Cleanup error for ${streamKey}/${rendition}:`, err);
        }
    }
    console.log(`[MediaServer] Cleanup session ${streamKey}: deleted ${deleted} files`);
}
/**
 * Dừng FFmpeg Replay, giữ lại file .ts/.m3u8 để người xem tua lại.
 */
function stopFfmpegOnly(streamKey) {
    if (pendingDisconnects.has(streamKey)) {
        clearTimeout(pendingDisconnects.get(streamKey));
        pendingDisconnects.delete(streamKey);
    }
    const session = exports.hlsSessions.get(streamKey);
    if (session) {
        for (const process of session.ffmpegProcesses) {
            if (!process.killed) {
                try {
                    process.kill('SIGTERM');
                }
                catch { }
            }
        }
        exports.hlsSessions.delete(streamKey);
        console.log(`[MediaServer] FFmpeg stopped for ${streamKey} (files preserved for replay)`);
    }
}
/**
 * Làm mới toàn bộ bộ đệm Replay cho streamKey khi bấm "Xong Phiên"
 */
function resetReplaySession(streamKey) {
    const session = exports.hlsSessions.get(streamKey);
    // 1. Dừng ngay tiến trình ffmpeg replay cũ nếu stream đang chạy
    if (session) {
        const oldReplayFfmpeg = session.ffmpegProcesses[0];
        if (oldReplayFfmpeg && !oldReplayFfmpeg.killed) {
            try {
                oldReplayFfmpeg.kill('SIGKILL');
            }
            catch { }
        }
    }
    // 2. Xóa sạch file .ts, .m3u8 của phiên trước
    const outputDir = getStreamDir('replay', streamKey);
    try {
        if (fs_1.default.existsSync(outputDir)) {
            const files = fs_1.default.readdirSync(outputDir);
            for (const file of files) {
                try {
                    fs_1.default.unlinkSync(path_1.default.join(outputDir, file));
                }
                catch { }
            }
            if (!session) {
                try {
                    fs_1.default.rmdirSync(outputDir);
                }
                catch { }
            }
        }
    }
    catch (err) {
        console.error(`[MediaServer] Lỗi dọn dẹp file replay cũ cho ${streamKey}:`, err);
    }
    if (!session) {
        console.log(`[MediaServer] Đã xóa sạch toàn bộ video replay cũ của stream ${streamKey} (phiên stream đã dừng)`);
        return true;
    }
    // 3. Khởi động lại ffmpeg replay mới từ MediaMTX RTSP
    const bundledFfmpeg = path_1.default.join(__dirname, '../tools/ffmpeg/ffmpeg.exe');
    const ffmpegPath = process.env.FFMPEG_PATH || (fs_1.default.existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg');
    const hlsListSize = Math.max(1, Math.ceil(DVR_WINDOW_SECONDS / HLS_SEGMENT_SECONDS));
    const ffmpegArgs = [
        '-fflags', '+nobuffer',
        '-rtsp_transport', 'tcp',
        '-i', `rtsp://127.0.0.1:8554/live/${streamKey}`,
        '-c:v', 'copy',
        '-bsf:v', 'h264_mp4toannexb',
        '-an',
        '-f', 'hls',
        '-hls_time', String(HLS_SEGMENT_SECONDS),
        '-hls_list_size', String(hlsListSize),
        '-hls_segment_filename', path_1.default.join(outputDir, '%05d.ts'),
        '-hls_flags', 'delete_segments+program_date_time',
        path_1.default.join(outputDir, 'index.m3u8')
    ];
    const newReplayFfmpeg = (0, child_process_1.spawn)(ffmpegPath, ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    newReplayFfmpeg.stderr.on('data', () => {
        const s = exports.hlsSessions.get(streamKey);
        if (s)
            s.lastSeen = Date.now() / 1000;
    });
    session.ffmpegProcesses[0] = newReplayFfmpeg;
    session.startTime = Date.now() / 1000;
    session.lastSeen = Date.now() / 1000;
    console.log(`[MediaServer] Đã làm mới hoàn toàn bộ đệm Replay cho ${streamKey} (Reset video timeline 0s)`);
    return true;
}
/**
 * Khởi động tiến trình FFmpeg Replay DVR đọc từ MediaMTX RTSP:
 * Copy stream H.264 nguyên bản (0% CPU, giữ nguyên 120fps) sang file .ts 0.5s.
 */
function startHlsSession(streamKey) {
    const outputDir = getStreamDir('replay', streamKey);
    try {
        fs_1.default.mkdirSync(outputDir, { recursive: true });
    }
    catch (err) {
        console.error(`[MediaServer] Cannot create output dir ${outputDir}:`, err);
        return;
    }
    const bundledFfmpeg = path_1.default.join(__dirname, '../tools/ffmpeg/ffmpeg.exe');
    const ffmpegPath = process.env.FFMPEG_PATH || (fs_1.default.existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg');
    const hlsListSize = Math.max(1, Math.ceil(DVR_WINDOW_SECONDS / HLS_SEGMENT_SECONDS));
    const ffmpegArgs = [
        '-fflags', '+nobuffer',
        '-rtsp_transport', 'tcp',
        '-i', `rtsp://127.0.0.1:8554/live/${streamKey}`,
        '-c:v', 'copy',
        '-bsf:v', 'h264_mp4toannexb',
        '-an',
        '-f', 'hls',
        '-hls_time', String(HLS_SEGMENT_SECONDS),
        '-hls_list_size', String(hlsListSize),
        '-hls_segment_filename', path_1.default.join(outputDir, '%05d.ts'),
        '-hls_flags', 'append_list+delete_segments+program_date_time',
        path_1.default.join(outputDir, 'index.m3u8')
    ];
    console.log(`[MediaServer] 🎬 Khởi động FFmpeg DVR Replay từ MediaMTX RTSP cho ${streamKey}:`);
    console.log(`   Source: rtsp://127.0.0.1:8554/live/${streamKey}`);
    console.log(`   Output: ${outputDir}/index.m3u8 (Segment ${HLS_SEGMENT_SECONDS}s, DVR ${DVR_WINDOW_SECONDS / 3600}h)`);
    const replayProc = (0, child_process_1.spawn)(ffmpegPath, ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    replayProc.stdout?.on('data', (data) => {
        const line = data.toString().trim();
        if (line)
            console.log(`[MediaServer] [ffmpeg ${streamKey}] STDOUT: ${line}`);
    });
    replayProc.stderr?.on('data', (data) => {
        const line = data.toString().trim();
        if (!line)
            return;
        const isImportant = /error|fatal|cannot|failed|hls|segment/i.test(line);
        if (isImportant)
            console.log(`[MediaServer] [ffmpeg ${streamKey}] ${line}`);
        const s = exports.hlsSessions.get(streamKey);
        if (s)
            s.lastSeen = Date.now() / 1000;
    });
    replayProc.on('error', (err) => {
        console.error(`[MediaServer] ffmpeg error for ${streamKey}:`, err);
    });
    replayProc.on('close', (code, signal) => {
        console.log(`[MediaServer] replay FFmpeg exited for ${streamKey} with code=${code} signal=${signal}`);
    });
    const session = {
        streamKey,
        startTime: Date.now() / 1000,
        lastSeen: Date.now() / 1000,
        ffmpegProcesses: [replayProc]
    };
    exports.hlsSessions.set(streamKey, session);
}
/**
 * MediaMTX Path Watcher:
 * Tự động kiểm tra trạng thái luồng trên MediaMTX API v3 mỗi 1000ms.
 * Bắt dính ngay khi iPhone phát hoặc dừng, quản lý ân hạn 20s.
 */
let watcherInterval = null;
function startMediaMtxWatcher() {
    if (watcherInterval)
        clearInterval(watcherInterval);
    watcherInterval = setInterval(async () => {
        try {
            const res = await fetch('http://127.0.0.1:9997/v3/paths/list');
            if (!res.ok)
                return;
            const data = await res.json();
            const items = data.items || [];
            const activeStreamKeys = new Set();
            for (const item of items) {
                if (!item.ready)
                    continue;
                const streamKey = item.name.split('/').pop() || item.name;
                activeStreamKeys.add(streamKey);
                // Hủy timer ân hạn ngắt kết nối nếu có
                if (pendingDisconnects.has(streamKey)) {
                    clearTimeout(pendingDisconnects.get(streamKey));
                    pendingDisconnects.delete(streamKey);
                    console.log(`[MediaServer] ✅ iPhone kết nối lại thành công qua MediaMTX cho stream ${streamKey}!`);
                }
                // Tự động kích hoạt trạng thái LIVE trong DB
                let activeStream = db_1.db.getStreams().find(s => s.streamKey === streamKey && s.status === 'LIVE');
                let newlyActivated = false;
                if (!activeStream) {
                    const anyStream = db_1.db.getStreams().find(s => s.streamKey === streamKey);
                    if (anyStream) {
                        anyStream.status = 'LIVE';
                        anyStream.endedAt = undefined;
                        activeStream = anyStream;
                        newlyActivated = true;
                        console.log(`[MediaServer] 🔄 MediaMTX tái kích hoạt phiên LIVE cho streamKey: ${streamKey}`);
                    }
                    else if (streamKey.startsWith('live_usr-')) {
                        const match = streamKey.match(/^live_(usr-[^_]+)/);
                        const userId = match ? match[1] : 'usr-default';
                        const user = db_1.db.getUsers().find(u => u.id === userId);
                        const newStream = {
                            id: `stream-${Date.now()}`,
                            userId,
                            username: user ? user.username : 'iPhone User',
                            streamKey,
                            status: 'LIVE',
                            hlsPlaylistUrl: `/live/${streamKey}/index.m3u8`,
                            vodUrl: '',
                            startedAt: new Date().toISOString()
                        };
                        db_1.db.getStreams().unshift(newStream);
                        activeStream = newStream;
                        newlyActivated = true;
                        console.log(`[MediaServer] ⚡ Tự động cấp phép phiên LIVE mới qua MediaMTX: ${streamKey}`);
                    }
                }
                // Khởi động FFmpeg Replay DVR nếu chưa chạy
                const existingSession = exports.hlsSessions.get(streamKey);
                const isProcAlive = existingSession && existingSession.ffmpegProcesses[0] &&
                    existingSession.ffmpegProcesses[0].exitCode === null && !existingSession.ffmpegProcesses[0].killed;
                if (!isProcAlive) {
                    startHlsSession(streamKey);
                    newlyActivated = true;
                }
                if (newlyActivated && activeStream) {
                    streamStartedHandler?.(activeStream);
                }
            }
            // Xử lý các stream bị ngắt kết nối
            for (const [streamKey] of exports.hlsSessions) {
                if (!activeStreamKeys.has(streamKey) && !pendingDisconnects.has(streamKey)) {
                    console.log(`[MediaServer] ⏳ MediaMTX báo stream ${streamKey} ngắt kết nối. Bắt đầu ân hạn ${GRACE_PERIOD_MS / 1000}s...`);
                    const timer = setTimeout(() => {
                        pendingDisconnects.delete(streamKey);
                        console.log(`[MediaServer] 🛑 Hết thời gian ân hạn ${GRACE_PERIOD_MS / 1000}s cho stream ${streamKey}. Chính thức đóng phiên.`);
                        stopFfmpegOnly(streamKey);
                        streamEndedHandler?.(streamKey);
                    }, GRACE_PERIOD_MS);
                    pendingDisconnects.set(streamKey, timer);
                }
            }
        }
        catch { }
    }, 1000);
}
/** Background cleanup */
function startCleanupScheduler() {
    const TIMEOUT_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || '', 10) || 60_000;
    const CRON_INTERVAL_MS = parseInt(process.env.CRON_INTERVAL_MS || '', 10) || 60 * 60_000;
    setInterval(() => {
        timeoutCheckOnce();
    }, TIMEOUT_INTERVAL_MS);
    setTimeout(() => {
        const res = runCronCleanupOnce();
        if (res.deletedFiles > 0) {
            console.log(`[MediaServer] Dọn dẹp khởi động: đã giải phóng ${res.deletedFiles} file .ts cũ hết hạn`);
        }
    }, 5000);
    setInterval(() => {
        const result = runCronCleanupOnce();
        if (result.deletedFiles > 0) {
            console.log(`[MediaServer] Cron cleanup: deleted ${result.deletedFiles} old .ts files`);
        }
    }, CRON_INTERVAL_MS);
}
function timeoutCheckOnce() {
    const now = Date.now() / 1000;
    const cleaned = [];
    for (const [streamKey, session] of exports.hlsSessions) {
        if (now - session.lastSeen > SESSION_TIMEOUT_SECONDS) {
            console.warn(`[MediaServer] Orphaned stream ${streamKey} timeout — dừng ffmpeg`);
            stopFfmpegOnly(streamKey);
            cleaned.push(streamKey);
        }
    }
    return cleaned;
}
function runCronCleanupOnce() {
    const now = Date.now() / 1000;
    let deletedFiles = 0;
    let deletedDirs = 0;
    let errors = 0;
    for (const rendition of ['live', 'replay']) {
        const renditionDir = path_1.default.join(MEDIA_ROOT, rendition);
        if (!fs_1.default.existsSync(renditionDir))
            continue;
        try {
            const entries = fs_1.default.readdirSync(renditionDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const streamDir = path_1.default.join(renditionDir, entry.name);
                try {
                    const files = fs_1.default.readdirSync(streamDir);
                    let remainingTsCount = 0;
                    for (const file of files) {
                        const filePath = path_1.default.join(streamDir, file);
                        try {
                            const stats = fs_1.default.statSync(filePath);
                            const ageSeconds = now - stats.mtime.getTime() / 1000;
                            if (ageSeconds >= CRON_MAX_AGE_SECONDS) {
                                fs_1.default.unlinkSync(filePath);
                                deletedFiles++;
                            }
                            else if (file.endsWith('.ts')) {
                                remainingTsCount++;
                            }
                        }
                        catch {
                            errors++;
                        }
                    }
                    if (remainingTsCount === 0 && !exports.hlsSessions.has(entry.name)) {
                        try {
                            const leftFiles = fs_1.default.readdirSync(streamDir);
                            for (const f of leftFiles) {
                                fs_1.default.unlinkSync(path_1.default.join(streamDir, f));
                                deletedFiles++;
                            }
                            fs_1.default.rmdirSync(streamDir);
                            deletedDirs++;
                        }
                        catch {
                            errors++;
                        }
                    }
                }
                catch {
                    errors++;
                }
            }
        }
        catch {
            errors++;
        }
    }
    // Tự động dọn dẹp các session và bài cũ trong database quá 24h
    let cleanedSessions = 0;
    let cleanedCards = 0;
    try {
        const dbCleanup = db_1.db.cleanupOldData(CRON_MAX_AGE_SECONDS);
        cleanedSessions = dbCleanup.cleanedSessions;
        cleanedCards = dbCleanup.cleanedCards;
    }
    catch (err) {
        console.error('[MediaServer] Lỗi dọn dẹp Database cron:', err);
        errors++;
    }
    return { deletedFiles, deletedDirs, cleanedSessions, cleanedCards, errors };
}
/** Lấy thông tin thống kê trạng thái dọn dẹp tự động 24h */
function getCleanupStatus() {
    return getMediaStorageStats();
}
function getMediaStorageStats() {
    const now = Date.now() / 1000;
    let totalMediaFiles = 0;
    let totalMediaSizeBytes = 0;
    const streams = [];
    for (const rendition of ['live', 'replay']) {
        const renditionDir = path_1.default.join(MEDIA_ROOT, rendition);
        if (!fs_1.default.existsSync(renditionDir))
            continue;
        try {
            const entries = fs_1.default.readdirSync(renditionDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const streamDir = path_1.default.join(renditionDir, entry.name);
                try {
                    const files = fs_1.default.readdirSync(streamDir);
                    let oldestMs = Infinity;
                    let newestMs = 0;
                    for (const file of files) {
                        const filePath = path_1.default.join(streamDir, file);
                        try {
                            const st = fs_1.default.statSync(filePath);
                            totalMediaFiles++;
                            totalMediaSizeBytes += st.size;
                            const mt = st.mtime.getTime();
                            if (mt < oldestMs)
                                oldestMs = mt;
                            if (mt > newestMs)
                                newestMs = mt;
                        }
                        catch { }
                    }
                    const oldestAgeHours = oldestMs !== Infinity ? (Date.now() - oldestMs) / 3600000 : 0;
                    const newestAgeHours = newestMs !== 0 ? (Date.now() - newestMs) / 3600000 : 0;
                    const isEligible = oldestAgeHours >= (CRON_MAX_AGE_SECONDS / 3600);
                    streams.push({
                        rendition,
                        streamKey: entry.name,
                        fileCount: files.length,
                        oldestFileAgeHours: Math.round(oldestAgeHours * 10) / 10,
                        newestFileAgeHours: Math.round(newestAgeHours * 10) / 10,
                        isEligibleForAutoDelete: isEligible
                    });
                }
                catch { }
            }
        }
        catch { }
    }
    return {
        cronMaxAgeSeconds: CRON_MAX_AGE_SECONDS,
        cronMaxAgeHours: Math.round(CRON_MAX_AGE_SECONDS / 3600),
        cronIntervalMinutes: 60,
        totalMediaFiles,
        totalMediaSizeBytes,
        streams,
        dbStats: {
            cardEntriesCount: db_1.db.getCardEntries().length,
            streamSessionsCount: db_1.db.getStreams().length
        }
    };
}
function startNativeMediaServer() {
    startCleanupScheduler();
    startMediaMtxWatcher();
    console.log(`MediaMTX High-Performance Native Server active:`);
    console.log(`   -> RTMP Ingest (iPhone):  rtmp://<ip>:1935/live/<streamKey>`);
    console.log(`   -> WebRTC Live (WHEP):    http://<ip>:8889/live/<streamKey>/whep`);
    console.log(`   -> RTSP Source (AI):      rtsp://127.0.0.1:8554/live/<streamKey>`);
    console.log(`   -> Replay DVR (HLS):      http://<ip>:4000/replay/<streamKey>/index.m3u8`);
}
