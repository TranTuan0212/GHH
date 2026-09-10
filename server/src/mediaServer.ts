// @ts-ignore
import NodeMediaServer from 'node-media-server';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { EventEmitter } from 'events';

/**
 * Custom HLS Segmenter — bỏ qua NMS trans pipeline (có bug trên Windows).
 *
 * Cách hoạt động:
 * 1. NMS nhận RTMP từ iOS trên port 1935 (chỉ dùng chức năng RTMP ingest, KHÔNG transcode).
 * 2. Mỗi khi stream bắt đầu, ta ghi nhận streamKey.
 * 3. Session HLS riêng: spawn ffmpeg với flags HLS đúng (không qua tee muxer),
 *    xuất .ts + .m3u8 vào <media_root>/live/<streamKey>/.
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

const MEDIA_ROOT = path.join(__dirname, '../media');

const DVR_WINDOW_SECONDS = parseInt(process.env.DVR_WINDOW_SECONDS || '', 10) || 6 * 60 * 60;
const SESSION_TIMEOUT_SECONDS = parseInt(process.env.SESSION_TIMEOUT_SECONDS || '', 10) || 5 * 60;
const CRON_MAX_AGE_SECONDS = parseInt(process.env.CRON_MAX_AGE_SECONDS || '', 10) || 24 * 60 * 60;
const HLS_SEGMENT_SECONDS = 1;

interface HlsSession {
  streamKey: string;
  startTime: number;
  lastSeen: number;
  ffmpegProcesses: ChildProcess[];
}

// Track active HLS sessions: streamKey -> HlsSession
export const hlsSessions: Map<string, HlsSession> = new Map();

let streamEndedHandler: ((streamKey: string) => void) | undefined;

/** Allows the API layer to keep persisted stream status in sync with RTMP disconnects. */
export function setStreamEndedHandler(handler: (streamKey: string) => void): void {
  streamEndedHandler = handler;
}

// Track NMS RTMP sessions so we know when a stream starts/ends
const nmsSessions: Map<string, { streamKey: string; connectedAt: number }> = new Map();

// Map NMS session id -> streamKey
const sessionToStreamKey: Map<string, string> = new Map();

function getStreamDir(rendition: 'live' | 'replay', streamKey: string): string {
  return path.join(MEDIA_ROOT, rendition, streamKey);
}

export function cleanupStreamSession(streamKey: string): void {
  const session = hlsSessions.get(streamKey);
  if (session) {
    for (const process of session.ffmpegProcesses) {
      if (!process.killed) process.kill('SIGTERM');
    }
    hlsSessions.delete(streamKey);
  }
  let deleted = 0;
  for (const rendition of ['live', 'replay'] as const) {
    const dir = getStreamDir(rendition, streamKey);
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.ts') || file.endsWith('.m3u8') || file.endsWith('.mp4')) {
            fs.unlinkSync(path.join(dir, file));
            deleted++;
          }
        }
        try { fs.rmdirSync(dir); } catch { /* ignore if not empty */ }
      }
    } catch (err) {
      console.error(`[MediaServer] Cleanup error for ${streamKey}/${rendition}:`, err);
    }
  }
  console.log(`[MediaServer] Cleanup session ${streamKey}: deleted ${deleted} files`);
}

/** Start HLS segmentation for a streamKey using ffmpeg directly */
/*
 * Two independent FFmpeg consumers deliberately read the same RTMP source. This keeps the
 * replay master immutable while allowing the browser-friendly rendition to be transcoded.
 */
function startHlsSession(streamKey: string): void {
  // `/replay` is the master DVR: source H.264 frames and their PTS are copied unchanged.
  const outputDir = getStreamDir('replay', streamKey);
  const liveOutputDir = getStreamDir('live', streamKey);

  // Create output directory
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(liveOutputDir, { recursive: true });
  } catch (err) {
    console.error(`[MediaServer] Cannot create output dir ${outputDir}:`, err);
    return;
  }

  // ffmpeg command: receive RTMP, output HLS (video-only, no audio).
  // Do not create a synthetic playlist here: a playlist pointing to a non-existent
  // segment makes hls.js stop/retry the wrong resource before the first real frame.
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

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
    '-hls_segment_filename', path.join(outputDir, '%05d.ts'),
    '-hls_flags', '+independent_segments',
    path.join(outputDir, 'index.m3u8')
  ];

  // This browser-only rendition is never used for replay. `fps=60` samples by PTS in
  // chronological order, while one-second GOPs give HLS a keyframe index every second.
  const liveFfmpegArgs = [
    '-i', `rtmp://localhost:1935/live/${streamKey}`,
    '-map', '0:v:0',
    '-an',
    '-vf', 'fps=60',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-b:v', '3500k',
    '-maxrate', '4000k',
    '-bufsize', '7000k',
    '-g', '60',
    '-keyint_min', '60',
    '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*1)',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_list_size', String(hlsListSize),
    '-hls_segment_filename', path.join(liveOutputDir, '%05d.ts'),
    '-hls_flags', '+independent_segments',
    path.join(liveOutputDir, 'index.m3u8')
  ];

  console.log(`[MediaServer] Starting dual HLS session for ${streamKey}:`);
  console.log(`[MediaServer]   DVR_WINDOW_SECONDS=${DVR_WINDOW_SECONDS} | HLS_SEGMENT_SECONDS=${HLS_SEGMENT_SECONDS} | hls_list_size=${hlsListSize} (segments)`);
  console.log(`[MediaServer]   master replay: /replay/${streamKey} (copy source FPS + PTS)`);
  console.log(`[MediaServer]   web live:      /live/${streamKey} (60fps, 3.5Mbps)`);

  const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const liveFfmpeg = spawn(ffmpegPath, liveFfmpegArgs, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const session: HlsSession = {
    streamKey,
    startTime: Date.now() / 1000,
    lastSeen: Date.now() / 1000,
    ffmpegProcesses: [ffmpeg, liveFfmpeg]
  };
  hlsSessions.set(streamKey, session);

  ffmpeg.stdout.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      console.log(`[MediaServer] [ffmpeg ${streamKey}] STDOUT: ${line}`);
    }
  });

  ffmpeg.stderr.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      // CHỈ log những dòng quan trọng để tránh spam. Giữ progress frame.
      const isImportant = /error|warning|fatal|cannot|failed|input|output|hls|segment|stream mapping/i.test(line);
      if (isImportant) {
        console.log(`[MediaServer] [ffmpeg ${streamKey}] ${line}`);
      }
      // Cập nhật lastSeen khi ffmpeg nhận được dữ liệu (bất kỳ output nào)
      const s = hlsSessions.get(streamKey);
      if (s) s.lastSeen = Date.now() / 1000;
    }
  });

  ffmpeg.on('error', (err: Error) => {
    console.error(`[MediaServer] ffmpeg error for ${streamKey}:`, err);
    cleanupStreamSession(streamKey);
  });

  ffmpeg.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    console.log(`[MediaServer] replay FFmpeg exited for ${streamKey} with code=${code} signal=${signal}`);
  });

  liveFfmpeg.stderr.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (!line) return;
    const isImportant = /error|warning|fatal|cannot|failed|input|output|hls|segment|stream mapping/i.test(line);
    if (isImportant) console.log(`[MediaServer] [live ${streamKey}] ${line}`);
    const active = hlsSessions.get(streamKey);
    if (active) active.lastSeen = Date.now() / 1000;
  });
  liveFfmpeg.on('error', (err: Error) => {
    console.error(`[MediaServer] live FFmpeg error for ${streamKey}:`, err);
    cleanupStreamSession(streamKey);
  });
  liveFfmpeg.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    console.log(`[MediaServer] live FFmpeg exited for ${streamKey} with code=${code} signal=${signal}`);
  });
  console.log(`[MediaServer] Dual HLS session started for ${streamKey}`);
}

/** Called when NMS detects a new RTMP publish */
function onStreamStart(sessionId: string, streamPath: string): void {
  const streamKey = streamPath.split('/').pop() || streamPath;
  if (hlsSessions.has(streamKey)) {
    console.log(`[MediaServer] Stream ${streamKey} already has HLS session, skipping`);
    return;
  }
  sessionToStreamKey.set(sessionId, streamKey);
  nmsSessions.set(sessionId, { streamKey, connectedAt: Date.now() / 1000 });
  startHlsSession(streamKey);
}

/** Called when NMS detects RTMP disconnect */
function onStreamEnd(sessionId: string): void {
  const streamKey = sessionToStreamKey.get(sessionId);
  if (!streamKey) return;
  sessionToStreamKey.delete(sessionId);
  nmsSessions.delete(sessionId);

  // Stop ffmpeg HLS session
  const session = hlsSessions.get(streamKey);
  if (session) {
    for (const process of session.ffmpegProcesses) {
      if (!process.killed) process.kill('SIGTERM');
    }
    hlsSessions.delete(streamKey);
    console.log(`[MediaServer] Stream ${streamKey} ended, HLS ffmpeg stopped`);
  }
  // BUG FIX: cũ chỉ kill ffmpeg nhưng không xóa files -> thư mục treo trên đĩa.
  // Gọi cleanupStreamSession để xóa .ts/.m3u8 ngay khi stream kết thúc bình thường.
  cleanupStreamSession(streamKey);
  streamEndedHandler?.(streamKey);
}

/** Background cleanup: timeout check */
function startCleanupScheduler(): void {
  const TIMEOUT_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || '', 10) || 60_000;
  const CRON_INTERVAL_MS = parseInt(process.env.CRON_INTERVAL_MS || '', 10) || 24 * 60 * 60_000;

  setInterval(() => {
    timeoutCheckOnce();
  }, TIMEOUT_INTERVAL_MS);

  // Cron: delete .ts files older than CRON_MAX_AGE_SECONDS
  setInterval(() => {
    const result = runCronCleanupOnce();
    if (result.deleted > 0) {
      console.log(`[MediaServer] Cron cleanup: deleted ${result.deleted} old .ts files`);
    }
  }, CRON_INTERVAL_MS);
}

/**
 * Run a single timeout check pass. Exported for testing.
 * Returns the list of cleaned up streamKeys.
 */
export function timeoutCheckOnce(): string[] {
  const now = Date.now() / 1000;
  const cleaned: string[] = [];
  // Timeout: no segment for SESSION_TIMEOUT_SECONDS → cleanup
  for (const [streamKey, session] of hlsSessions) {
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

export function runCronCleanupOnce(): { deleted: number; errors: number } {
  const now = Date.now() / 1000;
  let deleted = 0;
  let errors = 0;
  for (const rendition of ['live', 'replay'] as const) {
    const renditionDir = path.join(MEDIA_ROOT, rendition);
    if (!fs.existsSync(renditionDir)) continue;
    try {
      const entries = fs.readdirSync(renditionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const streamDir = path.join(renditionDir, entry.name);
        try {
          const files = fs.readdirSync(streamDir);
          for (const file of files) {
            if (!file.endsWith('.ts')) continue;
            const filePath = path.join(streamDir, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtime.getTime() / 1000 > CRON_MAX_AGE_SECONDS) {
              fs.unlinkSync(filePath);
              deleted++;
            }
          }
        } catch {
          errors++;
        }
      }
    } catch {
      errors++;
    }
  }
  return { deleted, errors };
}

export function startNativeMediaServer(): void {
  // === NMS: chỉ dùng cho RTMP ingest + HTTP serving ===
  // Bỏ trans.tasks — custom HLS wrapper thay thế hoàn toàn
  const mediaConfig: any = {
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
    const nms = new NodeMediaServer(mediaConfig);

    // Khi iOS bắt đầu push RTMP
    nms.on('prePublish', (id: string, StreamPath: string, _args: any) => {
      console.log(`[MediaServer] iPhone bắt đầu phát RTMP: ${StreamPath}`);
      onStreamStart(id, StreamPath);
    });

    // Khi iOS ngắt kết nối (stop hoặc crash)
    nms.on('donePublish', (id: string, StreamPath: string, _args: any) => {
      console.log(`[MediaServer] iPhone dừng phát RTMP: ${StreamPath}`);
      onStreamEnd(id);
    });

    nms.run();

    startCleanupScheduler();

    console.log(`Native RTMP/HLS Media Server đang chạy:`);
    console.log(`   -> RTMP Ingest (iPhone):  rtmp://localhost:1935/live`);
    console.log(`   -> HLS Live (Web):       http://localhost:8000/live/<streamKey>/index.m3u8 (60fps)`);
    console.log(`   -> HLS Replay (Master):  http://localhost:8000/replay/<streamKey>/index.m3u8 (source FPS)`);
    console.log(`   -> DVR window:            ${DVR_WINDOW_SECONDS / 3600}h (segment ${HLS_SEGMENT_SECONDS}s, hls_list_size=${Math.ceil(DVR_WINDOW_SECONDS / HLS_SEGMENT_SECONDS)} segments)`);
    console.log(`   -> Media root:           ${MEDIA_ROOT}`);
  } catch (err) {
    console.error(`[MediaServer] Lỗi khởi tạo:`, err);
  }
}
