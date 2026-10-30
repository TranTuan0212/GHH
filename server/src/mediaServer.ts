import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { db } from './db';

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

const MEDIA_ROOT = path.join(__dirname, '../media');

const DVR_WINDOW_SECONDS = parseInt(process.env.DVR_WINDOW_SECONDS || '', 10) || 6 * 60 * 60;
const SESSION_TIMEOUT_SECONDS = parseInt(process.env.SESSION_TIMEOUT_SECONDS || '', 10) || 30 * 60;
const CRON_MAX_AGE_SECONDS = parseInt(process.env.CRON_MAX_AGE_SECONDS || '', 10) || 24 * 60 * 60;
const HLS_SEGMENT_SECONDS = 1.0;

interface HlsSession {
  streamKey: string;
  startTime: number;
  lastSeen: number;
  ffmpegProcesses: ChildProcess[];
}

export const hlsSessions: Map<string, HlsSession> = new Map();

let streamEndedHandler: ((streamKey: string) => void) | undefined;
let streamStartedHandler: ((stream: any) => void) | undefined;

export function setStreamEndedHandler(handler: (streamKey: string) => void): void {
  streamEndedHandler = handler;
}

export function setStreamStartedHandler(handler: (stream: any) => void): void {
  streamStartedHandler = handler;
}

// Map streamKey -> pending disconnect timer (Grace Period 20s cho mạng 4G/5G)
const pendingDisconnects: Map<string, NodeJS.Timeout> = new Map();
const GRACE_PERIOD_MS = 20_000;

function getStreamDir(rendition: 'live' | 'replay', streamKey: string): string {
  return path.join(MEDIA_ROOT, rendition, streamKey);
}

export function cleanupStreamSession(streamKey: string): void {
  if (pendingDisconnects.has(streamKey)) {
    clearTimeout(pendingDisconnects.get(streamKey)!);
    pendingDisconnects.delete(streamKey);
  }
  const session = hlsSessions.get(streamKey);
  if (session) {
    for (const process of session.ffmpegProcesses) {
      if (!process.killed) {
        try { process.kill('SIGTERM'); } catch {}
      }
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
        try { fs.rmdirSync(dir); } catch {}
      }
    } catch (err) {
      console.error(`[MediaServer] Cleanup error for ${streamKey}/${rendition}:`, err);
    }
  }
  console.log(`[MediaServer] Cleanup session ${streamKey}: deleted ${deleted} files`);
}

/**
 * Dừng FFmpeg Replay, giữ lại file .ts/.m3u8 để người xem tua lại.
 */
export function stopFfmpegOnly(streamKey: string): void {
  if (pendingDisconnects.has(streamKey)) {
    clearTimeout(pendingDisconnects.get(streamKey)!);
    pendingDisconnects.delete(streamKey);
  }
  const session = hlsSessions.get(streamKey);
  if (session) {
    for (const process of session.ffmpegProcesses) {
      if (!process.killed) {
        try { process.kill('SIGTERM'); } catch {}
      }
    }
    hlsSessions.delete(streamKey);
    console.log(`[MediaServer] FFmpeg stopped for ${streamKey} (files preserved for replay)`);
  }
}

/**
 * Làm mới toàn bộ bộ đệm Replay cho streamKey khi bấm "Xong Phiên"
 */
export function resetReplaySession(streamKey: string): boolean {
  const session = hlsSessions.get(streamKey);

  // 1. Dừng ngay tiến trình ffmpeg replay cũ nếu stream đang chạy
  if (session) {
    const oldReplayFfmpeg = session.ffmpegProcesses[0];
    if (oldReplayFfmpeg && !oldReplayFfmpeg.killed) {
      try { oldReplayFfmpeg.kill('SIGKILL'); } catch {}
    }
  }

  // 2. Xóa sạch file .ts, .m3u8 của phiên trước
  const outputDir = getStreamDir('replay', streamKey);
  try {
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      for (const file of files) {
        try { fs.unlinkSync(path.join(outputDir, file)); } catch {}
      }
      if (!session) {
        try { fs.rmdirSync(outputDir); } catch {}
      }
    }
  } catch (err) {
    console.error(`[MediaServer] Lỗi dọn dẹp file replay cũ cho ${streamKey}:`, err);
  }

  if (!session) {
    console.log(`[MediaServer] Đã xóa sạch toàn bộ video replay cũ của stream ${streamKey} (phiên stream đã dừng)`);
    return true;
  }

  // 3. Khởi động lại ffmpeg replay mới từ MediaMTX RTSP
  const bundledFfmpeg = path.join(__dirname, '../tools/ffmpeg/ffmpeg.exe');
  const ffmpegPath = process.env.FFMPEG_PATH || (fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg');
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
    '-hls_segment_filename', path.join(outputDir, '%05d.ts'),
    '-hls_flags', 'delete_segments+program_date_time',
    path.join(outputDir, 'index.m3u8')
  ];

  const newReplayFfmpeg = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  newReplayFfmpeg.stderr.on('data', () => {
    const s = hlsSessions.get(streamKey);
    if (s) s.lastSeen = Date.now() / 1000;
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
export function startHlsSession(streamKey: string): void {
  const outputDir = getStreamDir('replay', streamKey);

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    console.error(`[MediaServer] Cannot create output dir ${outputDir}:`, err);
    return;
  }

  const bundledFfmpeg = path.join(__dirname, '../tools/ffmpeg/ffmpeg.exe');
  const ffmpegPath = process.env.FFMPEG_PATH || (fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg');
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
    '-hls_segment_filename', path.join(outputDir, '%05d.ts'),
    '-hls_flags', 'append_list+delete_segments+program_date_time',
    path.join(outputDir, 'index.m3u8')
  ];

  console.log(`[MediaServer] 🎬 Khởi động FFmpeg DVR Replay từ MediaMTX RTSP cho ${streamKey}:`);
  console.log(`   Source: rtsp://127.0.0.1:8554/live/${streamKey}`);
  console.log(`   Output: ${outputDir}/index.m3u8 (Segment ${HLS_SEGMENT_SECONDS}s, DVR ${DVR_WINDOW_SECONDS / 3600}h)`);

  const replayProc = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  replayProc.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[MediaServer] [ffmpeg ${streamKey}] STDOUT: ${line}`);
  });

  replayProc.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (!line) return;
    const isImportant = /error|fatal|cannot|failed|hls|segment/i.test(line);
    if (isImportant) console.log(`[MediaServer] [ffmpeg ${streamKey}] ${line}`);
    const s = hlsSessions.get(streamKey);
    if (s) s.lastSeen = Date.now() / 1000;
  });

  replayProc.on('error', (err: Error) => {
    console.error(`[MediaServer] ffmpeg error for ${streamKey}:`, err);
  });

  replayProc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    console.log(`[MediaServer] replay FFmpeg exited for ${streamKey} with code=${code} signal=${signal}`);
  });

  const session: HlsSession = {
    streamKey,
    startTime: Date.now() / 1000,
    lastSeen: Date.now() / 1000,
    ffmpegProcesses: [replayProc]
  };
  hlsSessions.set(streamKey, session);
}

/**
 * MediaMTX Path Watcher:
 * Tự động kiểm tra trạng thái luồng trên MediaMTX API v3 mỗi 1000ms.
 * Bắt dính ngay khi iPhone phát hoặc dừng, quản lý ân hạn 20s.
 */
let watcherInterval: NodeJS.Timeout | null = null;

function startMediaMtxWatcher(): void {
  if (watcherInterval) clearInterval(watcherInterval);

  watcherInterval = setInterval(async () => {
    try {
      const res = await fetch('http://127.0.0.1:9997/v3/paths/list');
      if (!res.ok) return;
      const data: any = await res.json();
      const items = data.items || [];
      const activeStreamKeys = new Set<string>();

      for (const item of items) {
        if (!item.ready) continue;
        const streamKey = item.name.split('/').pop() || item.name;
        activeStreamKeys.add(streamKey);

        // Hủy timer ân hạn ngắt kết nối nếu có
        if (pendingDisconnects.has(streamKey)) {
          clearTimeout(pendingDisconnects.get(streamKey)!);
          pendingDisconnects.delete(streamKey);
          console.log(`[MediaServer] ✅ iPhone kết nối lại thành công qua MediaMTX cho stream ${streamKey}!`);
        }

        // Tự động kích hoạt trạng thái LIVE trong DB
        let activeStream = db.getStreams().find(s => s.streamKey === streamKey && s.status === 'LIVE');
        let newlyActivated = false;
        if (!activeStream) {
          const anyStream = db.getStreams().find(s => s.streamKey === streamKey);
          if (anyStream) {
            anyStream.status = 'LIVE';
            anyStream.endedAt = undefined;
            activeStream = anyStream;
            newlyActivated = true;
            console.log(`[MediaServer] 🔄 MediaMTX tái kích hoạt phiên LIVE cho streamKey: ${streamKey}`);
          } else if (streamKey.startsWith('live_usr-')) {
            const match = streamKey.match(/^live_(usr-[^_]+)/);
            const userId = match ? match[1] : 'usr-default';
            const user = db.getUsers().find(u => u.id === userId);
            const newStream: any = {
              id: `stream-${Date.now()}`,
              userId,
              username: user ? user.username : 'iPhone User',
              streamKey,
              status: 'LIVE',
              hlsPlaylistUrl: `/live/${streamKey}/index.m3u8`,
              vodUrl: '',
              startedAt: new Date().toISOString()
            };
            db.getStreams().unshift(newStream);
            activeStream = newStream;
            newlyActivated = true;
            console.log(`[MediaServer] ⚡ Tự động cấp phép phiên LIVE mới qua MediaMTX: ${streamKey}`);
          }
        }

        // Khởi động FFmpeg Replay DVR nếu chưa chạy
        const existingSession = hlsSessions.get(streamKey);
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
      for (const [streamKey] of hlsSessions) {
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
    } catch {}
  }, 1000);
}

/** Background cleanup */
function startCleanupScheduler(): void {
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

export function timeoutCheckOnce(): string[] {
  const now = Date.now() / 1000;
  const cleaned: string[] = [];

  for (const [streamKey, session] of hlsSessions) {
    if (now - session.lastSeen > SESSION_TIMEOUT_SECONDS) {
      console.warn(`[MediaServer] Orphaned stream ${streamKey} timeout — dừng ffmpeg`);
      stopFfmpegOnly(streamKey);
      cleaned.push(streamKey);
    }
  }
  return cleaned;
}

export interface CleanupReport {
  deletedFiles: number;
  deletedDirs: number;
  cleanedSessions: number;
  cleanedCards: number;
  errors: number;
}

export function runCronCleanupOnce(): CleanupReport {
  const now = Date.now() / 1000;
  let deletedFiles = 0;
  let deletedDirs = 0;
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
          let remainingTsCount = 0;

          for (const file of files) {
            const filePath = path.join(streamDir, file);
            try {
              const stats = fs.statSync(filePath);
              const ageSeconds = now - stats.mtime.getTime() / 1000;
              if (ageSeconds >= CRON_MAX_AGE_SECONDS) {
                fs.unlinkSync(filePath);
                deletedFiles++;
              } else if (file.endsWith('.ts')) {
                remainingTsCount++;
              }
            } catch {
              errors++;
            }
          }

          if (remainingTsCount === 0 && !hlsSessions.has(entry.name)) {
            try {
              const leftFiles = fs.readdirSync(streamDir);
              for (const f of leftFiles) {
                fs.unlinkSync(path.join(streamDir, f));
                deletedFiles++;
              }
              fs.rmdirSync(streamDir);
              deletedDirs++;
            } catch {
              errors++;
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

  // Tự động dọn dẹp các session và bài cũ trong database quá 24h
  let cleanedSessions = 0;
  let cleanedCards = 0;
  try {
    const dbCleanup = db.cleanupOldData(CRON_MAX_AGE_SECONDS);
    cleanedSessions = dbCleanup.cleanedSessions;
    cleanedCards = dbCleanup.cleanedCards;
  } catch (err) {
    console.error('[MediaServer] Lỗi dọn dẹp Database cron:', err);
    errors++;
  }

  return { deletedFiles, deletedDirs, cleanedSessions, cleanedCards, errors };
}

/** Lấy thông tin thống kê trạng thái dọn dẹp tự động 24h */
export function getCleanupStatus(): any {
  return getMediaStorageStats();
}

export function getMediaStorageStats(): any {
  const now = Date.now() / 1000;
  let totalMediaFiles = 0;
  let totalMediaSizeBytes = 0;
  const streams: any[] = [];

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
          let oldestMs = Infinity;
          let newestMs = 0;

          for (const file of files) {
            const filePath = path.join(streamDir, file);
            try {
              const st = fs.statSync(filePath);
              totalMediaFiles++;
              totalMediaSizeBytes += st.size;
              const mt = st.mtime.getTime();
              if (mt < oldestMs) oldestMs = mt;
              if (mt > newestMs) newestMs = mt;
            } catch {}
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
        } catch {}
      }
    } catch {}
  }

  return {
    cronMaxAgeSeconds: CRON_MAX_AGE_SECONDS,
    cronMaxAgeHours: Math.round(CRON_MAX_AGE_SECONDS / 3600),
    cronIntervalMinutes: 60,
    totalMediaFiles,
    totalMediaSizeBytes,
    streams,
    dbStats: {
      cardEntriesCount: db.getCardEntries().length,
      streamSessionsCount: db.getStreams().length
    }
  };
}

export function startNativeMediaServer(): void {
  startCleanupScheduler();
  startMediaMtxWatcher();

  console.log(`MediaMTX High-Performance Native Server active:`);
  console.log(`   -> RTMP Ingest (iPhone):  rtmp://<ip>:1935/live/<streamKey>`);
  console.log(`   -> WebRTC Live (WHEP):    http://<ip>:8889/live/<streamKey>/whep`);
  console.log(`   -> RTSP Source (AI):      rtsp://127.0.0.1:8554/live/<streamKey>`);
  console.log(`   -> Replay DVR (HLS):      http://<ip>:4000/replay/<streamKey>/index.m3u8`);
}
