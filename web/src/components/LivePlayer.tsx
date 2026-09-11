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

interface FrozenTimeline {
  start: number;
  end: number;
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
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const replayVideoRef = useRef<HTMLVideoElement | null>(null);
  const videoRef = replayVideoRef; // Tương thích ngược với các hàm tiện ích
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const loadedStreamKeyRef = useRef<string | null>(null);
  const pendingReplayTimeRef = useRef<number | null>(null);
  const pendingReplayRatioRef = useRef<number | null>(null);
  const isDraggingSeekRef = useRef<boolean>(false);
  const isSeekingRef = useRef<boolean>(false);
  const pendingScrubTimeRef = useRef<number | null>(null);
  const scrubRafRef = useRef<number | null>(null);
  const seekingTimeoutRef = useRef<number | null>(null);
  const wasPlayingBeforeDragRef = useRef<boolean>(false);
  const isLiveRef = useRef<boolean>(true);

  const [hasFrame, setHasFrame] = useState(false);
  const [hasLiveFrame, setHasLiveFrame] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isLive, setIsLive] = useState(true);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(true);
  const [rotation, setRotation] = useState<number>(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [hlsWindowStart, setHlsWindowStart] = useState<number>(0);
  const [hlsLiveEdge, setHlsLiveEdge] = useState<number>(0);
  // Khi xem lại, cạnh phải của timeline là thời điểm người dùng rời Live. Không dùng
  // live edge đang tiếp tục tăng, nếu không nút tua sẽ "trôi" khỏi các frame cũ.
  const [frozenTimeline, setFrozenTimeline] = useState<FrozenTimeline | null>(null);
  const [sourceIsPortrait, setSourceIsPortrait] = useState(true);
  const [liveElapsedSeconds, setLiveElapsedSeconds] = useState<number>(0);

  // Bộ đếm thời gian thực khi đang phát Live (YouTube-style timeline)
  useEffect(() => {
    if (!stream?.startedAt) {
      setLiveElapsedSeconds(0);
      return;
    }
    const startedMs = new Date(stream.startedAt).getTime();
    const updateElapsed = () => {
      const now = Date.now();
      const elapsed = Math.max(0, (now - startedMs) / 1000);
      setLiveElapsedSeconds(elapsed);
    };
    updateElapsed();
    const timer = setInterval(updateElapsed, 500);
    return () => clearInterval(timer);
  }, [stream?.startedAt]);

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

  const whepUrl = stream?.streamKey
    ? (() => {
        const endpoint = new URL(detectedServerUrl);
        endpoint.port = '8889';
        endpoint.pathname = `/${stream.streamKey}/whep`;
        endpoint.search = '';
        return endpoint.toString();
      })()
    : '';

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

  // WebRTC Live player (WHEP). Kết nối trực tiếp để xem trực tiếp siêu tốc độ (<0.2s)
  useEffect(() => {
    const video = liveVideoRef.current;
    if (!video || !whepUrl) return;

    let cancelled = false;
    let peer: RTCPeerConnection | null = null;
    let sessionUrl: string | null = null;

    if (loadedStreamKeyRef.current !== stream?.streamKey) {
      loadedStreamKeyRef.current = stream?.streamKey || null;
      setPlaybackRate(1.0);
      setHasFrame(false);
      setHasLiveFrame(false);
      video.playbackRate = 1.0;
    }

    const waitForIceGathering = (connection: RTCPeerConnection) => new Promise<void>((resolve) => {
      if (connection.iceGatheringState === 'complete') return resolve();
      const timeout = window.setTimeout(resolve, 1500);
      connection.addEventListener('icegatheringstatechange', () => {
        if (connection.iceGatheringState === 'complete') {
          window.clearTimeout(timeout);
          resolve();
        }
      }, { once: true });
    });

    const waitForVideoTrack = (connection: RTCPeerConnection, alreadyReceived: () => boolean) => new Promise<void>((resolve, reject) => {
      if (alreadyReceived()) {
        resolve();
        return;
      }
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('WebRTC không nhận được video track trong 6 giây'));
      }, 6000);

      const cleanup = () => {
        window.clearTimeout(timeout);
        connection.removeEventListener('track', onTrack);
        connection.removeEventListener('connectionstatechange', onConnectionStateChange);
      };
      const onTrack = (event: RTCTrackEvent) => {
        if (event.track.kind !== 'video') return;
        cleanup();
        resolve();
      };
      const onConnectionStateChange = () => {
        if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
          cleanup();
          reject(new Error(`WebRTC connection ${connection.connectionState}`));
        }
      };

      connection.addEventListener('track', onTrack);
      connection.addEventListener('connectionstatechange', onConnectionStateChange);
    });

    const connect = async () => {
      for (let attempt = 1; !cancelled; attempt++) {
        try {
          peer = new RTCPeerConnection();
          peerConnectionRef.current = peer;
          let receivedVideoTrack = false;
          peer.addTransceiver('video', { direction: 'recvonly' });
          peer.ontrack = ({ streams }) => {
            if (cancelled || !streams[0]) return;
            receivedVideoTrack = true;
            video.srcObject = streams[0];
            video.muted = true;
            setHasLiveFrame(true);
            setHasFrame(true);
            video.play().catch((err) => {
              console.warn('[LivePlayer] Autoplay WebRTC ban đầu:', err);
            });
          };
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          await waitForIceGathering(peer);
          const response = await fetch(whepUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
            body: peer.localDescription?.sdp
          });
          if (!response.ok) throw new Error(`WHEP HTTP ${response.status}`);
          const location = response.headers.get('location');
          sessionUrl = location ? new URL(location, whepUrl).toString() : null;
          await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
          await waitForVideoTrack(peer, () => receivedVideoTrack);
          console.log('[LivePlayer] WebRTC live connected:', whepUrl);
          return;
        } catch (error) {
          if (sessionUrl) fetch(sessionUrl, { method: 'DELETE' }).catch(() => {});
          sessionUrl = null;
          peer?.close();
          peer = null;
          peerConnectionRef.current = null;
          console.log(`[LivePlayer] WHEP chưa sẵn sàng (lần ${attempt}, sẽ thử lại):`, error);
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
      }
    };

    const onLiveReady = () => {
      setHasLiveFrame(true);
      setHasFrame(true);
    };
    const onLiveVideoResize = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        const isPortrait = video.videoHeight > video.videoWidth;
        setSourceIsPortrait(isPortrait);
        console.log(`[LivePlayer] WebRTC video dimensions: ${video.videoWidth}x${video.videoHeight} (isPortrait: ${isPortrait})`);
      }
    };
    video.addEventListener('loadeddata', onLiveReady);
    video.addEventListener('canplay', onLiveReady);
    video.addEventListener('playing', onLiveReady);
    video.addEventListener('loadedmetadata', onLiveVideoResize);
    video.addEventListener('resize', onLiveVideoResize);

    connect();
    return () => {
      cancelled = true;
      video.removeEventListener('loadeddata', onLiveReady);
      video.removeEventListener('canplay', onLiveReady);
      video.removeEventListener('playing', onLiveReady);
      video.removeEventListener('loadedmetadata', onLiveVideoResize);
      video.removeEventListener('resize', onLiveVideoResize);
      peer?.close();
      peerConnectionRef.current = null;
      video.srcObject = null;
      if (sessionUrl) fetch(sessionUrl, { method: 'DELETE' }).catch(() => {});
    };
  }, [whepUrl]);

  // Điều khiển play/pause của liveVideo khi chuyển chế độ Live <-> Replay
  useEffect(() => {
    if (isLive) {
      if (liveVideoRef.current) {
        liveVideoRef.current.muted = true;
        liveVideoRef.current.play().catch(() => {});
      }
    } else {
      liveVideoRef.current?.pause();
    }
  }, [isLive]);

  // HLS DVR Player. Luôn tải ngầm và đệm sẵn các segment vào RAM để tua tức thì 0ms
  useEffect(() => {
    const video = replayVideoRef.current;
    const activeHlsBaseUrl = replayHlsBaseUrl || hlsBaseUrl.replace(/\/live$/, '/replay');
    if (!video || !stream?.streamKey || !activeHlsBaseUrl) {
      console.log('[LivePlayer] Chưa đủ điều kiện load video:', {
        hasVideoEl: !!video,
        streamKey: stream?.streamKey || '(chưa có)',
        hlsBaseUrl: activeHlsBaseUrl || '(chưa có)'
      });
      return;
    }

    const playlistUrl = `${activeHlsBaseUrl}/${stream.streamKey}/index.m3u8`;
    console.log('[LivePlayer] === Bắt đầu load HLS DVR ===');
    console.log('[LivePlayer] playlistUrl:', playlistUrl);

    if (loadedStreamKeyRef.current !== stream.streamKey) {
      loadedStreamKeyRef.current = stream.streamKey;
      setPlaybackRate(1.0);
      setHasFrame(false);
      setIsTransitioning(false);
      video.playbackRate = 1.0;
    } else {
      video.playbackRate = playbackRate;
    }

    let cancelled = false;
    let hlsInstance: Hls | null = null;
    let videoEventCleanup: (() => void) | null = null;
    let initialReplaySeekApplied = false;

    const applyInitialReplaySeek = (start: number, end: number) => {
      if (isLive || initialReplaySeekApplied || end < start) return;
      
      let targetTime: number;
      if (pendingReplayRatioRef.current !== null) {
        // Người dùng kéo thanh tua từ Live: tua đúng theo tỷ lệ timeline
        targetTime = start + pendingReplayRatioRef.current * (end - start);
      } else if (pendingReplayTimeRef.current !== null && pendingReplayTimeRef.current >= start && pendingReplayTimeRef.current <= end) {
        targetTime = pendingReplayTimeRef.current;
      } else {
        // Bấm Slow từ Live: lùi 4 giây để xem lại ngay pha vừa qua
        targetTime = Math.max(start, end - 4);
      }

      const safeTime = Math.max(start, Math.min(end, targetTime));
      video.currentTime = safeTime;
      setCurrentTime(safeTime);
      initialReplaySeekApplied = true;
      pendingReplayTimeRef.current = null;
      pendingReplayRatioRef.current = null;
      setFrozenTimeline({ start, end });
      setIsTransitioning(false);
      setHasFrame(true);
      if (isDraggingSeekRef.current) {
        video.pause();
        setIsPlaying(false);
      } else {
        video.play().catch(() => {});
      }
    };

    // QUAN TRỌNG: ngay sau khi RTMP bắt đầu publish, FFmpeg cần khoảng 1-3 giây để ghi xong
    // segment .ts + playlist .m3u8 ĐẦU TIÊN (hls_time=1). Nếu fetch playlist ngay lập tức sẽ
    // luôn ra 404 dù server hoàn toàn khỏe mạnh — đây chính là nguyên nhân video hay không lên
    // hình dù stream đã LIVE. Nhánh HLS native (Safari/Edge) đặc biệt dễ dính vì KHÔNG có cơ chế
    // tự retry như hls.js, nên phải tự chờ & thử lại thủ công trước khi gắn playlist cho player.
    const waitForPlaylistReady = async (): Promise<boolean> => {
      for (let attempt = 1; !cancelled; attempt++) {
        try {
          const res = await fetch(playlistUrl, { cache: 'no-store' });
          if (res.ok) {
            console.log(`[LivePlayer] Playlist .m3u8 đã sẵn sàng sau ${attempt} giây thử.`);
            return true;
          }
        } catch (err) {
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return false;
    };

    (async () => {
      const ready = await waitForPlaylistReady();
      if (cancelled || !ready) return;

      console.log('[LivePlayer] Playlist đã sẵn sàng, bắt đầu gắn vào trình phát.');

      if (!Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          console.log('[LivePlayer] Dùng HLS native của trình duyệt (Safari iOS), không qua hls.js.');
          video.playbackRate = isLive ? 1.0 : playbackRate;
          video.src = playlistUrl;
          return;
        }
        console.error('[LivePlayer] Trình duyệt không hỗ trợ MSE / HLS.js — không thể phát video trên trình duyệt này.');
        return;
      }

      const hls = new Hls({
        // Đây chỉ là đường replay (Live dùng WebRTC). Giữ sẵn nhiều segment để tua
        // chậm/qua lại frame cũ không bị cạn buffer sau vài giây.
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 300,
        enableWorker: true,
        lowLatencyMode: false,
        debug: false
      });
      hlsInstance = hls;
      hlsRef.current = hls;
      hls.loadSource(playlistUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MEDIA_ATTACHED, () => console.log('[LivePlayer][hls.js] MEDIA_ATTACHED — video element đã gắn vào hls.js'));
      hls.on(Hls.Events.MANIFEST_LOADING, () => console.log('[LivePlayer][hls.js] MANIFEST_LOADING — đang tải playlist...'));
      hls.on(Hls.Events.MANIFEST_LOADED, (_e, data) => console.log('[LivePlayer][hls.js] MANIFEST_LOADED — playlist tải xong, số level:', data.levels?.length));
      hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
        const fragments = data.details?.fragments || [];
        console.log('[LivePlayer][hls.js] LEVEL_LOADED — số segment trong playlist:', fragments.length, '| live:', data.details?.live);
        // MSE video.seekable is empty on some Chromium/HLS combinations. The HLS playlist
        // itself is authoritative: each fragment carries its ordered start PTS + duration.
        if (fragments.length > 0) {
          const first = fragments[0];
          const last = fragments[fragments.length - 1];
          const start = first.start;
          const end = last.start + last.duration;
          setHlsWindowStart(start);
          setHlsLiveEdge(end);
          // Khi đang ở chế độ Live và không kéo tua:
          // Giữ replayVideo đồng bộ ở cạnh LIVE để HLS.js luôn tải sẵn các segment mới nhất vào RAM!
          if (isLiveRef.current && !isDraggingSeekRef.current) {
            video.currentTime = Math.max(start, end - 0.5);
          }
          applyInitialReplaySeek(start, end);
        }
      });
      hls.on(Hls.Events.FRAG_LOADING, (_e, data) => console.log('[LivePlayer][hls.js] FRAG_LOADING:', data.frag?.url));
      hls.on(Hls.Events.FRAG_LOADED, (_e, data) => console.log('[LivePlayer][hls.js] FRAG_LOADED OK:', data.frag?.url));
      // Lỗi tải segment .ts (fragLoadError) không có event riêng — nó báo qua Hls.Events.ERROR chung
      // bên dưới với data.details === 'fragLoadError', đã được log đầy đủ ở đó.

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        console.log('[LivePlayer][hls.js] MANIFEST_PARSED — sẵn sàng phát. Số level:', data.levels?.length);
        video.playbackRate = playbackRate;
        setHasFrame(true);
        if (!isLiveRef.current) {
          // Master has its own timeline. Start a few seconds behind its latest keyframe so
          // playback at 0.5x/0.25x has buffered original high-FPS frames immediately.
          window.setTimeout(() => {
            if (video.seekable.length > 0) {
              const end = video.seekable.end(video.seekable.length - 1);
              const start = video.seekable.start(video.seekable.length - 1);
              applyInitialReplaySeek(start, end);
            }
          }, 0);
          video.play().catch(() => {});
        } else {
          video.pause();
        }
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
        if (ev.type === 'loadedmetadata' && video.videoWidth > 0 && video.videoHeight > 0) {
          setSourceIsPortrait(video.videoHeight > video.videoWidth);
        }
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
  }, [stream?.streamKey, hlsBaseUrl, replayHlsBaseUrl]);

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
      setIsTransitioning(false); // HLS đã có frame, ẩn spinner chuyển đổi
    };
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('durationchange', onLoaded);
    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('canplay', onLoaded);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('durationchange', onLoaded);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('canplay', onLoaded);
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

  // Lắng nghe sự kiện seeked: giải phóng cờ isSeekingRef và tiếp tục decode frame tiếp theo nếu đang scrub
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onSeeked = () => {
      if (seekingTimeoutRef.current !== null) {
        window.clearTimeout(seekingTimeoutRef.current);
        seekingTimeoutRef.current = null;
      }
      isSeekingRef.current = false;

      // Nếu trong lúc vừa decode frame trước, tay người dùng đã kéo tới vị trí mới -> seek tiếp ngay!
      if (pendingScrubTimeRef.current !== null) {
        const nextTime = pendingScrubTimeRef.current;
        pendingScrubTimeRef.current = null;
        isSeekingRef.current = true;
        if (typeof (video as any).fastSeek === 'function') {
          (video as any).fastSeek(nextTime);
        } else {
          video.currentTime = nextTime;
        }
        setCurrentTime(nextTime);
        return;
      }

      if (isLive) {
        const lag = hlsLiveEdge - video.currentTime;
        // Nếu còn < 2s lệch live -> tự nhảy về edge để tránh bị stuck ở đầu playlist.
        if (lag >= 0 && lag < 2) {
          video.currentTime = hlsLiveEdge;
        }
      }
    };

    video.addEventListener('seeked', onSeeked);
    return () => {
      video.removeEventListener('seeked', onSeeked);
      if (seekingTimeoutRef.current !== null) {
        window.clearTimeout(seekingTimeoutRef.current);
        seekingTimeoutRef.current = null;
      }
    };
  }, [isLive, hlsLiveEdge]);

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
    isLiveRef.current = true;
    setIsLive(true);
    setIsPlaying(true);
    setPlaybackRate(1.0);
    setFrozenTimeline(null);
    pendingReplayTimeRef.current = null;
    pendingReplayRatioRef.current = null;

    replayVideoRef.current?.pause();
    if (liveVideoRef.current) {
      liveVideoRef.current.muted = true;
      liveVideoRef.current.play().catch(() => {});
    }

    showModeNotice(
      'live',
      'LIVE - TRỰC TIẾP',
      'Đã chuyển về luồng video thời gian thực',
      'Bấm [Enter] hoặc chọn tốc độ để tua chậm'
    );
  };

  const switchToSlow = (speed: number, keepCurrentPosition = false) => {
    isLiveRef.current = false;
    setIsLive(false);
    setPlaybackRate(speed);
    setIsPlaying(true);

    liveVideoRef.current?.pause();

    const video = replayVideoRef.current;
    if (video) {
      video.playbackRate = speed;
      video.muted = true;
      const start = hlsWindowStart;
      const curLiveDuration = Math.max(liveElapsedSeconds, hlsLiveEdge > hlsWindowStart ? hlsLiveEdge - hlsWindowStart : 0);
      const end = hlsLiveEdge > hlsWindowStart ? hlsLiveEdge : (start + curLiveDuration);
      
      setFrozenTimeline((prev) => prev ?? { start, end });

      if (keepCurrentPosition) {
        // Người dùng đã kéo tua đến mốc mong muốn: GIỮ NGUYÊN mốc đó, chỉ phát tiếp với tốc độ mới
        video.playbackRate = speed;
      } else {
        // Chuyển từ Live sang Slow: lùi 4 giây để xem lại pha quay chậm vừa qua
        const targetTime = Math.max(start, end - 4);
        if (video.readyState >= 1) {
          video.currentTime = targetTime;
          setCurrentTime(targetTime);
        } else {
          pendingReplayTimeRef.current = targetTime;
        }
      }

      video.play().catch((err) => {
        console.warn('[LivePlayer] Lỗi play replay:', err);
      });
    }

    showModeNotice(
      'slow',
      `SLOW MOTION - ${speed}x`,
      'Đang tua chậm (Replay)',
      'Bấm [Enter] hoặc chọn [VỀ LIVE] để quay lại'
    );
  };

  const handleSpeedChange = (speed: number) => {
    if (speed < 1.0) {
      // Nếu không còn ở Live (đang ở Replay hoặc vừa kéo thước tua đến mốc), giữ nguyên vị trí hiện tại!
      const keepCurrentPosition = !isLiveRef.current;
      switchToSlow(speed, keepCurrentPosition);
    } else {
      jumpToLive();
    }
  };

  // Hàm tua thời gian thực (Live Video Scrubbing) - Khung hình lướt mượt 60/120 FPS theo tay kéo
  const performScrub = (targetTime: number, isFinal = false) => {
    const video = videoRef.current;
    if (!video) return;

    const start = hlsWindowStart;
    const curLiveDuration = Math.max(liveElapsedSeconds, hlsLiveEdge > hlsWindowStart ? hlsLiveEdge - hlsWindowStart : 0, duration);
    const liveEdge = hlsLiveEdge > hlsWindowStart ? hlsLiveEdge : (start + curLiveDuration);
    const end = (isLive || stream?.status === 'LIVE') ? liveEdge : (frozenTimeline?.end ?? liveEdge);
    const safeTime = Math.max(start, Math.min(end, targetTime));

    // Cập nhật React state ngay lập tức để seekbar & tooltip phản hồi siêu nhạy
    setCurrentTime(safeTime);

    if (isFinal) {
      // Thả chuột hoặc bước frame: huỷ requestAnimationFrame và dừng chính xác 100% tại safeTime
      if (scrubRafRef.current !== null) {
        cancelAnimationFrame(scrubRafRef.current);
        scrubRafRef.current = null;
      }
      pendingScrubTimeRef.current = null;
      isSeekingRef.current = true;
      video.currentTime = safeTime;
      return;
    }

    // Đang kéo chuột: điều phối nạp khung hình qua requestAnimationFrame để lướt mượt 60/120 FPS
    pendingScrubTimeRef.current = safeTime;
    if (scrubRafRef.current === null) {
      scrubRafRef.current = requestAnimationFrame(() => {
        scrubRafRef.current = null;
        const v = videoRef.current;
        if (!v || pendingScrubTimeRef.current === null) return;
        const nextTime = pendingScrubTimeRef.current;

        // Ưu tiên fastSeek phần cứng GPU nếu trình duyệt hỗ trợ để lướt frame mượt mà
        if (typeof (v as any).fastSeek === 'function') {
          (v as any).fastSeek(nextTime);
        } else {
          v.currentTime = nextTime;
        }
      });
    }
  };

  // Tua từng frame (chuẩn 120 FPS: 1 frame = 1/120s ~ 0.008333s)
  const stepFrame = (step: number) => {
    if (isLiveRef.current) {
      isLiveRef.current = false;
      setIsLive(false);
      setIsPlaying(false);
      liveVideoRef.current?.pause();
      const start = hlsWindowStart;
      const end = hlsLiveEdge;
      const target = Math.max(start, end - 4);
      setFrozenTimeline({ start, end });
      performScrub(target, true);
      return;
    }

    const v = replayVideoRef.current;
    if (!v) return;
    setIsPlaying(false);
    v.pause();
    const start = frozenTimeline?.start ?? hlsWindowStart;
    const end = frozenTimeline?.end ?? hlsLiveEdge;
    // Mỗi step đúng 1 frame của 120 FPS (~0.008333s)
    const frameDuration = 1 / 120;
    const target = Math.max(start, Math.min(end, v.currentTime + step * frameDuration));
    performScrub(target, true);
  };

  // Seek bar (DVR window): nhận ratio (0..1) hoặc timestamp cụ thể
  const handleSeek = (ratioOrTime: number, isRatio = true) => {
    const video = replayVideoRef.current;
    if (!video) return;

    const start = frozenTimeline?.start ?? hlsWindowStart;
    const end = frozenTimeline?.end ?? hlsLiveEdge;
    const span = Math.max(0.1, end - start);

    if (isLiveRef.current) {
      const ratio = isRatio ? ratioOrTime : Math.max(0, Math.min(1, (ratioOrTime - start) / span));
      isLiveRef.current = false;
      setIsLive(false);
      setIsPlaying(false);
      liveVideoRef.current?.pause();
      setFrozenTimeline({ start, end });
      performScrub(start + ratio * span, true);
      return;
    }

    const targetTime = isRatio ? start + ratioOrTime * span : ratioOrTime;
    performScrub(targetTime, true);
  };

  // Toggle play/pause trên <video> native
  const togglePlay = () => {
    if (isLiveRef.current) {
      // Đang Live mà bấm pause -> chuyển sang Replay và dừng ở khung hình mép Live
      isLiveRef.current = false;
      setIsLive(false);
      setIsPlaying(false);
      liveVideoRef.current?.pause();
      const v = replayVideoRef.current;
      if (v) {
        v.muted = true;
        v.currentTime = hlsLiveEdge;
        v.pause();
      }
      return;
    }

    const v = replayVideoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
      setIsPlaying(true);
    } else {
      v.pause();
      setIsPlaying(false);
    }
  };

  // Enter: chuyển chế độ Live <-> Slow-Mo (không gán mốc nữa)
  // ArrowLeft / ArrowRight: tua từng frame
  // Phím cách (Space): Play / Pause
  const handleEnterModeSwitch = (e: KeyboardEvent) => {
    if (isTextOverlayOpen) return;

    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as any).isContentEditable)) {
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepFrame(-1);
      return;
    }

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepFrame(1);
      return;
    }

    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      togglePlay();
      return;
    }

    if (e.key !== 'Enter' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (isLiveRef.current) {
      switchToSlow(0.25);
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
      if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.key === ' ' || e.code === 'Space') {
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
  const activeDuration = Math.max(liveElapsedSeconds, hlsLiveEdge > hlsWindowStart ? hlsLiveEdge - hlsWindowStart : 0, duration);
  const timelineStart = frozenTimeline?.start ?? hlsWindowStart;
  const currentLiveEdge = hlsLiveEdge > hlsWindowStart ? hlsLiveEdge : (timelineStart + activeDuration);
  // Khi luồng đang LIVE: timelineEnd luôn dài ra liên tục theo camera, không bao giờ bị khóa ở quá khứ
  const timelineEnd = (isLive || stream?.status === 'LIVE') ? currentLiveEdge : (frozenTimeline?.end ?? currentLiveEdge);

  // YouTube-style seekbar state
  const seekbarRef = useRef<HTMLDivElement | null>(null);
  const [seekHoverTime, setSeekHoverTime] = useState<number | null>(null);
  const [seekHoverX, setSeekHoverX] = useState<number>(0);
  const [isDraggingSeek, setIsDraggingSeek] = useState(false);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const dragRatioRef = useRef<number | null>(null);

  // Utility: chuyển giây sang MM:SS hoặc H:MM:SS. Hỗ trợ hiển thị phần trăm giây cho 120 FPS
  const formatTime = (seconds: number, showFraction = false): string => {
    if (!Number.isFinite(seconds) || seconds < 0) return showFraction ? '0:00.00' : '0:00';
    const totalCentis = Math.floor(seconds * 100);
    const totalSec = Math.floor(totalCentis / 100);
    const centis = totalCentis % 100;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    const base = h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
    if (showFraction) {
      return `${base}.${String(centis).padStart(2, '0')}`;
    }
    return base;
  };

  // Tính ratio vị trí con trỏ trên seekbar
  const getSeekRatio = (clientX: number): number => {
    const bar = seekbarRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const handleSeekbarMouseMove = (e: React.MouseEvent) => {
    const bar = seekbarRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const span = Math.max(1, timelineEnd - timelineStart);
    setSeekHoverTime(timelineStart + ratio * span);
    setSeekHoverX(e.clientX - rect.left);

    if (isDraggingSeek) {
      dragRatioRef.current = ratio;
      setDragRatio(ratio);
      if (!isLive) {
        performScrub(timelineStart + ratio * span, false);
      }
    }
  };

  const handleSeekbarMouseLeave = () => {
    if (!isDraggingSeek) setSeekHoverTime(null);
  };

  const handleSeekbarMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const bar = seekbarRef.current;
    if (!bar) return;

    const initialRatio = getSeekRatio(e.clientX);
    setIsDraggingSeek(true);
    isDraggingSeekRef.current = true;
    dragRatioRef.current = initialRatio;
    setDragRatio(initialRatio);

    liveVideoRef.current?.pause();
    const video = replayVideoRef.current;
    if (video) {
      wasPlayingBeforeDragRef.current = !video.paused;
      video.pause();
      setIsPlaying(false);
    }

    if (isLiveRef.current) {
      isLiveRef.current = false;
      setIsLive(false);
      setFrozenTimeline({
        start: hlsWindowStart,
        end: hlsLiveEdge
      });
    }

    const span = Math.max(0.1, timelineEnd - timelineStart);
    const targetTime = timelineStart + initialRatio * span;
    performScrub(targetTime, false);

    const onMouseMove = (mv: MouseEvent) => {
      const r = getSeekRatio(mv.clientX);
      dragRatioRef.current = r;
      setDragRatio(r);
      const curSpan = Math.max(0.1, timelineEnd - timelineStart);
      setSeekHoverX(mv.clientX - (seekbarRef.current?.getBoundingClientRect().left ?? 0));
      setSeekHoverTime(timelineStart + r * curSpan);

      const curTargetTime = timelineStart + r * curSpan;
      performScrub(curTargetTime, false);
    };

    const onMouseUp = (mu: MouseEvent) => {
      const finalRatio = dragRatioRef.current ?? getSeekRatio(mu.clientX);
      setIsDraggingSeek(false);
      isDraggingSeekRef.current = false;
      setDragRatio(null);
      dragRatioRef.current = null;
      setSeekHoverTime(null);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);

      const curSpan = Math.max(0.1, timelineEnd - timelineStart);
      const finalTime = timelineStart + finalRatio * curSpan;
      // Nhả chuột: seek chính xác tuyệt đối vào frame mục tiêu
      performScrub(finalTime, true);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Touch support
  const handleSeekbarTouchStart = (e: React.TouchEvent) => {
    if (!e.touches[0]) return;
    const initialRatio = getSeekRatio(e.touches[0].clientX);
    setIsDraggingSeek(true);
    isDraggingSeekRef.current = true;
    dragRatioRef.current = initialRatio;
    setDragRatio(initialRatio);

    liveVideoRef.current?.pause();
    const video = replayVideoRef.current;
    if (video) {
      wasPlayingBeforeDragRef.current = !video.paused;
      video.pause();
      setIsPlaying(false);
    }

    if (isLiveRef.current) {
      isLiveRef.current = false;
      setIsLive(false);
      setFrozenTimeline({
        start: hlsWindowStart,
        end: hlsLiveEdge
      });
    }

    const span = Math.max(0.1, timelineEnd - timelineStart);
    const targetTime = timelineStart + initialRatio * span;
    performScrub(targetTime, false);

    const onTouchMove = (mv: TouchEvent) => {
      if (!mv.touches[0]) return;
      const r = getSeekRatio(mv.touches[0].clientX);
      dragRatioRef.current = r;
      setDragRatio(r);
      const curSpan = Math.max(0.1, timelineEnd - timelineStart);
      const curTargetTime = timelineStart + r * curSpan;
      performScrub(curTargetTime, false);
    };

    const onTouchEnd = () => {
      const finalRatio = dragRatioRef.current ?? initialRatio;
      setIsDraggingSeek(false);
      isDraggingSeekRef.current = false;
      setDragRatio(null);
      dragRatioRef.current = null;
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);

      const curSpan = Math.max(0.1, timelineEnd - timelineStart);
      const finalTime = timelineStart + finalRatio * curSpan;
      // Nhả tay: seek chính xác tuyệt đối vào frame mục tiêu
      performScrub(finalTime, true);
    };

    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
  };

  // Progress ratio cho fill bar: ưu tiên vị trí tay đang kéo mượt mà 60fps
  const totalSpan = Math.max(1, timelineEnd - timelineStart);
  const currentVideoRatio = isLive
    ? 1.0
    : (timelineEnd > timelineStart
        ? Math.max(0, Math.min(1, (currentTime - timelineStart) / totalSpan))
        : 0);
  const seekFillRatio = dragRatio !== null ? dragRatio : currentVideoRatio;

  // Thời gian hiển thị ở đầu bên trái: đi theo tay kéo mượt mà, khi Live luôn hiện mốc mới nhất
  const displayCurrentTime = dragRatio !== null
    ? dragRatio * totalSpan
    : (isLive ? totalSpan : Math.max(0, currentTime - timelineStart));

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
            <span>{isLive ? 'LIVE - WEBRTC' : `SLOW - ${playbackRate}x`}</span>
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
        {/* Thẻ 1: Live WebRTC siêu tốc (<0.2s) */}
        <video
          ref={liveVideoRef}
          className={`w-full h-full object-contain bg-black transition-opacity duration-150 ${
            isLive && hasLiveFrame ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
          }`}
          style={{
            transform: `rotate(${rotation}deg) scale(${rotation % 180 === 0 ? 1 : (sourceIsPortrait ? 16 / 9 : 9 / 16)})`,
            transition: 'transform 0.2s ease-in-out',
            position: 'absolute',
            inset: 0
          }}
          playsInline
          muted={isMuted}
          autoPlay
        />

        {/* Thẻ 2: HLS DVR Replay (Luôn chạy ngầm để đệm sẵn buffer vào RAM, phục vụ tua tức thì 0ms) */}
        <video
          ref={replayVideoRef}
          className={`w-full h-full object-contain bg-black transition-opacity duration-150 ${
            !isLive ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
          }`}
          style={{
            transform: `rotate(${rotation}deg) scale(${rotation % 180 === 0 ? 1 : (sourceIsPortrait ? 16 / 9 : 9 / 16)})`,
            transition: 'transform 0.2s ease-in-out',
            position: 'absolute',
            inset: 0
          }}
          playsInline
          muted={isMuted}
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

        {/* DVR Seekbar: YouTube-style với hover tooltip, progress fill, drag mượt */}
        <div className="flex items-center gap-2 px-1">
          {/* Thời gian hiện tại: hiển thị chi tiết mili-giây / phần trăm giây khi Replay hoặc đang kéo tua */}
          <span className="text-[11px] font-mono text-slate-300 min-w-[54px] tabular-nums flex-shrink-0">
            {formatTime(displayCurrentTime, !isLive || isDraggingSeek)}
          </span>

          {/* Seekbar track */}
          <div
            ref={seekbarRef}
            className="relative w-full group cursor-pointer select-none"
            style={{ height: 20, display: 'flex', alignItems: 'center' }}
            onMouseMove={handleSeekbarMouseMove}
            onMouseLeave={handleSeekbarMouseLeave}
            onMouseDown={handleSeekbarMouseDown}
            onTouchStart={handleSeekbarTouchStart}
          >
            {/* Track background */}
            <div className="absolute inset-x-0 rounded-full overflow-hidden transition-all"
              style={{ height: isDraggingSeek || seekHoverTime !== null ? 6 : 4, top: '50%', transform: 'translateY(-50%)' }}>
              {/* Grey track */}
              <div className="absolute inset-0 bg-slate-600/70" />
              {/* Progress fill */}
              <div
                className="absolute left-0 top-0 h-full rounded-full"
                style={{
                  width: `${seekFillRatio * 100}%`,
                  background: isLive ? '#ef4444' : '#6366f1',
                  transition: isDraggingSeek ? 'none' : 'width 0.1s linear'
                }}
              />
              {/* Hover preview */}
              {seekHoverTime !== null && seekbarRef.current && (
                <div
                  className="absolute top-0 h-full bg-white/20 rounded-full"
                  style={{
                    left: `${seekFillRatio * 100}%`,
                    width: `${Math.max(0, ((seekHoverTime - timelineStart) / Math.max(0.01, timelineEnd - timelineStart)) * 100 - seekFillRatio * 100)}%`,
                  }}
                />
              )}
            </div>

            {/* Thumb - chỉ hiện khi hover/drag */}
            <div
              className="absolute rounded-full shadow-lg pointer-events-none transition-transform"
              style={{
                width: isDraggingSeek ? 16 : 12,
                height: isDraggingSeek ? 16 : 12,
                left: `${seekFillRatio * 100}%`,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                background: isLive ? '#ef4444' : '#818cf8',
                opacity: seekHoverTime !== null || isDraggingSeek ? 1 : 0,
                boxShadow: isDraggingSeek ? '0 0 0 4px rgba(99,102,241,0.3)' : 'none',
                transition: isDraggingSeek ? 'none' : 'opacity 0.15s, width 0.1s, height 0.1s',
              }}
            />

            {/* Tooltip thời gian hover với độ chính xác phần trăm giây */}
            {seekHoverTime !== null && (
              <div
                className="absolute pointer-events-none z-20 bottom-full mb-2 px-2 py-0.5 rounded-md bg-slate-900/95 text-white text-[11px] font-mono font-bold border border-white/10 shadow-xl whitespace-nowrap"
                style={{
                  left: Math.max(20, Math.min((seekbarRef.current?.getBoundingClientRect().width ?? 200) - 20, seekHoverX)),
                  transform: 'translateX(-50%)',
                }}
              >
                {formatTime(seekHoverTime - timelineStart, true)}
              </div>
            )}
          </div>

          {/* Tổng thời lượng */}
          <span className="text-[11px] font-mono text-slate-400 min-w-[36px] tabular-nums text-right flex-shrink-0">
            {formatTime(timelineEnd - timelineStart)}
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

            {/* Frame step buttons: chuẩn 120 FPS (1 frame = ~0.0083s) */}
            <div className="inline-flex items-center bg-slate-800/80 rounded-lg p-0.5 border border-white/10">
              <button
                onClick={() => stepFrame(-10)}
                className="px-1.5 py-0.5 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-[11px] font-mono font-medium transition-all"
                title="Lùi 10 khung hình (~0.08s)"
              >
                -10
              </button>
              <button
                onClick={() => stepFrame(-1)}
                className="px-1.5 py-0.5 rounded hover:bg-slate-700 text-slate-200 text-xs font-mono font-bold flex items-center space-x-0.5 transition-all"
                title="Lùi 1 khung hình (1/120s ~ 0.008s)"
              >
                <ChevronLeft className="w-3 h-3" />
                <span>-1</span>
              </button>
              <button
                onClick={() => stepFrame(1)}
                className="px-1.5 py-0.5 rounded hover:bg-slate-700 text-slate-200 text-xs font-mono font-bold flex items-center space-x-0.5 transition-all"
                title="Tiến 1 khung hình (1/120s ~ 0.008s)"
              >
                <span>+1</span>
                <ChevronRight className="w-3 h-3" />
              </button>
              <button
                onClick={() => stepFrame(10)}
                className="px-1.5 py-0.5 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-[11px] font-mono font-medium transition-all"
                title="Tiến 10 khung hình (~0.08s)"
              >
                +10
              </button>
            </div>

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
