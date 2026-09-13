"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hlsSessions = void 0;
exports.setStreamEndedHandler = setStreamEndedHandler;
exports.cleanupStreamSession = cleanupStreamSession;
exports.stopFfmpegOnly = stopFfmpegOnly;
exports.resetReplaySession = resetReplaySession;
exports.timeoutCheckOnce = timeoutCheckOnce;
exports.runCronCleanupOnce = runCronCleanupOnce;
exports.getCleanupStatus = getCleanupStatus;
exports.startNativeMediaServer = startNativeMediaServer;
// @ts-ignore
const node_media_server_1 = __importDefault(require("node-media-server"));
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const db_1 = require("./db");
/**
 * Custom HLS Segmenter — bỏ qua NMS trans pipeline (có bug trên Windows).
 *
 * Cách hoạt động:
 * 1. NMS nhận RTMP từ iOS trên port 1935 (chỉ dùng chức năng RTMP ingest, KHÔNG transcode).
 * 2. Mỗi khi stream bắt đầu, ta ghi nhận streamKey.
 * 3. Session DVR riêng: copy source vào HLS replay (không re-encode).
 * 4. Session live riêng: decode high-FPS, drop frame khi cần và encode 60 FPS
 *    vào MediaMTX qua RTSP. Browser đọc rendition này qua WHEP/WebRTC.
 *
 * Bug NMS đã phát hiện trong quá trình test:
 * - NMS trans dùng tee muxer: `-f tee -map 0:a? -map 0:v? [hls_flags]url` → FFmpeg 9.x
 *   không xử lý được HLS output trong tee context trên Windows → "All tee outputs failed".
 * - NMS không hỗ trợ {streamKey} template trong hls_segment_filename.
 * - NMS tự xóa HLS file khi stream kết thúc (deleteHlsFiles trong node_trans_session.js).
 *
 * Giải pháp: custom wrapper không dùng tee, gọi ffmpeg trực tiếp:
 *   ffmpeg -i rtmp://localhost:1935/live/<streamKey> \
 *          -c:v copy -c:a aac -f hls \
 *          -hls_time 1 -hls_list_size <N> \
 *          -hls_segment_filename '%05d.ts' \
 *          <output_dir>/index.m3u8
 */
const MEDIA_ROOT = path_1.default.join(__dirname, '../media');
const DVR_WINDOW_SECONDS = parseInt(process.env.DVR_WINDOW_SECONDS || '', 10) || 6 * 60 * 60;
const SESSION_TIMEOUT_SECONDS = parseInt(process.env.SESSION_TIMEOUT_SECONDS || '', 10) || 5 * 60;
const CRON_MAX_AGE_SECONDS = parseInt(process.env.CRON_MAX_AGE_SECONDS || '', 10) || 24 * 60 * 60;
const HLS_SEGMENT_SECONDS = 1;
// Live preview is intentionally lower-FPS than the 120/240fps DVR master, but 60fps
// avoids the visibly choppy 30fps motion in the operator's live monitor. The master
// still keeps every source frame for slow motion.
const LIVE_PREVIEW_FPS = parseInt(process.env.LIVE_PREVIEW_FPS || '', 10) || 60;
// Track active HLS sessions: streamKey -> HlsSession
exports.hlsSessions = new Map();
let streamEndedHandler;
/** Allows the API layer to keep persisted stream status in sync with RTMP disconnects. */
function setStreamEndedHandler(handler) {
    streamEndedHandler = handler;
}
// Track NMS RTMP sessions so we know when a stream starts/ends
const nmsSessions = new Map();
// Map NMS session id -> streamKey
const sessionToStreamKey = new Map();
function getStreamDir(rendition, streamKey) {
    return path_1.default.join(MEDIA_ROOT, rendition, streamKey);
}
function cleanupStreamSession(streamKey) {
    const session = exports.hlsSessions.get(streamKey);
    if (session) {
        for (const process of session.ffmpegProcesses) {
            if (!process.killed)
                process.kill('SIGTERM');
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
                catch { /* ignore if not empty */ }
            }
        }
        catch (err) {
            console.error(`[MediaServer] Cleanup error for ${streamKey}/${rendition}:`, err);
        }
    }
    console.log(`[MediaServer] Cleanup session ${streamKey}: deleted ${deleted} files`);
}
/**
 * Chỉ dừng FFmpeg process, KHÔNG xóa file .ts/.m3u8.
 * Dùng khi người dùng bấm "Dừng Live" — giữ lại file replay để người xem tua lại.
 * File sẽ được cron xóa sau CRON_MAX_AGE_SECONDS (mặc định 24h).
 */
function stopFfmpegOnly(streamKey) {
    const session = exports.hlsSessions.get(streamKey);
    if (session) {
        for (const process of session.ffmpegProcesses) {
            if (!process.killed)
                process.kill('SIGTERM');
        }
        exports.hlsSessions.delete(streamKey);
        console.log(`[MediaServer] FFmpeg stopped for ${streamKey} (files preserved for replay)`);
    }
}
/**
 * Làm mới toàn bộ bộ đệm Replay cho streamKey khi bấm "Xong Phiên":
 * 1. Dừng tiến trình FFmpeg replay cũ.
 * 2. Xóa sạch các file .ts và playlist .m3u8 cũ của phiên trước.
 * 3. Khởi động tiến trình FFmpeg replay mới để thu thập dữ liệu từ mốc 0s của phiên mới.
 * Lưu ý: Luồng WebRTC Live (Live preview) vẫn tiếp tục chạy không bị ảnh hưởng.
 */
function resetReplaySession(streamKey) {
    const session = exports.hlsSessions.get(streamKey);
    // 1. Dừng tiến trình ffmpeg replay cũ nếu stream đang chạy
    if (session) {
        const oldReplayFfmpeg = session.ffmpegProcesses[0];
        if (oldReplayFfmpeg && !oldReplayFfmpeg.killed) {
            try {
                oldReplayFfmpeg.kill('SIGTERM');
            }
            catch { }
        }
    }
    // 2. Xóa sạch file .ts và index.m3u8 cũ trong thư mục replay
    const outputDir = getStreamDir('replay', streamKey);
    try {
        if (fs_1.default.existsSync(outputDir)) {
            const files = fs_1.default.readdirSync(outputDir);
            for (const file of files) {
                if (file.endsWith('.ts') || file.endsWith('.m3u8') || file.endsWith('.tmp')) {
                    try {
                        fs_1.default.unlinkSync(path_1.default.join(outputDir, file));
                    }
                    catch { }
                }
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
    // Nếu stream đã kết thúc (không còn trong hlsSessions), dọn dẹp cả thư mục live và replay
    if (!session) {
        const liveDir = getStreamDir('live', streamKey);
        try {
            if (fs_1.default.existsSync(liveDir)) {
                const files = fs_1.default.readdirSync(liveDir);
                for (const file of files) {
                    try {
                        fs_1.default.unlinkSync(path_1.default.join(liveDir, file));
                    }
                    catch { }
                }
                try {
                    fs_1.default.rmdirSync(liveDir);
                }
                catch { }
            }
        }
        catch { }
        console.log(`[MediaServer] Đã xóa sạch toàn bộ video replay và live cũ của stream ${streamKey} (phiên stream đã dừng)`);
        return true;
    }
    // 3. Nếu stream vẫn đang LIVE: Khởi động lại ffmpeg replay mới để bắt đầu từ mốc 0s của phiên mới
    const bundledFfmpeg = path_1.default.join(__dirname, '../tools/ffmpeg/ffmpeg.exe');
    const ffmpegPath = process.env.FFMPEG_PATH || (fs_1.default.existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg');
    const hlsListSize = Math.max(1, Math.ceil(DVR_WINDOW_SECONDS / HLS_SEGMENT_SECONDS));
    const ffmpegArgs = [
        '-i', `rtmp://localhost:1935/live/${streamKey}`,
        '-c:v', 'copy',
        '-an',
        '-f', 'hls',
        '-hls_time', String(HLS_SEGMENT_SECONDS),
        '-hls_list_size', String(hlsListSize),
        '-hls_segment_filename', path_1.default.join(outputDir, '%05d.ts'),
        '-hls_flags', '+program_date_time',
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
/** Start HLS segmentation for a streamKey using ffmpeg directly */
/*
 * Two independent FFmpeg consumers deliberately read the same RTMP source. This keeps the
 * replay master immutable while allowing the disposable WebRTC rendition to be transcoded.
 */
function startHlsSession(streamKey) {
    // `/replay` is the master DVR: source H.264 frames and their PTS are copied unchanged.
    const outputDir = getStreamDir('replay', streamKey);
    // Create output directory
    try {
        fs_1.default.mkdirSync(outputDir, { recursive: true });
    }
    catch (err) {
        console.error(`[MediaServer] Cannot create output dir ${outputDir}:`, err);
        return;
    }
    // ffmpeg command: receive RTMP, output HLS (video-only, no audio).
    // Do not create a synthetic playlist here: a playlist pointing to a non-existent
    // segment makes hls.js stop/retry the wrong resource before the first real frame.
    // Keep the runtime self-contained on Windows when the project-local binary is present.
    // FFMPEG_PATH remains an escape hatch for a system-managed FFmpeg installation.
    const bundledFfmpeg = path_1.default.join(__dirname, '../tools/ffmpeg/ffmpeg.exe');
    const ffmpegPath = process.env.FFMPEG_PATH || (fs_1.default.existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg');
    // hls_list_size của ffmpeg tính theo SỐ SEGMENT trong playlist, không phải số giây.
    // Với mỗi segment dài HLS_SEGMENT_SECONDS giây, số segment cần giữ để đạt đúng
    // DVR_WINDOW_SECONDS giây = DVR_WINDOW_SECONDS / HLS_SEGMENT_SECONDS.
    // BUG CŨ: truyền thẳng DVR_WINDOW_SECONDS (giây) làm hls_list_size -> cửa sổ DVR thực tế
    // bị nhân đôi (12h thay vì 6h mặc định) vì mỗi segment dài 2s.
    // One-second segments keep the live path close to the current camera timeline.
    // The encoded source is copied, so the DVR retains its original frame rate.
    const hlsListSize = Math.max(1, Math.ceil(DVR_WINDOW_SECONDS / HLS_SEGMENT_SECONDS));
    const ffmpegArgs = [
        // Input: RTMP từ NMS (NMS listen trên 1935, ta connect với tư cách viewer).
        // KHÔNG dùng '-re' ở đây: '-re' chỉ có ý nghĩa khi đọc FILE TĨNH để giả lập tốc độ
        // đọc real-time; input ở đây đã là luồng RTMP sống (đã tự "real-time" theo timestamp
        // gốc), dùng '-re' có thể gây sai pacing/trễ không cần thiết.
        '-i', `rtmp://localhost:1935/live/${streamKey}`,
        // Codec: giữ nguyên video H.264 từ LFLiveKit (không re-encode)
        '-c:v', 'copy',
        // KHÔNG có audio - iOS LFLiveKit không push audio track
        '-an',
        // HLS output
        '-f', 'hls',
        '-hls_time', String(HLS_SEGMENT_SECONDS),
        '-hls_list_size', String(hlsListSize),
        '-hls_segment_filename', path_1.default.join(outputDir, '%05d.ts'),
        // This is a stream copy, therefore FFmpeg cannot guarantee that the first segment
        // (when it attaches mid-GOP) starts with an IDR frame. Advertising all segments as
        // independent makes hls.js seek straight into an undecodable GOP and render black.
        // Without the flag, hls.js backtracks to a decodable segment before the requested PTS.
        '-hls_flags', '+program_date_time',
        path_1.default.join(outputDir, 'index.m3u8')
    ];
    // This browser-only rendition is never used for replay. The fps filter emits no more than
    // LIVE_PREVIEW_FPS; frames that cannot be encoded in time are intentionally disposable. The
    // RTSP destination is consumed by MediaMTX and exposed to the browser with WHEP/WebRTC.
    const liveFfmpegArgs = [
        // LFLiveKit at 240fps occasionally emits a malformed access unit. This is only for
        // the disposable 60fps rendition: drop that corrupt packet and continue decoding the
        // next frame instead of blocking the entire live encoder. The replay master remains
        // an untouched `-c:v copy` stream above.
        '-fflags', '+genpts+discardcorrupt',
        '-err_detect', 'ignore_err',
        '-i', `rtmp://localhost:1935/live/${streamKey}`,
        '-map', '0:v:0',
        '-an',
        '-vf', `fps=${LIVE_PREVIEW_FPS}:round=down`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        // Baseline + no B-frames is the common denominator for browser WebRTC decoders.
        // Repeat SPS/PPS on every 1s IDR so a viewer joining an already-running RTSP
        // publisher can decode immediately instead of displaying a black video element.
        '-profile:v', 'baseline',
        '-level:v', '4.1',
        '-pix_fmt', 'yuv420p',
        '-bf', '0',
        '-x264-params', `keyint=${LIVE_PREVIEW_FPS}:min-keyint=${LIVE_PREVIEW_FPS}:scenecut=0:repeat-headers=1:aq-mode=2`,
        '-b:v', '5200k',
        '-maxrate', '6500k',
        '-bufsize', '8000k',
        '-g', String(LIVE_PREVIEW_FPS),
        '-keyint_min', String(LIVE_PREVIEW_FPS),
        '-sc_threshold', '0',
        '-force_key_frames', 'expr:gte(t,n_forced*1)',
        '-f', 'rtsp',
        '-rtsp_transport', 'tcp',
        `rtsp://127.0.0.1:8554/${streamKey}`
    ];
    console.log(`[MediaServer] Starting DVR + WebRTC session for ${streamKey}:`);
    console.log(`[MediaServer]   DVR_WINDOW_SECONDS=${DVR_WINDOW_SECONDS} | HLS_SEGMENT_SECONDS=${HLS_SEGMENT_SECONDS} | hls_list_size=${hlsListSize} (segments)`);
    console.log(`[MediaServer]   master replay: /replay/${streamKey} (copy source FPS + PTS)`);
    console.log(`[MediaServer]   web live:      WHEP /${streamKey}/whep (${LIVE_PREVIEW_FPS}fps, 2.2Mbps)`);
    const ffmpeg = (0, child_process_1.spawn)(ffmpegPath, ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const liveFfmpeg = (0, child_process_1.spawn)(ffmpegPath, liveFfmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const session = {
        streamKey,
        startTime: Date.now() / 1000,
        lastSeen: Date.now() / 1000,
        ffmpegProcesses: [ffmpeg, liveFfmpeg]
    };
    exports.hlsSessions.set(streamKey, session);
    ffmpeg.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line) {
            console.log(`[MediaServer] [ffmpeg ${streamKey}] STDOUT: ${line}`);
        }
    });
    ffmpeg.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) {
            // CHỈ log những dòng quan trọng để tránh spam. Giữ progress frame.
            const isImportant = /error|warning|fatal|cannot|failed|input|output|hls|segment|stream mapping/i.test(line);
            if (isImportant) {
                console.log(`[MediaServer] [ffmpeg ${streamKey}] ${line}`);
            }
            // Cập nhật lastSeen khi ffmpeg nhận được dữ liệu (bất kỳ output nào)
            const s = exports.hlsSessions.get(streamKey);
            if (s)
                s.lastSeen = Date.now() / 1000;
        }
    });
    ffmpeg.on('error', (err) => {
        console.error(`[MediaServer] ffmpeg error for ${streamKey}:`, err);
        cleanupStreamSession(streamKey);
    });
    ffmpeg.on('close', (code, signal) => {
        console.log(`[MediaServer] replay FFmpeg exited for ${streamKey} with code=${code} signal=${signal}`);
    });
    liveFfmpeg.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (!line)
            return;
        const isImportant = /error|warning|fatal|cannot|failed|input|output|hls|segment|stream mapping/i.test(line);
        if (isImportant)
            console.log(`[MediaServer] [live ${streamKey}] ${line}`);
        const active = exports.hlsSessions.get(streamKey);
        if (active)
            active.lastSeen = Date.now() / 1000;
    });
    liveFfmpeg.on('error', (err) => {
        console.error(`[MediaServer] live FFmpeg error for ${streamKey}:`, err);
        cleanupStreamSession(streamKey);
    });
    liveFfmpeg.on('close', (code, signal) => {
        console.log(`[MediaServer] live FFmpeg exited for ${streamKey} with code=${code} signal=${signal}`);
    });
    console.log(`[MediaServer] DVR + WebRTC session started for ${streamKey}`);
}
/** Called when NMS detects a new RTMP publish */
function onStreamStart(sessionId, streamPath) {
    const streamKey = streamPath.split('/').pop() || streamPath;
    if (exports.hlsSessions.has(streamKey)) {
        console.log(`[MediaServer] Stream ${streamKey} already has HLS session, skipping`);
        return;
    }
    sessionToStreamKey.set(sessionId, streamKey);
    nmsSessions.set(sessionId, { streamKey, connectedAt: Date.now() / 1000 });
    startHlsSession(streamKey);
}
/** Called when NMS detects RTMP disconnect */
function onStreamEnd(sessionId) {
    const streamKey = sessionToStreamKey.get(sessionId);
    if (!streamKey)
        return;
    sessionToStreamKey.delete(sessionId);
    nmsSessions.delete(sessionId);
    // Stop ffmpeg HLS session
    const session = exports.hlsSessions.get(streamKey);
    if (session) {
        for (const process of session.ffmpegProcesses) {
            if (!process.killed)
                process.kill('SIGTERM');
        }
        exports.hlsSessions.delete(streamKey);
        console.log(`[MediaServer] Stream ${streamKey} ended, HLS ffmpeg stopped`);
    }
    // QUAN TRỌNG: KHÔNG xóa file replay ngay khi RTMP ngắt!
    // Mục đích của DVR là để người xem tua lại, xem slow motion các pha vừa qua kể cả khi
    // iPhone dừng phát hoặc mạng gián đoạn tạm thời. Các file cũ sẽ do Cron tự động dọn dẹp sau.
    streamEndedHandler?.(streamKey);
}
/** Background cleanup: timeout check */
function startCleanupScheduler() {
    const TIMEOUT_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || '', 10) || 60_000;
    // Dọn dẹp định kỳ mỗi 1 tiếng (thay vì 24 tiếng) để ổ cứng không bị đầy segment video test cũ
    const CRON_INTERVAL_MS = parseInt(process.env.CRON_INTERVAL_MS || '', 10) || 60 * 60_000;
    setInterval(() => {
        timeoutCheckOnce();
    }, TIMEOUT_INTERVAL_MS);
    // Chạy ngay 1 lần sau khi khởi động 5s để giải phóng ổ cứng nếu có session cũ
    setTimeout(() => {
        const res = runCronCleanupOnce();
        if (res.deletedFiles > 0) {
            console.log(`[MediaServer] Dọn dẹp khởi động: đã giải phóng ${res.deletedFiles} file .ts cũ hết hạn`);
        }
    }, 5000);
    // Cron: delete .ts files older than CRON_MAX_AGE_SECONDS
    setInterval(() => {
        const result = runCronCleanupOnce();
        if (result.deletedFiles > 0) {
            console.log(`[MediaServer] Cron cleanup: deleted ${result.deletedFiles} old .ts files`);
        }
    }, CRON_INTERVAL_MS);
}
/**
 * Run a single timeout check pass. Exported for testing.
 * Returns the list of cleaned up streamKeys.
 */
function timeoutCheckOnce() {
    const now = Date.now() / 1000;
    const cleaned = [];
    // Timeout: no segment for SESSION_TIMEOUT_SECONDS → cleanup
    for (const [streamKey, session] of exports.hlsSessions) {
        if (now - session.lastSeen > SESSION_TIMEOUT_SECONDS) {
            console.warn(`[MediaServer] Stream ${streamKey} timeout — cleaning up`);
            cleanupStreamSession(streamKey);
            cleaned.push(streamKey);
        }
    }
    // Also check NMS sessions (in case HLS ffmpeg crashed but NMS still has session)
    for (const [sessionId, info] of nmsSessions) {
        if (now - info.connectedAt > SESSION_TIMEOUT_SECONDS) {
            console.warn(`[MediaServer] NMS session ${sessionId} (${info.streamKey}) timeout`);
            onStreamEnd(sessionId);
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
                            if (file.endsWith('.ts')) {
                                if (ageSeconds > CRON_MAX_AGE_SECONDS) {
                                    fs_1.default.unlinkSync(filePath);
                                    deletedFiles++;
                                }
                                else {
                                    remainingTsCount++;
                                }
                            }
                        }
                        catch {
                            errors++;
                        }
                    }
                    // Nếu thư mục không còn segment .ts nào và không phải là phiên đang live, dọn dẹp toàn bộ thư mục
                    const isCurrentlyActive = exports.hlsSessions.has(entry.name);
                    if (remainingTsCount === 0 && !isCurrentlyActive) {
                        try {
                            const remaining = fs_1.default.readdirSync(streamDir);
                            for (const rf of remaining) {
                                fs_1.default.unlinkSync(path_1.default.join(streamDir, rf));
                                deletedFiles++;
                            }
                            fs_1.default.rmdirSync(streamDir);
                            deletedDirs++;
                        }
                        catch { }
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
    const dbCleanup = db_1.db.cleanupOldData(CRON_MAX_AGE_SECONDS);
    return {
        deletedFiles,
        deletedDirs,
        cleanedSessions: dbCleanup.cleanedSessions,
        cleanedCards: dbCleanup.cleanedCards,
        errors
    };
}
/** Lấy thông tin thống kê trạng thái dọn dẹp tự động 24h */
function getCleanupStatus() {
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
    // === NMS: chỉ dùng cho RTMP ingest + HTTP serving ===
    // Bỏ trans.tasks — custom HLS wrapper thay thế hoàn toàn
    const mediaConfig = {
        rtmp: {
            port: 1935,
            chunk_size: 60000,
            gop_cache: true,
            ping: 30,
            ping_timeout: 60
        },
        http: {
            port: 8000,
            mediaroot: MEDIA_ROOT.replace(/\\/g, '/'),
            allow_origin: '*'
        }
        // KHÔNG có trans.tasks — dùng custom HLS wrapper thay vì NMS trans pipeline
    };
    try {
        const nms = new node_media_server_1.default(mediaConfig);
        // Khi iOS bắt đầu push RTMP
        nms.on('prePublish', (id, StreamPath, _args) => {
            console.log(`[MediaServer] iPhone bắt đầu phát RTMP: ${StreamPath}`);
            onStreamStart(id, StreamPath);
        });
        // Khi iOS ngắt kết nối (stop hoặc crash)
        nms.on('donePublish', (id, StreamPath, _args) => {
            console.log(`[MediaServer] iPhone dừng phát RTMP: ${StreamPath}`);
            onStreamEnd(id);
        });
        nms.run();
        startCleanupScheduler();
        console.log(`Native RTMP/DVR + WebRTC Media Server đang chạy:`);
        console.log(`   -> RTMP Ingest (iPhone):  rtmp://localhost:1935/live`);
        console.log(`   -> WebRTC Live (WHEP):   http://localhost:8889/<streamKey>/whep (60fps)`);
        console.log(`   -> HLS Replay (Master):  http://localhost:8000/replay/<streamKey>/index.m3u8 (source FPS)`);
        console.log(`   -> DVR window:            ${DVR_WINDOW_SECONDS / 3600}h (segment ${HLS_SEGMENT_SECONDS}s, hls_list_size=${Math.ceil(DVR_WINDOW_SECONDS / HLS_SEGMENT_SECONDS)} segments)`);
        console.log(`   -> Media root:           ${MEDIA_ROOT}`);
    }
    catch (err) {
        console.error(`[MediaServer] Lỗi khởi tạo:`, err);
    }
}
