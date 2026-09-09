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

interface HlsSession {
  streamKey: string;
  startTime: number;
  lastSeen: number;
  ffmpegProcess: ChildProcess | null;
  outputDir: string;
}

// Track active HLS sessions: streamKey -> HlsSession
export const hlsSessions: Map<string, HlsSession> = new Map();

// Track NMS RTMP sessions so we know when a stream starts/ends
const nmsSessions: Map<string, { streamKey: string; connectedAt: number }> = new Map();

// Map NMS session id -> streamKey
const sessionToStreamKey: Map<string, string> = new Map();

function getStreamDir(streamKey: string): string {
  return path.join(MEDIA_ROOT, 'live', streamKey);
}

export function cleanupStreamSession(streamKey: string): void {
  const session = hlsSessions.get(streamKey);
  if (session) {
    if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
      session.ffmpegProcess.kill('SIGTERM');
    }
    hlsSessions.delete(streamKey);
  }
  const dir = getStreamDir(streamKey);
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      let deleted = 0;
      for (const file of files) {
        if (file.endsWith('.ts') || file.endsWith('.m3u8') || file.endsWith('.mp4')) {
          fs.unlinkSync(path.join(dir, file));
          deleted++;
        }
      }
      try { fs.rmdirSync(dir); } catch { /* ignore if not empty */ }
      console.log(`[MediaServer] Cleanup session ${streamKey}: deleted ${deleted} files`);
    }
  } catch (err) {
    console.error(`[MediaServer] Cleanup error for ${streamKey}:`, err);
  }
}

/** Start HLS segmentation for a streamKey using ffmpeg directly */
function startHlsSession(streamKey: string): void {
  const outputDir = getStreamDir(streamKey);

  // Create output directory
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    console.error(`[MediaServer] Cannot create output dir ${outputDir}:`, err);
    return;
  }

  // ffmpeg command: receive RTMP, output HLS
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffmpegArgs = [
    // Input: RTMP from NMS (NMS listen on 1935, ta connect với tư cách viewer)
    '-re',
    '-i', `rtmp://localhost:1935/live/${streamKey}`,
    // Audio: tạo silent AAC stereo 44100Hz (LFLiveKit không có audio track)
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-map', '0:v?',
    '-map', '1:a',
    // Codec: giữ nguyên video H.264 từ LFLiveKit (không re-encode)
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    // HLS output
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', String(DVR_WINDOW_SECONDS),
    '-hls_segment_filename', path.join(outputDir, '%05d.ts'),
    path.join(outputDir, 'index.m3u8')
  ];

  console.log(`[MediaServer] Starting HLS session for ${streamKey}:`);
  console.log(`[MediaServer]   ffmpeg ${ffmpegArgs.join(' ')}`);

  const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const session: HlsSession = {
    streamKey,
    startTime: Date.now() / 1000,
    lastSeen: Date.now() / 1000,
    ffmpegProcess: ffmpeg,
    outputDir
  };
  hlsSessions.set(streamKey, session);

  ffmpeg.stderr.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      console.log(`[MediaServer] [ffmpeg ${streamKey}] ${line}`);
    }
  });

  ffmpeg.on('error', (err: Error) => {
    console.error(`[MediaServer] ffmpeg error for ${streamKey}:`, err);
    cleanupStreamSession(streamKey);
  });

  ffmpeg.on('close', (code: number | null) => {
    console.log(`[MediaServer] ffmpeg exited for ${streamKey} with code ${code}`);
    // Don't auto-cleanup here — wait for NMS donePublish to cleanup
    hlsSessions.delete(streamKey);
  });

  console.log(`[MediaServer] HLS session started for ${streamKey}, output: ${outputDir}`);
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
  if (session && session.ffmpegProcess) {
    session.ffmpegProcess.kill('SIGTERM');
    hlsSessions.delete(streamKey);
    console.log(`[MediaServer] Stream ${streamKey} ended, HLS ffmpeg stopped`);
  }
  // BUG FIX: cũ chỉ kill ffmpeg nhưng không xóa files -> thư mục treo trên đĩa.
  // Gọi cleanupStreamSession để xóa .ts/.m3u8 ngay khi stream kết thúc bình thường.
  cleanupStreamSession(streamKey);
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
  const liveDir = path.join(MEDIA_ROOT, 'live');
  if (!fs.existsSync(liveDir)) return { deleted: 0, errors: 0 };

  let deleted = 0;
  let errors = 0;
  try {
    const entries = fs.readdirSync(liveDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const streamDir = path.join(liveDir, entry.name);
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
    console.log(`   -> HLS Egress (Web):     http://localhost:8000/live/<streamKey>/index.m3u8`);
    console.log(`   -> DVR window:            ${DVR_WINDOW_SECONDS / 3600}h (${DVR_WINDOW_SECONDS} segment × 1s)`);
    console.log(`   -> Media root:           ${MEDIA_ROOT}`);
  } catch (err) {
    console.error(`[MediaServer] Lỗi khởi tạo:`, err);
  }
}
