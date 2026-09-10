import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Hls from 'hls.js';
import { Socket } from 'socket.io-client';
import {
  Play,
  Pause,
  RotateCcw,
  Gauge,
  Volume2,
  VolumeX,
  Radio,
  ChevronRight,
  ChevronLeft,
  Camera,
  CheckCircle2,
  Copy,
  Check,
  RotateCw,
  Type,
  Plus,
  Trash2,
  X
} from 'lucide-react';
import { StreamSession } from '../types';

export interface TextOverlay {
  id: string;
  text: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
  bgColor?: string;
}

/**
 * LivePlayer chạy hoàn toàn bằng HLS playlist do server (NMS + FFmpeg) sinh ra.
 *
 * Nguyên tắc "đơn vị lưu trữ là segment video đã nén":
 * - KHÔNG còn ring buffer ImageBitmap trong RAM.
 * - KHÔNG còn WebSocket nhận JPEG rời từng frame.
 * - Toàn bộ video (cả live edge lẫn DVR window) đều nằm trong .ts + .m3u8 do server slice.
 * - Tua lại / slow-motion: chỉ cần gọi `video.currentTime = T` hoặc `video.playbackRate = r`,
 *   hls.js tự tìm segment chứa T, fetch .ts, decode bằng MSE, render lên <video>.
 * - Server không tốn CPU dựng lại từ frame rời, không có database ảnh.
 *
 * Phím Enter vẫn bật/tắt chế độ Live <-> Slow-Mo như cũ, nhưng logic đơn giản hơn nhiều vì
 * chỉ thao tác trên <video> thay vì tự dựng vòng lặp phát.
 */
export interface MarkedFrame {
  time: number; // giây trong timeline HLS
  timeStr: string;
}

function resolveServerUrl(serverUrlFromServer?: string): string {
  if (typeof window === 'undefined') return 'http://localhost:4000';
  const host = window.location.hostname;
  const protocol = window.location.protocol;

  if (host.includes('trycloudflare.com') || host.includes('ngrok') || protocol === 'https:') {
    return `https://${host}`;
  }

  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return `http://${host}:4000`;
  }

  if (serverUrlFromServer && !serverUrlFromServer.includes('localhost') && !serverUrlFromServer.includes('127.0.0.1')) {
    return serverUrlFromServer;
  }

  return 'http://localhost:4000';
}

interface LivePlayerProps {
  stream: StreamSession | null;
  socket?: Socket | null;
  roomId?: string;
  roomName?: string;
  onFinishRound?: () => void;
}

export const LivePlayer: React.FC<LivePlayerProps> = ({
  stream,
  socket,
  roomId,
  roomName,
  onFinishRound,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const loadedStreamKeyRef = useRef<string | null>(null);

  const [hasFrame, setHasFrame] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isLive, setIsLive] = useState(true);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [rotation, setRotation] = useState<number>(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [hlsWindowStart, setHlsWindowStart] = useState<number>(0);
  const [hlsLiveEdge, setHlsLiveEdge] = useState<number>(0);

  // Text Overlays state (giữ nguyên UX cũ)
  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>(() => {
    try {
      const saved = localStorage.getItem('live_text_overlays_' + (roomId || 'default'));
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [isTextOverlayOpen, setIsTextOverlayOpen] = useState(false);
  const [newTextContent, setNewTextContent] = useState<string>('');
  const [newTextColor, setNewTextColor] = useState<string>('#fbbf24');
  const [newTextSize, setNewTextSize] = useState<number>(20);

  useEffect(() => {
    try {
      localStorage.setItem('live_text_overlays_' + (roomId || 'default'), JSON.stringify(textOverlays));
    } catch {}
  }, [textOverlays, roomId]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('live_text_overlays_' + (roomId || 'default'));
      setTextOverlays(saved ? JSON.parse(saved) : []);
    } catch {}
  }, [roomId]);

  const handleAddTextOverlay = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const textToAdd = newTextContent.trim();
    if (!textToAdd) return;

    const newId = 'txt-' + Date.now();
    const newOverlay: TextOverlay = {
      id: newId,
      text: textToAdd,
      x: 18 + (textOverlays.length * 6) % 50,
      y: 18 + (textOverlays.length * 8) % 50,
      color: newTextColor,
      fontSize: newTextSize,
      bgColor: 'rgba(0,0,0,0.65)'
    };
    setTextOverlays((prev) => [...prev, newOverlay]);
    setNewTextContent('');
  };

  const handleUpdateTextOverlay = (id: string, updates: Partial<TextOverlay>) => {
    setTextOverlays((prev) =>
      prev.map((o) => (o.id === id ? { ...o, ...updates } : o))
    );
  };

  const handleDeleteTextOverlay = (id: string) => {
    setTextOverlays((prev) => prev.filter((o) => o.id !== id));
  };

  const handleStartDrag = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const container = videoContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    const targetOverlay = textOverlays.find((o) => o.id === id);
    if (!targetOverlay) return;

    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startX = targetOverlay.x;
    const startY = targetOverlay.y;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = ((moveEvent.clientX - startMouseX) / rect.width) * 100;
      const deltaY = ((moveEvent.clientY - startMouseY) / rect.height) * 100;
      const newX = Math.max(0, Math.min(88, startX + deltaX));
      const newY = Math.max(0, Math.min(88, startY + deltaY));

      setTextOverlays((prev) =>
        prev.map((o) => (o.id === id ? { ...o, x: newX, y: newY } : o))
      );
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleStartTouchDrag = (e: React.TouchEvent, id: string) => {
    const container = videoContainerRef.current;
    if (!container || !e.touches[0]) return;
    const rect = container.getBoundingClientRect();
    const targetOverlay = textOverlays.find((o) => o.id === id);
    if (!targetOverlay) return;

    const startTouchX = e.touches[0].clientX;
    const startTouchY = e.touches[0].clientY;
    const startX = targetOverlay.x;
    const startY = targetOverlay.y;

    const onTouchMove = (moveEvent: TouchEvent) => {
      if (!moveEvent.touches[0]) return;
      const deltaX = ((moveEvent.touches[0].clientX - startTouchX) / rect.width) * 100;
      const deltaY = ((moveEvent.touches[0].clientY - startTouchY) / rect.height) * 100;
      const newX = Math.max(0, Math.min(88, startX + deltaX));
      const newY = Math.max(0, Math.min(88, startY + deltaY));

      setTextOverlays((prev) =>
        prev.map((o) => (o.id === id ? { ...o, x: newX, y: newY } : o))
      );
    };

    const onTouchEnd = () => {
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };

    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('touchend', onTouchEnd);
  };

  const [detectedServerUrl, setDetectedServerUrl] = useState<string>(() => resolveServerUrl());
  const [hlsBaseUrl, setHlsBaseUrl] = useState<string>('');
  const [replayHlsBaseUrl, setReplayHlsBaseUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/server-info')
      .then((res) => res.json())
      .then((data) => {
        console.log('[LivePlayer] /api/server-info trả về:', data);
        if (data && data.serverUrl) {
          setDetectedServerUrl(resolveServerUrl(data.serverUrl));
        }
        if (data && data.hlsBaseUrl) {
          setHlsBaseUrl(data.hlsBaseUrl);
        } else {
          console.warn('[LivePlayer] /api/server-info KHÔNG có hlsBaseUrl — video sẽ không thể load vì thiếu URL gốc HLS.');
        }
        if (data && data.replayHlsBaseUrl) setReplayHlsBaseUrl(data.replayHlsBaseUrl);
      })
      .catch((err) => {
        console.error('[LivePlayer] Gọi /api/server-info thất bại (server chưa chạy, sai URL, hoặc CORS):', err);
      });
  }, []);

  const handleCopyServerUrl = () => {
    navigator.clipboard.writeText(detectedServerUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  // Socket.IO chỉ còn dùng để nhận stream lifecycle + room metadata. Video đi qua HLS playlist.
  useEffect(() => {
    if (!socket) return;

    const handleInitialState = (data: any) => {
      if (data && data.roomId && roomId && data.roomId !== roomId) return;
      console.log('[LivePlayer] Socket initial_state:', data);
      if (data && data.serverUrl) {
        setDetectedServerUrl(resolveServerUrl(data.serverUrl));
      }
      if (data && data.hlsBaseUrl) {
        setHlsBaseUrl(data.hlsBaseUrl);
      }
      if (data && data.replayHlsBaseUrl) setReplayHlsBaseUrl(data.replayHlsBaseUrl);
    };

    const handleRoundFinished = () => {
      // Reload HLS để bỏ segment cũ, bắt đầu lại window từ đầu phiên mới.
      if (hlsRef.current && videoRef.current && stream?.streamKey) {
        hlsRef.current.startLoad();
        videoRef.current.currentTime = 0;
      }
    };

    socket.on('initial_state', handleInitialState);
    socket.on('round_finished', handleRoundFinished);

    return () => {
      socket.off('initial_state', handleInitialState);
      socket.off('round_finished', handleRoundFinished);
    };
  }, [socket, roomId, stream?.streamKey]);

  // Kết nối HLS: server slice .ts dài 1s, playlist .m3u8 giữ toàn bộ segment -> DVR window tự nhiên.
  useEffect(() => {
    const video = videoRef.current;
    const activeHlsBaseUrl = isLive
      ? hlsBaseUrl
      : (replayHlsBaseUrl || hlsBaseUrl.replace(/\/live$/, '/replay'));
    if (!video || !stream?.streamKey || !activeHlsBaseUrl) {
      console.log('[LivePlayer] Chưa đủ điều kiện load video:', {
        hasVideoEl: !!video,
        streamKey: stream?.streamKey || '(chưa có)',
        hlsBaseUrl: activeHlsBaseUrl || '(chưa có)'
      });
      return;
    }

    const playlistUrl = `${activeHlsBaseUrl}/${stream.streamKey}/index.m3u8`;
    console.log('[LivePlayer] === Bắt đầu load HLS ===');
    console.log('[LivePlayer] playlistUrl:', playlistUrl);

    // Chỉ reset khi stream key thay đổi. Chuyển từ live rendition sang replay master phải
    // giữ nguyên slow-motion rate, không được tự đưa người xem trở lại 1x.
    if (loadedStreamKeyRef.current !== stream.streamKey) {
      loadedStreamKeyRef.current = stream.streamKey;
      setIsLive(true);
      setPlaybackRate(1.0);
      setHasFrame(false);
      video.playbackRate = 1.0;
    } else {
      video.playbackRate = isLive ? 1.0 : playbackRate;
    }

    let cancelled = false;
    let hlsInstance: Hls | null = null;
    let videoEventCleanup: (() => void) | null = null;

    // QUAN TRỌNG: ngay sau khi RTMP bắt đầu publish, FFmpeg cần khoảng 1-3 giây để ghi xong
    // segment .ts + playlist .m3u8 ĐẦU TIÊN (hls_time=1). Nếu fetch playlist ngay lập tức sẽ
    // luôn ra 404 dù server hoàn toàn khỏe mạnh — đây chính là nguyên nhân video hay không lên
    // hình dù stream đã LIVE. Nhánh HLS native (Safari/Edge) đặc biệt dễ dính vì KHÔNG có cơ chế
    // tự retry như hls.js, nên phải tự chờ & thử lại thủ công trước khi gắn playlist cho player.
    const waitForPlaylistReady = async (): Promise<boolean> => {
      const maxAttempts = 12;
      const intervalMs = 1000;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (cancelled) return false;
        try {
          const res = await fetch(playlistUrl, { cache: 'no-store' });
          console.log(`[LivePlayer] Thử playlist .m3u8 (lần ${attempt}/${maxAttempts}) -> status ${res.status}`);
          if (res.ok) return true;
        } catch (err) {
          console.warn(`[LivePlayer] Thử playlist .m3u8 (lần ${attempt}/${maxAttempts}) lỗi network:`, err);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return false;
    };

    (async () => {
      const ready = await waitForPlaylistReady();
      if (cancelled) return;

      if (!ready) {
        console.error('[LivePlayer] Playlist .m3u8 KHÔNG sẵn sàng sau nhiều lần thử (~12s). Có thể: RTMP chưa publish thành công, hoặc stream đã dừng trước khi kịp tạo file. Kiểm tra log server phần [MediaServer].');
        return;
      }

      console.log('[LivePlayer] Playlist đã sẵn sàng, bắt đầu gắn vào trình phát.');

      // Trình duyệt đã hỗ trợ HLS natively (Safari, và một số bản Edge/Chromium mới) thì dùng
      // luôn src, không cần hls.js.
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        console.log('[LivePlayer] Dùng HLS native của trình duyệt, không qua hls.js.');
        video.playbackRate = isLive ? 1.0 : playbackRate;
        video.src = playlistUrl;
        return;
      }

      if (!Hls.isSupported()) {
        console.error('[LivePlayer] Trình duyệt không hỗ trợ MSE / HLS.js — không thể phát video trên trình duyệt này.');
        return;
      }

      const hls = new Hls({
        // DVR window: playlist liệt kê toàn bộ segment từ đầu phiên (hls_list_size=0 trong FFmpeg),
        // hls.js tự biết seek đến bất kỳ timestamp nào trong khoảng [oldest, live].
        // 120fps / ~8Mbps qua 5G+tunnel không thể chỉ đệm 2 segment: chỉ một nhịp
        // mạng chậm là video rơi vào waiting/stalled. Bốn segment 1 giây vẫn là live
        // nhưng đủ headroom để phát liên tục.
        liveSyncDurationCount: 4,
        maxBufferLength: 12,
        enableWorker: true,
        lowLatencyMode: true,
        debug: false
      });
      hlsInstance = hls;
      hlsRef.current = hls;
      hls.loadSource(playlistUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MEDIA_ATTACHED, () => console.log('[LivePlayer][hls.js] MEDIA_ATTACHED — video element đã gắn vào hls.js'));
      hls.on(Hls.Events.MANIFEST_LOADING, () => console.log('[LivePlayer][hls.js] MANIFEST_LOADING — đang tải playlist...'));
      hls.on(Hls.Events.MANIFEST_LOADED, (_e, data) => console.log('[LivePlayer][hls.js] MANIFEST_LOADED — playlist tải xong, số level:', data.levels?.length));
      hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => console.log('[LivePlayer][hls.js] LEVEL_LOADED — số segment trong playlist:', data.details?.fragments?.length, '| live:', data.details?.live));
      hls.on(Hls.Events.FRAG_LOADING, (_e, data) => console.log('[LivePlayer][hls.js] FRAG_LOADING:', data.frag?.url));
      hls.on(Hls.Events.FRAG_LOADED, (_e, data) => console.log('[LivePlayer][hls.js] FRAG_LOADED OK:', data.frag?.url));
      // Lỗi tải segment .ts (fragLoadError) không có event riêng — nó báo qua Hls.Events.ERROR chung
      // bên dưới với data.details === 'fragLoadError', đã được log đầy đủ ở đó.

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        console.log('[LivePlayer][hls.js] MANIFEST_PARSED — sẵn sàng phát. Số level:', data.levels?.length);
        setHasFrame(true);
        video.playbackRate = isLive ? 1.0 : playbackRate;
        if (!isLive) {
          // Master has its own timeline. Start a few seconds behind its latest keyframe so
          // playback at 0.5x/0.25x has buffered original high-FPS frames immediately.
          window.setTimeout(() => {
            if (video.seekable.length > 0) {
              const end = video.seekable.end(video.seekable.length - 1);
              const start = video.seekable.start(video.seekable.length - 1);
              video.currentTime = Math.max(start, end - 3);
            }
          }, 0);
        }
        video.play()
          .then(() => console.log('[LivePlayer] video.play() thành công'))
          .catch((err) => console.error('[LivePlayer] video.play() bị trình duyệt chặn (autoplay policy?) hoặc lỗi khác:', err));
      });

      hls.on(Hls.Events.ERROR, (_e, data) => {
        // Log MỌI lỗi, kể cả không fatal — trước đây bị bỏ qua hoàn toàn, nên không biết tại sao
        // video giật/không lên hình dù cuối cùng không "chết hẳn".
        console.error('[LivePlayer][hls.js] ERROR:', {
          type: data.type,
          details: data.details,
          fatal: data.fatal,
          url: (data as any).url,
          response: (data as any).response,
          reason: (data as any).reason
        });
        if (data.fatal) {
          console.error('[LivePlayer][hls.js] Đây là lỗi FATAL — hls.js sẽ tự hồi phục hoặc dừng hẳn tuỳ loại lỗi.');
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.warn('[LivePlayer][hls.js] NETWORK_ERROR fatal -> gọi hls.startLoad() để thử tải lại playlist.');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.warn('[LivePlayer][hls.js] MEDIA_ERROR fatal -> gọi hls.recoverMediaError() (thường do lỗi decode/codec).');
              hls.recoverMediaError();
              break;
            default:
              console.error('[LivePlayer][hls.js] Lỗi fatal không tự hồi phục được -> destroy hls instance. Video sẽ đứng hình vĩnh viễn từ đây, cần load lại trang.');
              hls.destroy();
              break;
          }
        }
      });

      // Log toàn bộ sự kiện native của thẻ <video> để biết chính xác trạng thái decode/buffer thật sự,
      // vì đôi khi hls.js không báo lỗi gì nhưng <video> vẫn không render được frame nào.
      const videoEvents = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'waiting', 'stalled', 'suspend', 'abort', 'emptied', 'error'];
      const onVideoEvent = (ev: Event) => {
        if (ev.type === 'error') {
          console.error('[LivePlayer][<video>] error — MediaError code:', video.error?.code, 'message:', video.error?.message);
        } else {
          console.log(`[LivePlayer][<video>] ${ev.type}`, {
            readyState: video.readyState,
            networkState: video.networkState,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            currentTime: video.currentTime
          });
        }
      };
      videoEvents.forEach((evt) => video.addEventListener(evt, onVideoEvent));
      videoEventCleanup = () => videoEvents.forEach((evt) => video.removeEventListener(evt, onVideoEvent));
    })();

    return () => {
      console.log('[LivePlayer] Cleanup HLS instance cho streamKey:', stream.streamKey);
      cancelled = true;
      if (videoEventCleanup) videoEventCleanup();
      if (hlsInstance) hlsInstance.destroy();
      hlsRef.current = null;
    };
  }, [stream?.streamKey, hlsBaseUrl, replayHlsBaseUrl, isLive]);

  // Đồng bộ <video> currentTime + duration lên UI để vẽ seekbar DVR window.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      setCurrentTime(video.currentTime);
      if (Number.isFinite(video.duration)) {
        setDuration(video.duration);
      }
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onLoaded = () => {
      if (Number.isFinite(video.duration)) setDuration(video.duration);
      setHasFrame(true);
    };
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('durationchange', onLoaded);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('durationchange', onLoaded);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, []);

  // HLS live có duration = Infinity. Dải tua thật nằm trong TimeRanges `seekable`,
  // không phải video.duration. Dùng range này để DVR slider hoạt động được.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const updateSeekableWindow = () => {
      const ranges = video.seekable;
      if (ranges.length === 0) return;
      const start = ranges.start(ranges.length - 1);
      const end = ranges.end(ranges.length - 1);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        setHlsWindowStart(start);
        setHlsLiveEdge(end);
      }
    };
    video.addEventListener('progress', updateSeekableWindow);
    video.addEventListener('durationchange', updateSeekableWindow);
    video.addEventListener('canplay', updateSeekableWindow);
    const interval = window.setInterval(updateSeekableWindow, 500);
    return () => {
      video.removeEventListener('progress', updateSeekableWindow);
      video.removeEventListener('durationchange', updateSeekableWindow);
      video.removeEventListener('canplay', updateSeekableWindow);
      window.clearInterval(interval);
    };
  }, []);

  // Phát hiện user tua tới đầu cửa sổ live -> auto catch-up về live edge.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onSeeked = () => {
      if (!isLive) return;
      const lag = hlsLiveEdge - video.currentTime;
      // Nếu còn < 2s lệch live -> tự nhảy về edge để tránh bị stuck ở đầu playlist.
      if (lag >= 0 && lag < 2) {
        video.currentTime = hlsLiveEdge;
      }
    };
    video.addEventListener('seeked', onSeeked);
    return () => video.removeEventListener('seeked', onSeeked);
  }, [isLive, hlsLiveEdge]);

  // Enter toggle Live <-> Slow-Mo. Slow-mo chỉ cần đặt playbackRate; tua lại đặt currentTime.
  const [markedFrame, setMarkedFrame] = useState<MarkedFrame | null>(null);
  const markedFrameRef = useRef<MarkedFrame | null>(null);

  const [modeNotice, setModeNotice] = useState<'slow' | 'live' | null>(null);
  const [modeNoticeTitle, setModeNoticeTitle] = useState<string>('');
  const [modeNoticeSub, setModeNoticeSub] = useState<string>('');
  const [modeNoticeHint, setModeNoticeHint] = useState<string>('');
  const [modeNoticeKey, setModeNoticeKey] = useState(0);
  const modeNoticeTimerRef = useRef<number | null>(null);

  function showModeNotice(mode: 'slow' | 'live', title: string, sub = '', hint = '') {
    setModeNoticeKey((k) => k + 1);
    setModeNotice(mode);
    setModeNoticeTitle(title);
    setModeNoticeSub(sub);
    setModeNoticeHint(hint);

    if (modeNoticeTimerRef.current !== null) {
      window.clearTimeout(modeNoticeTimerRef.current);
    }
    modeNoticeTimerRef.current = window.setTimeout(() => {
      setModeNotice(null);
      modeNoticeTimerRef.current = null;
    }, 2600);
  }

  useEffect(() => {
    return () => {
      if (modeNoticeTimerRef.current !== null) {
        window.clearTimeout(modeNoticeTimerRef.current);
      }
    };
  }, []);

  const jumpToLive = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(hlsLiveEdge) || hlsLiveEdge <= 0) return;
    setIsLive(true);
    setIsPlaying(true);
    setPlaybackRate(1.0);
    video.playbackRate = 1.0;
    video.currentTime = Math.max(hlsWindowStart, hlsLiveEdge - 0.05);
    video.play().catch(() => {});
    showModeNotice(
      'live',
      'LIVE - TRỰC TIẾP',
      'Đã chuyển về luồng video thời gian thực',
      'Bấm [Enter] để gắn mốc & tua chậm'
    );
  };

  const handleSpeedChange = (speed: number) => {
    const video = videoRef.current;
    if (!video) return;
    setPlaybackRate(speed);
    showModeNotice(speed < 1 ? 'slow' : 'live', speed < 1 ? `SLOW ${speed}x` : 'LIVE - TRỰC TIẾP');
    video.playbackRate = speed;

    if (speed < 1.0) {
      // Rời Live -> tua về ~3 giây trước live edge để có chỗ "chạy chậm" qua
      if (isLive && Number.isFinite(hlsLiveEdge) && hlsLiveEdge > 0) {
        setIsLive(false);
        video.currentTime = Math.max(hlsWindowStart, hlsLiveEdge - 3);
        video.play().catch(() => {});
      }
    } else {
      // Trở về 1.0x: nếu đang Slow, đẩy về live edge để xem tiếp bình thường
      if (!isLive) jumpToLive();
    }
  };

  // Tua từng frame (~1/240s cho 240fps nguồn, browser sẽ snap tới keyframe gần nhất nếu segment)
  const stepFrame = (step: number) => {
    const video = videoRef.current;
    if (!video) return;
    setIsLive(false);
    setIsPlaying(false);
    // Bước nhảy 1/240s để xấp xỉ 1 frame nguồn; thực tế sẽ snap về keyframe gần nhất.
    video.pause();
    video.currentTime = Math.max(hlsWindowStart, Math.min(hlsLiveEdge, video.currentTime + step * (1 / 240)));
  };

  // Seek bar (DVR window): nhảy thẳng vào timestamp bất kỳ trong playlist.
  const handleSeekSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const t = parseFloat(e.target.value);
    if (!Number.isFinite(t)) return;
    setIsLive(false);
    video.currentTime = t;
  };

  const jumpToMarker = () => {
    const video = videoRef.current;
    const marker = markedFrameRef.current;
    if (!video || !marker) return;
    setIsLive(false);
    video.currentTime = marker.time;
    video.play().catch(() => {});
    showModeNotice(
      'slow',
      'VỀ MỐC KHUNG HÌNH',
      `Đang xem tại ${marker.timeStr}`,
      'Bấm [Enter] để quay về LIVE'
    );
  };

  // Toggle play/pause trên <video> native
  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  // Enter: chuyển chế độ Live <-> Slow-Mo. Khi rời Live, đặt marker tại vị trí hiện tại.
  const handleEnterModeSwitch = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
    if (isTextOverlayOpen) return;

    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as any).isContentEditable)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const video = videoRef.current;
    if (!video) return;

    if (isLive) {
      // Đang Live -> gắn mốc tại vị trí hiện tại, chuyển sang Slow 0.25x
      const markerTime = video.currentTime;
      const d = new Date();
      const timeStr = d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
      const marker: MarkedFrame = { time: markerTime, timeStr };
      markedFrameRef.current = marker;
      setMarkedFrame(marker);

      setIsLive(false);
      setIsPlaying(true);
      setPlaybackRate(0.25);
      video.playbackRate = 0.25;
      // Tua về 2 giây trước marker để có khoảng chạy chậm
      video.currentTime = Math.max(hlsWindowStart, markerTime - 2);
      video.play().catch(() => {});

      showModeNotice(
        'slow',
        'SLOW MOTION - ĐANG TUA CHẬM',
        `Mốc #${markerTime.toFixed(2)}s (${timeStr}) - Tốc độ: 0.25x`,
        'Bấm [Enter] lần nữa để quay về LIVE'
      );
    } else {
      jumpToLive();
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => handleEnterModeSwitch(e);
    const onKeyUp = (e: KeyboardEvent) => {
      if (isTextOverlayOpen) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as any).isContentEditable)) {
        return;
      }
      if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [isTextOverlayOpen, isLive]);

  const speedOptions = [0.05, 0.1, 0.125, 0.25, 0.5, 0.75, 1.0];

  return (
    <div className="glass-panel rounded-2xl overflow-hidden shadow-2xl border border-indigo-500/20 flex flex-col">
      {/* Header Info Bar */}
      <div className="px-3 py-1.5 sm:px-4 sm:py-2 bg-slate-900/80 border-b border-white/5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-1 sm:gap-0">
        <div className="flex items-center space-x-2 sm:space-x-3 w-full sm:w-auto justify-between sm:justify-start">
          <div className={`flex items-center space-x-1.5 px-2 py-0.5 rounded-full text-[10px] sm:text-[11px] font-semibold flex-shrink-0 border ${
            isLive
              ? 'bg-red-500/10 border-red-500/30 text-red-400 animate-pulse'
              : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
          }`}>
            {isLive ? <Radio className="w-3 h-3 animate-spin" /> : <Gauge className="w-3 h-3" />}
            <span>{isLive ? 'LIVE - HLS' : `SLOW - ${playbackRate}x`}</span>
          </div>
          <span className="text-xs font-medium text-slate-300 truncate max-w-[180px] sm:max-w-none">
            {roomName ? `Room: ${roomName}` : (stream ? `Streamer: ${stream.username}` : 'Đang chờ luồng Live...')}
          </span>
        </div>

        <div className="flex items-center space-x-1.5 sm:space-x-2 self-end sm:self-auto">
          <span className="px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-300 text-[10px] font-mono font-medium border border-amber-500/30 flex items-center gap-1" title="Playlist HLS (.m3u8) do server slice; segment .ts chứa toàn bộ frame 120/240fps gốc.">
            HLS DVR
          </span>
          <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-mono font-medium border border-emerald-500/30">
            Sync
          </span>
        </div>
      </div>

      {/* Video Container */}
      <div
        ref={videoContainerRef}
        className="relative aspect-video w-full bg-black flex items-center justify-center group overflow-hidden max-h-[58vh]"
      >
        {textOverlays.map((item) => (
          <div
            key={item.id}
            style={{
              position: 'absolute',
              left: `${item.x}%`,
              top: `${item.y}%`,
              color: item.color,
              fontSize: `${item.fontSize}px`,
              backgroundColor: item.bgColor || 'rgba(0,0,0,0.65)',
              userSelect: 'none',
              cursor: 'move',
              zIndex: 35
            }}
            onMouseDown={(e) => handleStartDrag(e, item.id)}
            onTouchStart={(e) => handleStartTouchDrag(e, item.id)}
            className="px-2.5 py-1 rounded-lg font-bold font-mono shadow-2xl border border-white/25 flex items-center space-x-1.5 backdrop-blur-sm group transition-shadow hover:ring-2 hover:ring-amber-400 active:cursor-grabbing"
            title="Kéo thả để di chuyển vị trí"
          >
            <span>{item.text}</span>
            {isTextOverlayOpen && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteTextOverlay(item.id);
                }}
                className="w-4 h-4 rounded-full bg-red-600 hover:bg-red-500 text-white flex items-center justify-center text-[10px] ml-1"
                title="Xóa chữ này"
              >
                ✕
              </button>
            )}
          </div>
        ))}

        {/* QUAN TRỌNG: thẻ <video> phải LUÔN mount trong DOM, không được conditional-render theo
            hasFrame — vì effect khởi tạo HLS cần videoRef.current tồn tại TRƯỚC khi có frame đầu
            tiên. Nếu ẩn video đằng sau `hasFrame ? ... : ...` sẽ tạo deadlock: video chỉ mount khi
            hasFrame=true, nhưng hasFrame chỉ được set true SAU khi HLS đã load được vào video đó. */}
        <video
          ref={videoRef}
          className="w-full h-full object-contain bg-black"
          style={{
            transform: `rotate(${rotation}deg)`,
            transition: 'transform 0.2s ease-in-out',
            display: hasFrame ? 'block' : 'none'
          }}
          playsInline
          muted={isMuted}
          autoPlay
        />
        {!hasFrame && (
          <div className="flex flex-col items-center justify-center p-3 sm:p-6 text-center space-y-1.5 sm:space-y-2 text-slate-500">
            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-slate-900 border border-white/10 flex items-center justify-center text-indigo-400 animate-pulse">
              <Camera className="w-5 h-5 sm:w-6 sm:h-6" />
            </div>
            <p className="text-xs sm:text-sm font-medium text-slate-300">Đang chờ điện thoại phát trực tiếp...</p>
            <div className="flex flex-col items-center space-y-1 max-w-sm">
              <p className="text-[11px] text-slate-400">
                Mở app iOS trên iPhone, nhập Server IP:
              </p>
              <div className="inline-flex items-center space-x-1.5 bg-slate-950 px-2.5 py-1 rounded-xl border border-amber-500/40 shadow-inner">
                <code className="text-amber-300 font-mono text-xs font-bold select-all">
                  {detectedServerUrl}
                </code>
                <button
                  type="button"
                  onClick={handleCopyServerUrl}
                  className="p-0.5 px-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-white/10 text-[10px] font-semibold flex items-center space-x-1 transition-all active:scale-95"
                  title="Sao chép Server IP"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-slate-300" />}
                  <span>{copied ? 'Đã chép' : 'Chép'}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {modeNotice && typeof document !== 'undefined' && createPortal(
          <div
            key={modeNoticeKey}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 2147483647,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none'
            }}
            aria-live="assertive"
          >
            <div className={`min-w-[320px] sm:min-w-[500px] max-w-[90vw] text-center px-6 py-6 sm:px-10 sm:py-8 rounded-3xl font-mono border-4 shadow-2xl backdrop-blur-xl transition-all animate-scaleIn ${
              modeNotice === 'slow'
                ? 'bg-amber-500/95 text-slate-950 border-amber-100 shadow-amber-500/50'
                : 'bg-red-600/95 text-white border-red-100 shadow-red-500/50'
            }`}>
              <div className="font-black text-2xl sm:text-4xl tracking-wide">
                {modeNoticeTitle}
              </div>
              {modeNoticeSub && (
                <div className={`mt-2 text-sm sm:text-lg font-bold ${
                  modeNotice === 'slow' ? 'text-slate-900' : 'text-rose-100'
                }`}>
                  {modeNoticeSub}
                </div>
              )}
              {modeNoticeHint && (
                <div className={`mt-3 inline-block px-3.5 py-1 rounded-full text-xs sm:text-sm font-semibold border ${
                  modeNotice === 'slow'
                    ? 'bg-black/10 border-slate-950/20 text-slate-950'
                    : 'bg-white/15 border-white/30 text-white'
                }`}>
                  {modeNoticeHint}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}

        {/* Live / Delayed Overlay Badge */}
        <div className="absolute top-2 left-2 flex flex-wrap items-center gap-1.5 z-10">
          {isLive ? (
            <span className="px-2.5 py-1 rounded-full bg-red-600 text-white font-bold text-[10px] sm:text-[11px] uppercase tracking-wider flex items-center shadow-lg shadow-red-600/50">
              <span className="w-2 h-2 rounded-full bg-white animate-ping mr-1.5" />
              Trực Tiếp
            </span>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => jumpToLive()}
                className="px-2.5 py-1 rounded-full bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white font-bold text-[10px] sm:text-[11px] uppercase tracking-wider flex items-center shadow-lg shadow-red-600/40 transition-all active:scale-95 animate-pulse"
                title="Bấm để nhảy ngay về hình ảnh Trực Tiếp (Live)"
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                Về Live
              </button>

              <span className={`px-2.5 py-1 rounded-full font-bold font-mono text-[10px] sm:text-[11px] border flex items-center shadow-md backdrop-blur-md bg-amber-500/25 text-amber-300 border-amber-500/40`}>
                <Gauge className="w-3.5 h-3.5 mr-1 text-amber-400" />
                Slow {playbackRate}x {isPlaying ? '• Đang tua chậm' : '• Tạm dừng'}
              </span>

              {markedFrame && (
                <button
                  type="button"
                  onClick={jumpToMarker}
                  className="px-2.5 py-1 rounded-full bg-amber-500/25 hover:bg-amber-500/40 text-amber-300 font-bold font-mono text-[10px] sm:text-[11px] border border-amber-400/50 flex items-center shadow-md transition-all active:scale-95"
                  title={`Mốc: ${markedFrame.timeStr} - Bấm để nhảy về mốc này`}
                >
                  <span className="mr-1">📍</span>
                  <span>Mốc ({markedFrame.timeStr})</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Controls Bar */}
      <div className="p-2 sm:p-2.5 bg-slate-900/95 space-y-1.5 border-t border-white/5">
        <div className="flex items-center justify-between gap-2 pb-1">
          <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-[11px] sm:text-xs font-black font-mono ${
            isLive
              ? 'bg-red-600/20 text-red-300 border-red-500/40'
              : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
          }`}>
            <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-red-400 animate-pulse' : 'bg-amber-400'}`} />
            {isLive ? 'CHẾ ĐỘ: LIVE - TRỰC TIẾP' : `CHẾ ĐỘ: SLOW - ${playbackRate}x`}
          </div>
          {!isLive && (
            <button
              type="button"
              onClick={() => jumpToLive()}
              className="px-3 py-1 rounded-full bg-red-600 hover:bg-red-500 text-white text-[11px] font-bold transition-all active:scale-95"
            >
              VỀ LIVE
            </button>
          )}
        </div>

        {/* DVR Seekbar: trượt để seek tới bất kỳ timestamp trong playlist */}
        <div className="flex items-center space-x-2">
          <span className="text-[10px] sm:text-[11px] font-mono text-slate-400 min-w-[60px]">
            {currentTime.toFixed(1)}s
          </span>
          <div className="relative w-full flex items-center py-1">
            <input
              type="range"
              min={hlsWindowStart}
              max={hlsLiveEdge > 0 ? hlsLiveEdge : 1}
              step={0.05}
              value={Math.max(hlsWindowStart, Math.min(currentTime, hlsLiveEdge || 1))}
              onChange={handleSeekSlider}
              className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500 hover:accent-indigo-400"
            />
            {markedFrame && hlsLiveEdge > 0 && (
              <button
                type="button"
                onClick={jumpToMarker}
                style={{
                  left: `${Math.min(99, Math.max(1, ((markedFrame.time - hlsWindowStart) / Math.max(0.01, hlsLiveEdge - hlsWindowStart)) * 100))}%`
                }}
                className="absolute -top-1 -translate-x-1/2 w-3.5 h-3.5 bg-amber-400 hover:bg-amber-300 rounded-full border-2 border-slate-900 shadow-lg cursor-pointer transition-transform hover:scale-125 z-10"
                title={`Mốc tại ${markedFrame.time.toFixed(2)}s (${markedFrame.timeStr})`}
              />
            )}
          </div>
          <span className="text-[10px] sm:text-[11px] font-mono text-slate-400 min-w-[60px] text-right">
            {hlsLiveEdge.toFixed(1)}s
          </span>
        </div>

        {/* Action Controls */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-1.5 pt-0.5">
          <div className="flex items-center justify-between sm:justify-start space-x-1 sm:space-x-1.5">
            <button
              onClick={togglePlay}
              className="p-1.5 sm:p-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/30 transition-all flex-shrink-0"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <Play className="w-3.5 h-3.5 sm:w-4 sm:h-4 fill-current" />}
            </button>

            <button
              onClick={() => stepFrame(-1)}
              className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-white/10 text-xs font-medium flex items-center space-x-0.5 transition-all"
              title="Lùi 1 khung hình"
            >
              <ChevronLeft className="w-3 h-3" />
              <span>-1</span>
            </button>

            <button
              onClick={() => stepFrame(1)}
              className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-white/10 text-xs font-medium flex items-center space-x-0.5 transition-all"
              title="Tiến 1 khung hình"
            >
              <span>+1</span>
              <ChevronRight className="w-3 h-3" />
            </button>

            {markedFrame && (
              <button
                onClick={jumpToMarker}
                className="px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-bold flex items-center space-x-1 transition-all active:scale-95"
                title={`Nhảy về mốc tại ${markedFrame.timeStr}`}
              >
                <span>Về Mốc</span>
              </button>
            )}

            <button
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                setVolume(isMuted ? 1 : 0);
                v.muted = !isMuted;
                setIsMuted(!isMuted);
              }}
              className="p-1.5 sm:p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-white/10 transition-all flex-shrink-0"
              title={isMuted ? 'Bật âm thanh' : 'Tắt âm thanh'}
            >
              {isMuted ? <VolumeX className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <Volume2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
            </button>

            <button
              onClick={() => setRotation((r) => (r + 90) % 360)}
              className={`px-2 py-1 rounded-lg border text-xs font-medium flex items-center space-x-0.5 transition-all ${
                rotation !== 0
                  ? 'bg-indigo-600/30 text-indigo-300 border-indigo-500/50 shadow-sm'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-white/10'
              }`}
              title="Xoay video 90 độ"
            >
              <RotateCw className="w-3 h-3" />
              <span>{rotation !== 0 ? `${rotation}°` : 'Xoay'}</span>
            </button>

            <button
              onClick={() => setIsTextOverlayOpen(!isTextOverlayOpen)}
              className={`px-2 py-1 rounded-lg border text-xs font-medium flex items-center space-x-1 transition-all ${
                isTextOverlayOpen
                  ? 'bg-amber-500/30 text-amber-300 border-amber-500/50 shadow-sm'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-white/10'
              }`}
              title="Thêm / Sửa chữ chèn lên video và kéo thả tự do"
            >
              <Type className="w-3.5 h-3.5 text-amber-400" />
              <span>Chèn Chữ</span>
              {textOverlays.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-amber-500/30 text-[10px] text-amber-300 font-mono">
                  {textOverlays.length}
                </span>
              )}
            </button>

            {onFinishRound && (
              <button
                onClick={onFinishRound}
                className="px-2.5 py-1 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs shadow-md shadow-emerald-600/30 flex items-center space-x-1 transition-all active:scale-95 ml-auto sm:ml-1"
                title="Làm mới bộ nhớ và bắt đầu phiên mới"
              >
                <CheckCircle2 className="w-3 h-3 text-amber-300" />
                <span>Xong Phiên</span>
              </button>
            )}
          </div>

          {/* Slow Motion Speed Controls */}
          <div className="flex items-center space-x-0.5 bg-slate-950/60 p-1 rounded-xl border border-white/10 overflow-x-auto no-scrollbar max-w-full">
            <div
              className="flex items-center space-x-0.5 px-1 text-indigo-400 text-[10px] sm:text-[11px] font-semibold flex-shrink-0"
              title="Enter tự động tua chậm về mốc vừa gắn"
            >
              <Gauge className="w-3 h-3" />
              <span>Slow:</span>
            </div>
            {speedOptions.map((rate) => (
              <button
                key={rate}
                onClick={() => handleSpeedChange(rate)}
                className={`px-1.5 py-0.5 sm:px-2 sm:py-0.5 rounded-lg text-[10px] sm:text-[11px] font-bold font-mono transition-all flex-shrink-0 ${
                  playbackRate === rate
                    ? 'bg-indigo-600 text-white shadow shadow-indigo-600/40 border border-indigo-400'
                    : 'bg-slate-800/80 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                }`}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Modal Popup Chèn Chữ Lên Video */}
      {isTextOverlayOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 animate-fadeIn">
          <div className="bg-slate-900 border border-amber-500/40 rounded-2xl max-w-md w-full p-4 space-y-3.5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
              <div className="flex items-center space-x-2">
                <Type className="w-5 h-5 text-amber-400" />
                <div>
                  <h3 className="font-bold text-sm text-white">Chèn Chữ Lên Video</h3>
                  <p className="text-[11px] text-slate-400">Nhập chữ, chọn màu & kéo thả vị trí trên video</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsTextOverlayOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAddTextOverlay} className="space-y-2.5 bg-slate-950/80 p-3 rounded-xl border border-white/10">
              <div>
                <label className="text-xs font-bold text-slate-200 block mb-1">
                  Nội dung chữ muốn hiển thị:
                </label>
                <input
                  type="text"
                  value={newTextContent}
                  onChange={(e) => setNewTextContent(e.target.value)}
                  placeholder="Nhập chữ cần chèn (VD: BÀN 1, XÌ DÁCH, SLOW-MO...)"
                  autoFocus
                  className="w-full bg-slate-900 text-white font-mono text-sm px-3 py-2 rounded-xl border border-amber-500/40 focus:outline-none focus:border-amber-400"
                />
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <div className="flex items-center space-x-1.5">
                  <span className="text-[11px] text-slate-400 font-medium">Màu:</span>
                  {['#fbbf24', '#ef4444', '#22c55e', '#ffffff', '#38bdf8'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setNewTextColor(c)}
                      className={`w-6 h-6 rounded-full border transition-all ${
                        newTextColor === c ? 'ring-2 ring-white scale-110' : 'border-black/50 hover:scale-105'
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>

                <div className="flex items-center space-x-1 font-mono text-xs text-slate-300">
                  <span>Cỡ:</span>
                  <button
                    type="button"
                    onClick={() => setNewTextSize(Math.max(12, newTextSize - 2))}
                    className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 rounded"
                  >
                    -
                  </button>
                  <span className="font-bold text-amber-300">{newTextSize}</span>
                  <button
                    type="button"
                    onClick={() => setNewTextSize(Math.min(48, newTextSize + 2))}
                    className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 rounded"
                  >
                    +
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={!newTextContent.trim()}
                className="w-full py-2 rounded-xl bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400 text-slate-950 font-black text-xs flex items-center justify-center space-x-1.5 shadow-md shadow-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-95"
              >
                <Plus className="w-4 h-4 stroke-[3]" />
                <span>+ Thêm Chữ Này Lên Video</span>
              </button>
            </form>

            <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
              <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                Chữ đang hiển thị ({textOverlays.length}):
              </div>
              {textOverlays.length === 0 ? (
                <p className="text-xs text-slate-500 italic py-1">Chưa có chữ nào. Nhập chữ ở ô trên rồi bấm thêm.</p>
              ) : (
                textOverlays.map((item, idx) => (
                  <div key={item.id} className="flex items-center justify-between bg-slate-950 px-2.5 py-1.5 rounded-lg border border-white/10 text-xs">
                    <div className="flex items-center space-x-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: item.color }} />
                      <span className="font-mono font-bold text-white truncate max-w-[180px]">{item.text}</span>
                      <span className="text-[10px] text-slate-500 font-mono">({item.fontSize}px)</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteTextOverlay(item.id)}
                      className="text-red-400 hover:text-red-300 p-1"
                      title="Xóa chữ này"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="pt-2 border-t border-white/10 flex items-center justify-between text-xs">
              <span className="text-[11px] text-slate-400 italic">
                Giữ chuột hoặc chạm tay trên video để kéo thả chữ tự do
              </span>
              <button
                type="button"
                onClick={() => setIsTextOverlayOpen(false)}
                className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold"
              >
                Xong
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
