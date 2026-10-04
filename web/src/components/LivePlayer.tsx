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
  FlipHorizontal,
  Type,
  Plus,
  Trash2,
  X,
  Maximize,
  Minimize,
  ArrowLeftRight,
  Move,
  ZoomIn,
  Sparkles,
  Key,
  Loader2,
  RefreshCw,
  Send
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
  finishRoundTrigger?: number;
  onFullscreenChange?: (isFullscreen: boolean) => void;
}

export const LivePlayer: React.FC<LivePlayerProps> = ({
  stream,
  socket,
  roomId,
  roomName,
  onFinishRound,
  finishRoundTrigger,
  onFullscreenChange,
}) => {
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const replayVideoRef = useRef<HTMLVideoElement | null>(null);
  const videoRef = replayVideoRef; // Tương thích ngược với các hàm tiện ích
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const [webrtcReconnectCount, setWebrtcReconnectCount] = useState<number>(0);
  const [replaySessionId, setReplaySessionId] = useState<number>(() => Date.now());
  const handleRoundFinishedRef = useRef<() => void>(() => {});
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
  const hasLiveFrameRef = useRef<boolean>(false);
  hasLiveFrameRef.current = hasLiveFrame;
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isLive, setIsLive] = useState(true);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(true);
  const [rotation, setRotation] = useState<number>(0);
  const [isFlipped, setIsFlipped] = useState<boolean>(() => {
    try {
      return localStorage.getItem('player_flipped') === 'true';
    } catch {
      return false;
    }
  });

  const toggleFlip = () => {
    setIsFlipped((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('player_flipped', String(next));
      } catch {}
      return next;
    });
  };

  // Vị trí & kích thước tuỳ chỉnh của màn hình nhỏ PiP Live (tính theo % x, y từ góc trên-trái và width theo pixel)
  const [pipPos, setPipPos] = useState<{ xPercent: number; yPercent: number } | null>(null);
  const [pipWidth, setPipWidth] = useState<number>(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 640) return 150;
    return 240;
  });
  const [isPipDragging, setIsPipDragging] = useState(false);
  const pipDragStartRef = useRef<{ startX: number; startY: number; origXPercent: number; origYPercent: number; moved: boolean } | null>(null);
  const pipPinchStartRef = useRef<{ initialDistance: number; initialWidth: number } | null>(null);
  const pipResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const getTouchDistance = (t1: { clientX: number; clientY: number }, t2: { clientX: number; clientY: number }) => {
    return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
  };

  // Xử lý kéo thả vị trí (1 ngón tay / chuột) & Phóng to thu nhỏ 2 ngón tay (Pinch-to-Zoom)
  const handlePipMouseDown = (clientX: number, clientY: number) => {
    const container = videoContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    const currentX = pipPos ? pipPos.xPercent : Math.max(1, ((rect.width - pipWidth - 16) / rect.width) * 100);
    const currentY = pipPos ? pipPos.yPercent : 3;

    pipDragStartRef.current = {
      startX: clientX,
      startY: clientY,
      origXPercent: currentX,
      origYPercent: currentY,
      moved: false,
    };
    setIsPipDragging(true);

    const onMouseMove = (ev: MouseEvent) => {
      if (!pipDragStartRef.current) return;
      const dx = ev.clientX - pipDragStartRef.current.startX;
      const dy = ev.clientY - pipDragStartRef.current.startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        pipDragStartRef.current.moved = true;
      }
      const dxPercent = (dx / rect.width) * 100;
      const dyPercent = (dy / rect.height) * 100;

      const pipWidthPercent = (pipWidth / rect.width) * 100;
      const newX = Math.max(0.5, Math.min(99.5 - pipWidthPercent, pipDragStartRef.current.origXPercent + dxPercent));
      const newY = Math.max(0.5, Math.min(85, pipDragStartRef.current.origYPercent + dyPercent));

      setPipPos({ xPercent: newX, yPercent: newY });
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      setIsPipDragging(false);
      if (pipDragStartRef.current && !pipDragStartRef.current.moved) {
        jumpToLive();
      }
      pipDragStartRef.current = null;
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handlePipTouchStart = (e: React.TouchEvent) => {
    const container = videoContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    if (e.touches.length === 2) {
      // Bắt đầu chụm / bung 2 ngón tay để thu phóng (Pinch to Zoom)
      const dist = getTouchDistance(e.touches[0], e.touches[1]);
      pipPinchStartRef.current = {
        initialDistance: dist,
        initialWidth: pipWidth,
      };
      pipDragStartRef.current = null;
      setIsPipDragging(false);
      return;
    }

    if (e.touches.length === 1) {
      const currentX = pipPos ? pipPos.xPercent : Math.max(1, ((rect.width - pipWidth - 16) / rect.width) * 100);
      const currentY = pipPos ? pipPos.yPercent : 3;

      pipDragStartRef.current = {
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        origXPercent: currentX,
        origYPercent: currentY,
        moved: false,
      };
      setIsPipDragging(true);
    }

    let hadPinch = false;

    const onTouchMove = (ev: TouchEvent) => {
      // 1. Nếu đang dùng 2 ngón tay -> Phóng to / Thu nhỏ khung hình
      if (ev.touches.length === 2) {
        ev.preventDefault();
        hadPinch = true;
        if (!pipPinchStartRef.current) {
          pipPinchStartRef.current = {
            initialDistance: getTouchDistance(ev.touches[0], ev.touches[1]),
            initialWidth: pipWidth,
          };
        } else {
          const currentDist = getTouchDistance(ev.touches[0], ev.touches[1]);
          const scale = currentDist / pipPinchStartRef.current.initialDistance;
          const newWidth = Math.max(120, Math.min(520, Math.round(pipPinchStartRef.current.initialWidth * scale)));
          setPipWidth(newWidth);
        }
        return;
      }

      // 2. Nếu đang dùng 1 ngón tay -> Kéo di chuyển vị trí
      if (ev.touches.length === 1 && pipDragStartRef.current && !hadPinch) {
        const dx = ev.touches[0].clientX - pipDragStartRef.current.startX;
        const dy = ev.touches[0].clientY - pipDragStartRef.current.startY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          pipDragStartRef.current.moved = true;
        }
        const dxPercent = (dx / rect.width) * 100;
        const dyPercent = (dy / rect.height) * 100;

        const pipWidthPercent = (pipWidth / rect.width) * 100;
        const newX = Math.max(0.5, Math.min(99.5 - pipWidthPercent, pipDragStartRef.current.origXPercent + dxPercent));
        const newY = Math.max(0.5, Math.min(85, pipDragStartRef.current.origYPercent + dyPercent));

        setPipPos({ xPercent: newX, yPercent: newY });
      }
    };

    const onTouchEnd = (ev: TouchEvent) => {
      if (ev.touches.length === 0) {
        window.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('touchend', onTouchEnd);
        setIsPipDragging(false);

        if (!hadPinch && pipDragStartRef.current && !pipDragStartRef.current.moved) {
          jumpToLive();
        }
        pipDragStartRef.current = null;
        pipPinchStartRef.current = null;
      }
    };

    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
  };

  // Xử lý kéo góc để thu phóng to/nhỏ màn PiP
  const handlePipResizeStart = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    pipResizeStartRef.current = {
      startX: clientX,
      startWidth: pipWidth,
    };

    const onMove = (moveX: number) => {
      if (!pipResizeStartRef.current) return;
      const dx = moveX - pipResizeStartRef.current.startX;
      const newWidth = Math.max(120, Math.min(480, pipResizeStartRef.current.startWidth + dx));
      setPipWidth(newWidth);
    };

    const onMouseMove = (ev: MouseEvent) => onMove(ev.clientX);
    const onTouchMove = (ev: TouchEvent) => {
      if (ev.touches[0]) onMove(ev.touches[0].clientX);
    };

    const onEnd = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onEnd);
      pipResizeStartRef.current = null;
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onEnd);
  };

  // Nút bấm nhanh đổi kích thước (Chu kỳ: Nhỏ 150px -> Vừa 240px -> To 340px)
  const cyclePipSize = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    setPipWidth((prev) => {
      if (prev < 190) return 240;
      if (prev < 290) return 340;
      return 150;
    });
  };

  // Nút bấm nhanh đổi góc (Trái <-> Phải)
  const togglePipCorner = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    setPipPos((prev) => {
      const container = videoContainerRef.current;
      const rect = container?.getBoundingClientRect();
      const currentX = prev ? prev.xPercent : 75;
      const pipWidthPercent = rect ? (pipWidth / rect.width) * 100 : 25;
      const newX = currentX > 40 ? 1.5 : Math.max(1.5, 98.5 - pipWidthPercent);
      return {
        xPercent: newX,
        yPercent: prev ? prev.yPercent : 3,
      };
    });
  };

  // Zoom & Pan cho màn hình video chính (hỗ trợ phóng to cận cảnh 1x - 4x bằng 2 ngón tay khi xem Fullscreen hoặc xem thường)
  const [mainZoom, setMainZoom] = useState<number>(1.0);
  const [mainPan, setMainPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const mainPinchStartRef = useRef<{ initialDistance: number; initialZoom: number } | null>(null);
  const mainPanStartRef = useRef<{ startX: number; startY: number; origPan: { x: number; y: number } } | null>(null);
  const lastTapTimeRef = useRef<number>(0);

  const handleContainerTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    // CHỈ bỏ qua nếu đang ở chế độ tua (!isLive) VÀ chạm trúng màn nhỏ PiP ở góc hoặc text overlay
    if (!isLiveRef.current && hasLiveFrameRef.current && target.closest('[data-pip-window="true"]')) {
      return;
    }
    if (target.closest('[data-text-overlay="true"]') || target.closest('button')) {
      return;
    }

    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      mainPinchStartRef.current = {
        initialDistance: dist,
        initialZoom: mainZoom,
      };
      mainPanStartRef.current = null;
      return;
    }

    if (e.touches.length === 1) {
      // Nhấp đúp để reset zoom 1x (hoặc phóng to 2x nếu đang 1x)
      const now = Date.now();
      if (now - lastTapTimeRef.current < 300) {
        if (mainZoom > 1.05) {
          setMainZoom(1.0);
          setMainPan({ x: 0, y: 0 });
        } else {
          setMainZoom(2.0);
        }
        lastTapTimeRef.current = 0;
        return;
      }
      lastTapTimeRef.current = now;

      if (mainZoom > 1.05) {
        mainPanStartRef.current = {
          startX: e.touches[0].clientX,
          startY: e.touches[0].clientY,
          origPan: { ...mainPan },
        };
      }
    }
  };

  const handleContainerTouchMove = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    if (!isLiveRef.current && hasLiveFrameRef.current && target.closest('[data-pip-window="true"]')) {
      return;
    }
    if (target.closest('[data-text-overlay="true"]') || target.closest('button')) {
      return;
    }

    if (e.touches.length === 2 && mainPinchStartRef.current) {
      if (e.cancelable) e.preventDefault();
      const currentDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const scale = currentDist / mainPinchStartRef.current.initialDistance;
      const newZoom = Math.max(1.0, Math.min(4.0, Number((mainPinchStartRef.current.initialZoom * scale).toFixed(2))));
      setMainZoom(newZoom);
      if (newZoom <= 1.02) {
        setMainPan({ x: 0, y: 0 });
      }
      return;
    }

    if (e.touches.length === 1 && mainPanStartRef.current && mainZoom > 1.05) {
      if (e.cancelable) e.preventDefault();
      const dx = e.touches[0].clientX - mainPanStartRef.current.startX;
      const dy = e.touches[0].clientY - mainPanStartRef.current.startY;
      const maxPanX = (mainZoom - 1) * 220;
      const maxPanY = (mainZoom - 1) * 160;
      setMainPan({
        x: Math.max(-maxPanX, Math.min(maxPanX, mainPanStartRef.current.origPan.x + dx)),
        y: Math.max(-maxPanY, Math.min(maxPanY, mainPanStartRef.current.origPan.y + dy)),
      });
    }
  };

  const handleContainerTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) {
      mainPinchStartRef.current = null;
    }
    if (e.touches.length === 0) {
      mainPanStartRef.current = null;
    }
  };

  // Fullscreen state & ref giống YouTube
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const setFullscreenState = (fs: boolean) => {
    setIsFullscreen(fs);
    onFullscreenChange?.(fs);
  };

  const toggleFullscreen = () => {
    const elem = playerContainerRef.current;
    if (!elem) return;

    const isCurrentlyFullscreen = !!(
      document.fullscreenElement ||
      (document as any).webkitFullscreenElement ||
      (document as any).mozFullScreenElement ||
      (document as any).msFullscreenElement ||
      isFullscreen
    );

    if (!isCurrentlyFullscreen) {
      if (elem.requestFullscreen) {
        elem.requestFullscreen().catch(() => {
          setFullscreenState(true);
        });
      } else if ((elem as any).webkitRequestFullscreen) {
        (elem as any).webkitRequestFullscreen();
      } else if ((elem as any).webkitEnterFullscreen) {
        const activeVid = (isLiveRef.current && hasLiveFrame) ? liveVideoRef.current : replayVideoRef.current;
        if (activeVid && (activeVid as any).webkitEnterFullscreen) {
          (activeVid as any).webkitEnterFullscreen();
        } else {
          setFullscreenState(true);
        }
      } else {
        setFullscreenState(true);
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      }
      setFullscreenState(false);
    }
  };

  useEffect(() => {
    const handleFsChange = () => {
      const isFs = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement
      );
      setFullscreenState(isFs);
    };

    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('webkitfullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('webkitfullscreenchange', handleFsChange);
    };
  }, []);

  useEffect(() => {
    if (isFullscreen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isFullscreen]);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [hlsWindowStart, setHlsWindowStart] = useState<number>(0);
  const [hlsLiveEdge, setHlsLiveEdge] = useState<number>(0);
  // Khi xem lại, cạnh phải của timeline là thời điểm người dùng rời Live. Không dùng
  // live edge đang tiếp tục tăng, nếu không nút tua sẽ "trôi" khỏi các frame cũ.
  const [frozenTimeline, setFrozenTimeline] = useState<FrozenTimeline | null>(null);
  const frozenTimelineRef = useRef<FrozenTimeline | null>(null);

  const updateFrozenTimeline = (ft: FrozenTimeline | null | ((prev: FrozenTimeline | null) => FrozenTimeline | null)) => {
    setFrozenTimeline((prev) => {
      const next = typeof ft === 'function' ? ft(prev) : ft;
      frozenTimelineRef.current = next;
      return next;
    });
  };
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
  const [selectedResolution, setSelectedResolution] = useState<'720p' | '480p' | '360p'>('720p');
  const [isResMenuOpen, setIsResMenuOpen] = useState(false);
  const resMenuRef = useRef<HTMLDivElement | null>(null);

  // --- AI Card Detection States & Functions ---
  const [aiProvider, setAiProvider] = useState<'modelapi' | 'gemini'>(() => {
    try {
      return (localStorage.getItem('ai_provider') as any) || 'modelapi';
    } catch {
      return 'modelapi';
    }
  });
  const [aiApiKey, setAiApiKey] = useState<string>(() => {
    try {
      return localStorage.getItem('ai_api_key') || localStorage.getItem('gemini_api_key') || '';
    } catch {
      return '';
    }
  });
  const [aiBaseUrl, setAiBaseUrl] = useState<string>(() => {
    try {
      return localStorage.getItem('ai_base_url') || 'https://modelapi.vn/v1';
    } catch {
      return 'https://modelapi.vn/v1';
    }
  });
  const [aiModel, setAiModel] = useState<string>(() => {
    try {
      return localStorage.getItem('ai_model') || 'gpt-4o-mini';
    } catch {
      return 'gpt-4o-mini';
    }
  });

  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);
  const [tempProvider, setTempProvider] = useState<'modelapi' | 'gemini'>(aiProvider);
  const [tempApiKey, setTempApiKey] = useState(aiApiKey);
  const [tempBaseUrl, setTempBaseUrl] = useState(aiBaseUrl);
  const [tempModel, setTempModel] = useState(aiModel);

  const handleOpenSettings = () => {
    setTempProvider(aiProvider);
    setTempApiKey(aiApiKey);
    setTempBaseUrl(aiBaseUrl);
    setTempModel(aiModel);
    setIsKeyModalOpen(true);
  };

  const handleSaveSettings = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    try {
      localStorage.setItem('ai_provider', tempProvider);
      localStorage.setItem('ai_api_key', tempApiKey.trim());
      localStorage.setItem('ai_base_url', tempBaseUrl.trim());
      localStorage.setItem('ai_model', tempModel.trim());
      if (tempProvider === 'gemini') {
        localStorage.setItem('gemini_api_key', tempApiKey.trim());
      }
    } catch {}
    setAiProvider(tempProvider);
    setAiApiKey(tempApiKey.trim());
    setAiBaseUrl(tempBaseUrl.trim());
    setAiModel(tempModel.trim());
    setIsKeyModalOpen(false);
  };

  interface CardInfo {
    index?: number;
    code?: string;
    display?: string;
    rank?: string | null;
    suit?: string | null;
    suitEn?: string;
    symbol?: string;
    color?: 'red' | 'black' | 'gray';
    status?: 'detected' | 'unseen';
    confidence?: 'high' | 'medium' | 'low';
  }

  interface DetectResult {
    totalCards: number;
    summary: string;
    cards: CardInfo[];
    note?: string;
    modelUsed?: string;
    providerUsed?: string;
  }

  const [isDetecting, setIsDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<DetectResult | null>(null);
  const [detectedImageThumb, setDetectedImageThumb] = useState<string | null>(null);
  const [detectElapsedMs, setDetectElapsedMs] = useState<number | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [isResultOpen, setIsResultOpen] = useState(false);
  const [copiedResult, setCopiedResult] = useState(false);

  // --- Batch Card Snapping & Fast Detection States ---
  const [capturedFrames, setCapturedFrames] = useState<string[]>([]);
  const [batchResults, setBatchResults] = useState<CardInfo[] | null>(null);
  const [batchElapsedMs, setBatchElapsedMs] = useState<number | null>(null);
  const [isBatchSending, setIsBatchSending] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);

  const captureFrame = (): string | null => {
    try {
      const preferredVideo = (!isLive && hasFrame)
        ? replayVideoRef.current
        : (isLive && hasLiveFrame ? liveVideoRef.current : (replayVideoRef.current || liveVideoRef.current));

      const video = (preferredVideo && preferredVideo.videoWidth > 0)
        ? preferredVideo
        : ([replayVideoRef.current, liveVideoRef.current].find(v => v && v.videoWidth > 0) || preferredVideo);

      if (!video) {
        console.warn('[LivePlayer] captureFrame: Không tìm thấy thẻ video nào trong DOM');
        return null;
      }

      const vw = video.videoWidth || (video as any).naturalWidth || video.clientWidth || 1280;
      const vh = video.videoHeight || (video as any).naturalHeight || video.clientHeight || 720;

      if (vw <= 0 || vh <= 0) {
        console.warn('[LivePlayer] captureFrame: Thẻ video chưa có frame hình hợp lệ (vw/vh <= 0)');
        return null;
      }

      const canvas = document.createElement('canvas');
      const rot = ((rotation % 360) + 360) % 360;
      if (rot === 90 || rot === 270) {
        canvas.width = vh;
        canvas.height = vw;
      } else {
        canvas.width = vw;
        canvas.height = vh;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      ctx.save();
      if (rot === 90) {
        ctx.translate(canvas.width, 0);
        ctx.rotate((90 * Math.PI) / 180);
      } else if (rot === 180) {
        ctx.translate(canvas.width, canvas.height);
        ctx.rotate((180 * Math.PI) / 180);
      } else if (rot === 270) {
        ctx.translate(0, canvas.height);
        ctx.rotate((270 * Math.PI) / 180);
      }

      if (isFlipped) {
        ctx.translate(vw, 0);
        ctx.scale(-1, 1);
      }

      ctx.drawImage(video, 0, 0, vw, vh);
      ctx.restore();

      // Giới hạn max dimension 960px để nén base64 siêu nhẹ (<40KB/ảnh), upload cực nhanh
      const maxDim = 960;
      if (canvas.width > maxDim || canvas.height > maxDim) {
        const resizeCanvas = document.createElement('canvas');
        const ratio = Math.min(maxDim / canvas.width, maxDim / canvas.height);
        resizeCanvas.width = Math.round(canvas.width * ratio);
        resizeCanvas.height = Math.round(canvas.height * ratio);
        const rCtx = resizeCanvas.getContext('2d');
        if (rCtx) {
          rCtx.drawImage(canvas, 0, 0, resizeCanvas.width, resizeCanvas.height);
          return resizeCanvas.toDataURL('image/jpeg', 0.88);
        }
      }

      return canvas.toDataURL('image/jpeg', 0.88);
    } catch (err: any) {
      console.error('[LivePlayer] Lỗi captureFrame:', err);
      return null;
    }
  };

  const handleSnapCard = () => {
    const dataUrl = captureFrame();
    if (!dataUrl) return;
    setCapturedFrames((prev) => {
      if (prev.length >= 20) return prev;
      return [...prev, dataUrl];
    });
    // Nếu có kết quả cũ thì reset để chuẩn bị phiên mới
    if (batchResults) {
      setBatchResults(null);
      setBatchElapsedMs(null);
    }
  };

  const handleRemoveSnap = (index: number) => {
    setCapturedFrames((prev) => prev.filter((_, i) => i !== index));
    if (batchResults) {
      setBatchResults(null);
    }
  };

  const handleClearSnaps = () => {
    setCapturedFrames([]);
    setBatchResults(null);
    setBatchElapsedMs(null);
    setBatchError(null);
  };

  const stitchFrames = async (frames: string[]): Promise<string | null> => {
    try {
      if (frames.length === 0) return null;
      if (frames.length === 1) return frames[0];

      const loadedImages = await Promise.all(
        frames.map(
          (src) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = () => reject(new Error('Lỗi tải ảnh để ghép'));
              img.src = src;
            })
        )
      );

      const targetHeight = 240;
      const scaledDims = loadedImages.map((img) => {
        const h = img.naturalHeight || img.height || 240;
        const w = img.naturalWidth || img.width || 320;
        const scale = targetHeight / h;
        return {
          w: Math.max(80, Math.round(w * scale)),
          h: targetHeight
        };
      });

      const totalWidth = scaledDims.reduce((acc, d) => acc + d.w, 0);
      const canvas = document.createElement('canvas');
      canvas.width = totalWidth;
      canvas.height = targetHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) return frames[0];

      let currentX = 0;
      for (let i = 0; i < loadedImages.length; i++) {
        const img = loadedImages[i];
        const { w, h } = scaledDims[i];
        ctx.drawImage(img, currentX, 0, w, h);

        // Vẽ thẻ số góc (#1, #2, #3...) để AI phân biệt chính xác
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(currentX, 0, 36, 24);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 15px sans-serif';
        ctx.fillText(`#${i + 1}`, currentX + 6, 17);

        currentX += w;
      }

      return canvas.toDataURL('image/jpeg', 0.85);
    } catch (err) {
      console.warn('[stitchFrames] Ghép ảnh không thành công, dùng ảnh gốc:', err);
      return null;
    }
  };

  const handleSendBatch = async () => {
    let imagesToSend = capturedFrames;
    if (imagesToSend.length === 0) {
      const single = captureFrame();
      if (!single) {
        setBatchError('Không thể chụp hình từ video. Hãy đảm bảo video đang phát.');
        setIsResultOpen(true);
        return;
      }
      imagesToSend = [single];
      setCapturedFrames([single]);
    }

    setIsBatchSending(true);
    setBatchError(null);
    setIsResultOpen(true);

    try {
      // Tối ưu siêu tốc: Ghép các frame thành 1 dải ngang duy nhất (Sprite Strip)
      const stitched = await stitchFrames(imagesToSend);

      const res = await fetch('/api/ai/batch-detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stitchedImageBase64: stitched || undefined,
          count: imagesToSend.length,
          imagesBase64: imagesToSend,
          apiKey: aiApiKey || undefined
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || 'Lỗi nhận diện từ AI.');
      }

      setBatchResults(data.cards || []);
      setBatchElapsedMs(data.elapsedMs || null);
    } catch (err: any) {
      console.error('[Batch AI] Lỗi:', err);
      setBatchError(err.message || 'Lỗi khi kết nối tới máy chủ AI.');
    } finally {
      setIsBatchSending(false);
    }
  };

  const copyBatchResult = () => {
    if (!batchResults || batchResults.length === 0) return;
    const text = batchResults
      .map((c) => (c.status === 'unseen' || c.code === 'NONE' ? 'Không thấy' : (c.display || `${c.rank}${c.symbol}`)))
      .join(', ');
    navigator.clipboard.writeText(text);
    setCopiedResult(true);
    setTimeout(() => setCopiedResult(false), 2000);
  };

  const handleDetectCards = async () => {
    // Gọi thẳng quy trình gửi batch
    await handleSendBatch();
  };

  const copyDetectResult = () => {
    copyBatchResult();
  };

  useEffect(() => {
    if (!isResMenuOpen) return;
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (resMenuRef.current && !resMenuRef.current.contains(e.target as Node)) {
        setIsResMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isResMenuOpen]);

  const whepUrl = stream?.streamKey
    ? (() => {
        try {
          const endpoint = new URL(detectedServerUrl);
          const pathKey = selectedResolution === '360p'
            ? `${stream.streamKey}_ultra`
            : (selectedResolution === '480p' ? `${stream.streamKey}_low` : stream.streamKey);
          if (endpoint.protocol === 'https:' || (typeof window !== 'undefined' && window.location.protocol === 'https:')) {
            endpoint.protocol = 'https:';
            if (typeof window !== 'undefined' && window.location.hostname) {
              endpoint.hostname = window.location.hostname; // chỉ lấy hostname, không lấy port
            }
            endpoint.port = '8889'; // Nginx SSL :8889 → MediaMTX :8888
            endpoint.pathname = `/${pathKey}/whep`;
          } else {
            endpoint.port = '8889';
            endpoint.pathname = `/${pathKey}/whep`;
          }
          endpoint.search = '';
          return endpoint.toString();
        } catch {
          return '';
        }
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

    const onRoundFinished = () => {
      handleRoundFinishedRef.current();
    };

    socket.on('initial_state', handleInitialState);
    socket.on('round_finished', onRoundFinished);

    return () => {
      socket.off('initial_state', handleInitialState);
      socket.off('round_finished', onRoundFinished);
    };
  }, [socket, roomId, stream?.streamKey, stream?.status]);

  // Khi phiên stream kết thúc hoặc được mở ở trạng thái ENDED:
  // Tự động chuyển sang chế độ Replay để người dùng có thể xem lại toàn bộ video/DVR
  useEffect(() => {
    if (stream?.status === 'ENDED') {
      isLiveRef.current = false;
      setIsLive(false);
    }
  }, [stream?.status]);

  // Khi không còn stream (hoặc stream đã bị xóa khi kết thúc phiên): dọn dẹp sạch toàn bộ video và mốc tua
  useEffect(() => {
    if (!stream) {
      if (replayVideoRef.current) {
        replayVideoRef.current.removeAttribute('src');
        replayVideoRef.current.load();
      }
      if (liveVideoRef.current) {
        liveVideoRef.current.removeAttribute('src');
        liveVideoRef.current.load();
      }
      if (hlsRef.current) {
        try { hlsRef.current.destroy(); } catch {}
        hlsRef.current = null;
      }
      if (peerConnectionRef.current) {
        try { peerConnectionRef.current.close(); } catch {}
        peerConnectionRef.current = null;
      }
      loadedStreamKeyRef.current = null;
      setHasFrame(false);
      setHasLiveFrame(false);
      setCurrentTime(0);
      setDuration(0);
      setHlsWindowStart(0);
      setHlsLiveEdge(0);
      setLiveElapsedSeconds(0);
      setDragRatio(null);
      dragRatioRef.current = null;
      updateFrozenTimeline(null);
      setIsLive(true);
      isLiveRef.current = true;
    }
  }, [stream]);

  // WebRTC Live player (WHEP). Kết nối trực tiếp để xem trực tiếp siêu tốc độ (<0.2s)
  // Chỉ kết nối khi luồng đang LIVE thực sự (tránh báo lỗi 404 WHEP khi app iPhone tắt/dừng live)
  useEffect(() => {
    const video = liveVideoRef.current;
    if (!video || !whepUrl || stream?.status === 'ENDED') return;

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
      const timeout = window.setTimeout(resolve, 250);
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
          peer.addTransceiver('audio', { direction: 'recvonly' });
          peer.ontrack = ({ streams }) => {
            if (cancelled || !streams[0]) return;
            receivedVideoTrack = true;
            video.srcObject = streams[0];
            video.muted = isMuted;
            setHasLiveFrame(true);
            setHasFrame(true);
            video.play().catch((err) => {
              console.warn('[LivePlayer] Autoplay WebRTC ban đầu:', err);
            });
            const track = streams[0].getVideoTracks()[0];
            if (track) {
              track.onended = () => {
                console.log('[LivePlayer] WebRTC video track ended');
                setHasLiveFrame(false);
                if (!cancelled) {
                  setTimeout(() => {
                    if (!cancelled) setWebrtcReconnectCount((c) => c + 1);
                  }, 1000);
                }
              };
            }
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

          peer.onconnectionstatechange = () => {
            console.log('[LivePlayer] WebRTC connectionState:', peer?.connectionState);
            if (peer?.connectionState === 'failed' || peer?.connectionState === 'disconnected') {
              setHasLiveFrame(false);
              if (!cancelled) {
                setTimeout(() => {
                  if (!cancelled) setWebrtcReconnectCount((c) => c + 1);
                }, 1000);
              }
            }
          };
          peer.oniceconnectionstatechange = () => {
            console.log('[LivePlayer] WebRTC iceConnectionState:', peer?.iceConnectionState);
            if (peer?.iceConnectionState === 'failed' || peer?.iceConnectionState === 'disconnected') {
              setHasLiveFrame(false);
              if (!cancelled) {
                setTimeout(() => {
                  if (!cancelled) setWebrtcReconnectCount((c) => c + 1);
                }, 1000);
              }
            }
          };
          return;
        } catch (error) {
          if (sessionUrl) fetch(sessionUrl, { method: 'DELETE' }).catch(() => {});
          sessionUrl = null;
          peer?.close();
          peer = null;
          peerConnectionRef.current = null;
          console.log(`[LivePlayer] WHEP chưa sẵn sàng (lần ${attempt}, sẽ thử lại):`, error);
          await new Promise((resolve) => window.setTimeout(resolve, 350));
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
  }, [whepUrl, webrtcReconnectCount]);

  // Điều khiển play/pause của liveVideo khi chuyển chế độ Live <-> Replay
  useEffect(() => {
    if (isLive) {
      if (hasLiveFrame && liveVideoRef.current) {
        liveVideoRef.current.muted = isMuted;
        liveVideoRef.current.play().catch(() => {});
        if (replayVideoRef.current) {
          replayVideoRef.current.pause();
          replayVideoRef.current.muted = true;
        }
      } else if (replayVideoRef.current) {
        // Fallback: nếu không có WebRTC (chạy trên VPS thuần HLS), HLS PHẢI phát trực tiếp tại live edge!
        const video = replayVideoRef.current;
        video.muted = isMuted;
        video.playbackRate = 1.0;
        if (video.seekable.length > 0) {
          const end = video.seekable.end(video.seekable.length - 1);
          if (video.currentTime < end - 3 || video.currentTime === 0) {
            video.currentTime = Math.max(0, end - 1.5);
          }
        }
        video.play().catch(() => {});
      }
    } else {
      // Khi tua: Replay video LUÔN LUÔN tắt tiếng (tua không cần âm thanh)
      if (replayVideoRef.current) {
        replayVideoRef.current.muted = true;
        replayVideoRef.current.play().catch(() => {});
      }
      // Live video trong màn nhỏ PiP góc vẫn chạy realtime, âm thanh theo cài đặt isMuted
      if (liveVideoRef.current) {
        liveVideoRef.current.muted = isMuted;
        liveVideoRef.current.play().catch(() => {});
      }
    }
  }, [isLive, hasLiveFrame, isMuted]);

  // Luôn đồng bộ playbackRate vào replayVideoRef khi chọn tốc độ (kể cả 1.0x) hoặc đổi chế độ
  useEffect(() => {
    if (replayVideoRef.current) {
      replayVideoRef.current.playbackRate = isLive ? 1.0 : playbackRate;
    }
  }, [playbackRate, isLive]);

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

    const playlistUrl = `${activeHlsBaseUrl}/${stream.streamKey}/index.m3u8?r=${replaySessionId}`;
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
      if (isLiveRef.current || initialReplaySeekApplied || end < start) return;
      
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
      updateFrozenTimeline({ start, end });
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
        // Cấu hình tối ưu cho DVR Replay (video 120/240fps gốc, không có audio):
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 256 * 1024 * 1024, // 256MB RAM buffer cho 120fps source
        backBufferLength: 180, // Giữ 3 phút buffer lùi để tua qua lại tức thì
        maxBufferHole: 0.4, // Ngưỡng nhỏ để không nhảy cóc frame
        nudgeOffset: 0.05, // Nhích nhẹ (~6 frame) nếu kẹt buffer thay vì nhảy nửa giây
        nudgeMaxRetry: 5,
        // TẮT hoàn toàn watchdog buffer cao để không kích hoạt stall giả khi phát slow-mo 0.25x/0.125x
        highBufferWatchdogPeriod: 0,
        liveSyncDuration: 3,
        // Vô hiệu hoá auto-seek của HLS.js về live edge trong chế độ replay
        liveMaxLatencyDuration: 86400,
        // Không cho HLS.js tự tăng video.playbackRate để catch-up live edge
        maxLiveSyncPlaybackRate: 1,
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

          // Cứu nguy nếu đang ở Live mode nhưng chưa có WebRTC live frame:
          // Nếu video đang bị đứng ở currentTime=0 hoặc trước start PTS, nhảy ngay tới live edge!
          if (isLiveRef.current && !hasLiveFrameRef.current) {
            if (video.currentTime < start || (video.currentTime === 0 && end > 2)) {
              console.log(`[LivePlayer] Nhảy HLS về live edge: ${end - 1.5}s (start=${start}, current=${video.currentTime})`);
              video.currentTime = Math.max(start, end - 1.5);
              video.play().catch(() => {});
            }
          }
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
          // Khi đang ở chế độ Live:
          // Nếu không có WebRTC (hasLiveFrame = false), HLS phát trực tiếp cho người xem
          video.muted = isMuted;
          window.setTimeout(() => {
            if (video.seekable.length > 0) {
              const end = video.seekable.end(video.seekable.length - 1);
              video.currentTime = Math.max(0, end - 1.5);
            }
            video.play().catch((err) => {
              console.warn('[LivePlayer] Autoplay HLS live:', err);
            });
          }, 100);
        }
      });

      hls.on(Hls.Events.ERROR, (_e, data) => {
        // bufferStalledError là không fatal và rất hay gặp khi tua sang vùng chưa có buffer.
        // KHÔNG log spam vì nó lặp lại hàng chục lần mỗi giây.
        if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
          // Không làm gì — stall timer trong onVideoEvent (waiting/stalled) sẽ xử lý sau 3500ms
          // nếu HLS.js không tự tải xong segment trong thời gian đó.
          // Nhảy currentTime ngay lập tức ở đây sẽ trigger thêm stall mới (vòng lặp).
          return;
        }

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
              console.error('[LivePlayer][hls.js] Lỗi fatal khác -> thử recoverMediaError trước khi destroy.');
              hls.recoverMediaError();
              break;
          }
        }
      });

      // Log toàn bộ sự kiện native của thẻ <video> để biết chính xác trạng thái decode/buffer thật sự,
      // vì đôi khi hls.js không báo lỗi gì nhưng <video> vẫn không render được frame nào.
      const videoEvents = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'waiting', 'stalled', 'suspend', 'abort', 'emptied', 'error', 'ratechange'];
      let stallTimer: number | null = null;
      const onVideoEvent = (ev: Event) => {
        if (ev.type === 'loadedmetadata' && video.videoWidth > 0 && video.videoHeight > 0) {
          setSourceIsPortrait(video.videoHeight > video.videoWidth);
        }

        // Xử lý tự động cứu khi video bị khựng (stalled / waiting)
        if (ev.type === 'waiting' || ev.type === 'stalled') {
          if (!video.paused) {
            if (stallTimer) window.clearTimeout(stallTimer);
            stallTimer = window.setTimeout(() => {
              if (!video.paused && video.readyState < 3) {
                if (!isLiveRef.current) {
                  console.log('[LivePlayer] Video replay bị khựng (stall/waiting) quá 3500ms -> Nhích nhẹ để tiếp tục phát...');
                  video.currentTime = Math.min(video.duration || 999999, video.currentTime + 0.1);
                } else if (!hasLiveFrameRef.current) {
                  console.log('[LivePlayer] Video live HLS bị khựng -> Nhảy về live edge...');
                  const end = video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : 0;
                  if (end > 0) {
                    video.currentTime = Math.max(0, end - 1.5);
                    video.play().catch(() => {});
                  }
                }
              }
            }, 2500);
          }
        } else if (ev.type === 'playing' || ev.type === 'canplay') {
          if (stallTimer) {
            window.clearTimeout(stallTimer);
            stallTimer = null;
          }
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
      videoEventCleanup = () => {
        if (stallTimer) window.clearTimeout(stallTimer);
        videoEvents.forEach((evt) => video.removeEventListener(evt, onVideoEvent));
      };
    })();

    return () => {
      console.log('[LivePlayer] Cleanup HLS instance cho streamKey:', stream.streamKey);
      cancelled = true;
      if (videoEventCleanup) videoEventCleanup();
      if (hlsInstance) hlsInstance.destroy();
      hlsRef.current = null;
    };
  }, [stream?.streamKey, hlsBaseUrl, replayHlsBaseUrl, replaySessionId]);

  // Đồng bộ <video> currentTime + duration lên UI để vẽ seekbar DVR window.
  useEffect(() => {
    const replayVid = replayVideoRef.current;
    const liveVid = liveVideoRef.current;

    const onTime = () => {
      if (replayVid) {
        setCurrentTime(replayVid.currentTime);
        if (Number.isFinite(replayVid.duration)) {
          setDuration(replayVid.duration);
        }
      }
    };
    const onReplayPlay = () => {
      if (!isLiveRef.current) setIsPlaying(true);
    };
    const onReplayPause = () => {
      if (!isLiveRef.current) setIsPlaying(false);
    };
    const onLivePlay = () => {
      if (isLiveRef.current) setIsPlaying(true);
    };
    const onLivePause = () => {
      if (isLiveRef.current) setIsPlaying(false);
    };
    const onLoaded = () => {
      if (replayVid && Number.isFinite(replayVid.duration)) setDuration(replayVid.duration);
      setHasFrame(true);
      setIsTransitioning(false); // HLS đã có frame, ẩn spinner chuyển đổi
    };

    if (replayVid) {
      replayVid.addEventListener('timeupdate', onTime);
      replayVid.addEventListener('durationchange', onLoaded);
      replayVid.addEventListener('loadeddata', onLoaded);
      replayVid.addEventListener('canplay', onLoaded);
      replayVid.addEventListener('play', onReplayPlay);
      replayVid.addEventListener('pause', onReplayPause);
    }
    if (liveVid) {
      liveVid.addEventListener('play', onLivePlay);
      liveVid.addEventListener('pause', onLivePause);
    }

    return () => {
      if (replayVid) {
        replayVid.removeEventListener('timeupdate', onTime);
        replayVid.removeEventListener('durationchange', onLoaded);
        replayVid.removeEventListener('loadeddata', onLoaded);
        replayVid.removeEventListener('canplay', onLoaded);
        replayVid.removeEventListener('play', onReplayPlay);
        replayVid.removeEventListener('pause', onReplayPause);
      }
      if (liveVid) {
        liveVid.removeEventListener('play', onLivePlay);
        liveVid.removeEventListener('pause', onLivePause);
      }
    };
  }, []);

  // Cập nhật live edge từ video.seekable nhưng KHÔNG ĐƯỢC ghi đè hlsWindowStart,
  // vì hlsWindowStart phải giữ nguyên mốc bắt đầu của toàn bộ stream từ playlist HLS!
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const updateSeekableWindow = () => {
      const ranges = video.seekable;
      if (ranges.length === 0) return;
      const end = ranges.end(ranges.length - 1);
      if (Number.isFinite(end)) {
        setHlsLiveEdge((prev) => Math.max(prev, end));
      }
    };
    video.addEventListener('progress', updateSeekableWindow);
    video.addEventListener('durationchange', updateSeekableWindow);
    video.addEventListener('canplay', updateSeekableWindow);
    const interval = window.setInterval(updateSeekableWindow, 1000);
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
        // Dùng currentTime chính xác để giải mã đầy đủ 100% chi tiết, không dùng fastSeek làm nhòe/vỡ khối
        video.currentTime = nextTime;
        setCurrentTime(nextTime);
        return;
      }

      if (isLiveRef.current) {
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
  }, [hlsLiveEdge]);

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
    updateFrozenTimeline(null);
    pendingReplayTimeRef.current = null;
    pendingReplayRatioRef.current = null;

    // 1. Tạm dừng video xem lại (Replay)
    replayVideoRef.current?.pause();

    // 2. Kích hoạt và bật tiếng (nếu không mute) cho luồng trực tiếp Live WebRTC
    const liveVid = liveVideoRef.current;
    if (liveVid) {
      liveVid.muted = isMuted;
      liveVid.play().catch(() => {});

      // Sức khỏe WebRTC: nếu video live bị khựng hoặc readyState thấp hoặc mất kết nối
      if (liveVid.readyState < 2 || liveVid.paused || !peerConnectionRef.current || peerConnectionRef.current.connectionState !== 'connected') {
        if (liveVid.srcObject) {
          console.log('[LivePlayer] Đánh thức WebRTC live stream...');
          const stream = liveVid.srcObject as MediaStream;
          liveVid.srcObject = stream;
          liveVid.play().catch(() => {});
        }
        if (!peerConnectionRef.current || peerConnectionRef.current.connectionState === 'failed' || peerConnectionRef.current.connectionState === 'disconnected') {
          setWebrtcReconnectCount((c) => c + 1);
        }
      }
    }

    // 3. Nếu chưa có WebRTC live frame, HLS chính là luồng xem Live đồng bộ mép trực tiếp!
    if (!hasLiveFrameRef.current && replayVideoRef.current) {
      const video = replayVideoRef.current;
      video.playbackRate = 1.0;
      video.muted = isMuted;
      if (video.seekable.length > 0) {
        video.currentTime = Math.max(0, video.seekable.end(video.seekable.length - 1) - 1.5);
      } else if (hlsLiveEdge > 0) {
        video.currentTime = Math.max(0, hlsLiveEdge - 1.5);
      }
      video.play().catch(() => {});
    }

    showModeNotice(
      'live',
      'LIVE - TRỰC TIẾP',
      'Đã chuyển về luồng video thời gian thực',
      'Bấm [Enter] hoặc chọn tốc độ để tua chậm'
    );
  };

  const handleRoundFinished = () => {
    console.log('[LivePlayer] handleRoundFinished -> Purging all browser video buffers, overlays and jumping to live...');
    // 1. Phá hủy hoàn toàn HLS cũ và xóa sạch toàn bộ buffer video trong RAM của trình duyệt
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {}
      hlsRef.current = null;
    }
    if (replayVideoRef.current) {
      replayVideoRef.current.pause();
      replayVideoRef.current.removeAttribute('src');
      replayVideoRef.current.load();
    }
    setHasFrame(false);
    setHlsWindowStart(0);
    setHlsLiveEdge(0);
    setCurrentTime(0);
    setDuration(0);
    updateFrozenTimeline(null);

    // 2. Chuyển ngay về Live mode
    isLiveRef.current = true;
    setIsLive(true);
    setIsPlaying(true);
    setPlaybackRate(1.0);
    setDragRatio(null);
    dragRatioRef.current = null;
    pendingReplayTimeRef.current = null;
    pendingReplayRatioRef.current = null;
    setLiveElapsedSeconds(0);

    // Xóa sạch toàn bộ chữ chèn trên màn hình và trong localStorage
    setTextOverlays([]);
    try {
      localStorage.removeItem('live_text_overlays_' + (roomId || 'default'));
    } catch {}

    // 3. Kích hoạt kết nối lại WebRTC ngay lập tức nếu chưa kết nối hoặc bị ngắt
    if (!peerConnectionRef.current || peerConnectionRef.current.connectionState !== 'connected') {
      setWebrtcReconnectCount((c) => c + 1);
    }

    // 4. Tự động chuyển ngay về luồng Live trực tiếp!
    jumpToLive();

    // 5. Sau 1.5 giây (để server kịp xoá sạch file .ts cũ và tạo playlist mới bắt đầu từ 0s),
    // cấp replaySessionId mới để nạp HLS mới toanh từ 0s!
    setTimeout(() => {
      setReplaySessionId(Date.now());
    }, 1500);
  };
  handleRoundFinishedRef.current = handleRoundFinished;

  // Lắng nghe trigger từ bên ngoài (App / nút Xong Phiên)
  useEffect(() => {
    if (finishRoundTrigger && finishRoundTrigger > 0) {
      handleRoundFinished();
    }
  }, [finishRoundTrigger]);

  const switchToSlow = (speed: number, keepCurrentPosition = false) => {
    isLiveRef.current = false;
    setIsLive(false);
    setPlaybackRate(speed);
    setIsPlaying(true);

    // Màn nhỏ Live giữ nguyên âm thanh (theo cài đặt isMuted) và tiếp tục phát mượt mà không bao giờ pause
    if (liveVideoRef.current) {
      liveVideoRef.current.muted = isMuted;
      liveVideoRef.current.play().catch(() => {});
    }

    const video = replayVideoRef.current;
    if (video) {
      video.playbackRate = speed;
      video.muted = true;
      const start = hlsWindowStart;
      const curLiveDuration = Math.max(liveElapsedSeconds, hlsLiveEdge > hlsWindowStart ? hlsLiveEdge - hlsWindowStart : 0);
      const end = hlsLiveEdge > hlsWindowStart ? hlsLiveEdge : (start + curLiveDuration);
      
      updateFrozenTimeline((prev) => prev ?? { start, end });

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

    const isNormalSpeed = speed === 1.0;
    showModeNotice(
      'slow',
      isNormalSpeed ? 'TỐC ĐỘ GỐC - 1.0x (REPLAY)' : `SLOW MOTION - ${speed}x`,
      isNormalSpeed ? 'Đang phát xem lại ở tốc độ chuẩn 1x' : 'Đang phát quay chậm (Replay)',
      'Bấm [🔴 VỀ LIVE] hoặc phím [Enter] để quay lại trực tiếp'
    );
  };

  const handleSpeedChange = (speed: number) => {
    // Luôn áp dụng tốc độ (kể cả 1.0x) cho luồng Replay để người dùng có thể xem lại ở tốc độ thường!
    // Không tự ý nhảy về Live khi chọn 1.0x nữa (chỉ về Live khi bấm nút [VỀ LIVE] hoặc phím Enter).
    const keepCurrentPosition = !isLiveRef.current;
    switchToSlow(speed, keepCurrentPosition);
  };

  // Hàm tua thời gian thực (Live Video Scrubbing) - Khung hình lướt mượt 60/120 FPS theo tay kéo
  const performScrub = (targetTime: number, isFinal = false) => {
    const video = videoRef.current;
    if (!video) return;

    const currentFrozen = frozenTimelineRef.current ?? frozenTimeline;
    const start = currentFrozen?.start ?? hlsWindowStart;
    const curLiveDuration = Math.max(liveElapsedSeconds, hlsLiveEdge > hlsWindowStart ? hlsLiveEdge - hlsWindowStart : 0, duration);
    const liveEdge = hlsLiveEdge > hlsWindowStart ? hlsLiveEdge : (start + curLiveDuration);
    // Khi đang xem lại (replay): end luôn bị đóng băng theo frozenTimeline để mốc tua không bị gián đoạn hay nhảy tiến
    const end = isLiveRef.current ? liveEdge : (currentFrozen?.end ?? liveEdge);
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
        // Nếu trình duyệt đang bận seek frame trước đó, chờ onSeeked hoàn thành rồi mới seek mốc mới nhất
        if (isSeekingRef.current) return;

        const nextTime = pendingScrubTimeRef.current;
        isSeekingRef.current = true;
        v.currentTime = nextTime;
      });
    }
  };

  // Tua từng frame (chuẩn 120 FPS: 1 frame = 1/120s ~ 0.008333s)
  const stepFrame = (step: number) => {
    if (isLiveRef.current) {
      isLiveRef.current = false;
      setIsLive(false);
      setIsPlaying(false);
      const start = hlsWindowStart;
      const end = hlsLiveEdge;
      const target = Math.max(start, end - 4);
      updateFrozenTimeline({ start, end });
      performScrub(target, true);
      return;
    }

    const v = replayVideoRef.current;
    if (!v) return;
    setIsPlaying(false);
    v.pause();
    const currentFrozen = frozenTimelineRef.current ?? frozenTimeline;
    const start = currentFrozen?.start ?? hlsWindowStart;
    const end = currentFrozen?.end ?? hlsLiveEdge;
    // Mỗi step đúng 1 frame của 120 FPS (~0.008333s)
    const frameDuration = 1 / 120;
    const target = Math.max(start, Math.min(end, v.currentTime + step * frameDuration));
    performScrub(target, true);
  };

  // Seek bar (DVR window): nhận ratio (0..1) hoặc timestamp cụ thể
  const handleSeek = (ratioOrTime: number, isRatio = true) => {
    const video = replayVideoRef.current;
    if (!video) return;

    const currentFrozen = frozenTimelineRef.current ?? frozenTimeline;
    const start = currentFrozen?.start ?? hlsWindowStart;
    const end = currentFrozen?.end ?? hlsLiveEdge;
    const span = Math.max(0.1, end - start);

    if (isLiveRef.current) {
      const ratio = isRatio ? ratioOrTime : Math.max(0, Math.min(1, (ratioOrTime - start) / span));
      isLiveRef.current = false;
      setIsLive(false);
      setIsPlaying(false);
      updateFrozenTimeline({ start, end });
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

    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      toggleFlip();
      return;
    }

    if (e.key === 'c' || e.key === 'C') {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as any).isContentEditable)) {
        return;
      }
      e.preventDefault();
      handleSnapCard();
      return;
    }

    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
      return;
    }

    if (e.key === 'Escape' && isFullscreen) {
      e.preventDefault();
      toggleFullscreen();
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

  // Chrome/Safari tối thiểu hỗ trợ playbackRate = 0.0625 (1/16). 0.05 sẽ throw NotSupportedError.
  const speedOptions = [0.0625, 0.1, 0.125, 0.25, 0.5, 0.75, 1.0];

  // Menu chọn tốc độ Custom chuẩn YouTube (tránh iPad văng fullscreen do thẻ select)
  const [isSpeedMenuOpen, setIsSpeedMenuOpen] = useState(false);
  const speedMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isSpeedMenuOpen) return;
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (speedMenuRef.current && !speedMenuRef.current.contains(e.target as Node)) {
        setIsSpeedMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isSpeedMenuOpen]);
  const hasStreamData = !!stream && (hasFrame || hasLiveFrame || (hlsLiveEdge > hlsWindowStart) || duration > 0);
  const activeDuration = !hasStreamData
    ? 0
    : Math.max(liveElapsedSeconds, hlsLiveEdge > hlsWindowStart ? hlsLiveEdge - hlsWindowStart : 0, duration);
  const timelineStart = !hasStreamData ? 0 : (frozenTimeline?.start ?? hlsWindowStart);
  const currentLiveEdge = !hasStreamData ? 0 : (hlsLiveEdge > hlsWindowStart ? hlsLiveEdge : (timelineStart + activeDuration));
  // Khi đang xem Live: timelineEnd dài ra theo camera; Khi đang xem lại (Replay): timelineEnd được giữ cố định theo frozenTimeline để mốc tua không bị trôi giật
  const timelineEnd = !hasStreamData ? 0 : (isLive ? currentLiveEdge : (frozenTimeline?.end ?? currentLiveEdge));

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
    if (!bar || !hasStreamData || activeDuration === 0) return;
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
    if (!bar || !hasStreamData || activeDuration === 0) return;

    const initialRatio = getSeekRatio(e.clientX);
    setIsDraggingSeek(true);
    isDraggingSeekRef.current = true;
    dragRatioRef.current = initialRatio;
    setDragRatio(initialRatio);

    const wasLive = isLiveRef.current;
    const video = replayVideoRef.current;
    if (video) {
      wasPlayingBeforeDragRef.current = wasLive ? true : !video.paused;
      video.pause();
      setIsPlaying(false);
    }

    if (isLiveRef.current) {
      isLiveRef.current = false;
      setIsLive(false);
      updateFrozenTimeline({
        start: hlsWindowStart,
        end: hlsLiveEdge
      });
    }

    const activeTimeline = frozenTimelineRef.current ?? { start: hlsWindowStart, end: hlsLiveEdge };
    const span = Math.max(0.1, activeTimeline.end - activeTimeline.start);
    const targetTime = activeTimeline.start + initialRatio * span;
    performScrub(targetTime, false);

    const onMouseMove = (mv: MouseEvent) => {
      const r = getSeekRatio(mv.clientX);
      dragRatioRef.current = r;
      setDragRatio(r);
      const curTimeline = frozenTimelineRef.current ?? { start: hlsWindowStart, end: hlsLiveEdge };
      const curSpan = Math.max(0.1, curTimeline.end - curTimeline.start);
      setSeekHoverX(mv.clientX - (seekbarRef.current?.getBoundingClientRect().left ?? 0));
      setSeekHoverTime(curTimeline.start + r * curSpan);

      const curTargetTime = curTimeline.start + r * curSpan;
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

      const curTimeline = frozenTimelineRef.current ?? { start: hlsWindowStart, end: hlsLiveEdge };
      const curSpan = Math.max(0.1, curTimeline.end - curTimeline.start);
      const finalTime = curTimeline.start + finalRatio * curSpan;
      // Nhả chuột: seek chính xác tuyệt đối vào frame mục tiêu
      performScrub(finalTime, true);
      // Tự động phát tiếp ngay lập tức tại mốc vừa kéo với đúng tốc độ slow đang chọn
      if (replayVideoRef.current) {
        replayVideoRef.current.playbackRate = playbackRate;
        replayVideoRef.current.play().catch(() => {});
        setIsPlaying(true);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Touch support
  const handleSeekbarTouchStart = (e: React.TouchEvent) => {
    if (!e.touches[0] || !hasStreamData || activeDuration === 0) return;
    const initialRatio = getSeekRatio(e.touches[0].clientX);
    setIsDraggingSeek(true);
    isDraggingSeekRef.current = true;
    dragRatioRef.current = initialRatio;
    setDragRatio(initialRatio);

    const wasLive = isLiveRef.current;
    const video = replayVideoRef.current;
    if (video) {
      wasPlayingBeforeDragRef.current = wasLive ? true : !video.paused;
      video.pause();
      setIsPlaying(false);
    }

    if (isLiveRef.current) {
      isLiveRef.current = false;
      setIsLive(false);
      updateFrozenTimeline({
        start: hlsWindowStart,
        end: hlsLiveEdge
      });
    }

    const activeTimeline = frozenTimelineRef.current ?? { start: hlsWindowStart, end: hlsLiveEdge };
    const span = Math.max(0.1, activeTimeline.end - activeTimeline.start);
    const targetTime = activeTimeline.start + initialRatio * span;
    performScrub(targetTime, false);

    const onTouchMove = (mv: TouchEvent) => {
      if (!mv.touches[0]) return;
      const r = getSeekRatio(mv.touches[0].clientX);
      dragRatioRef.current = r;
      setDragRatio(r);
      const curTimeline = frozenTimelineRef.current ?? { start: hlsWindowStart, end: hlsLiveEdge };
      const curSpan = Math.max(0.1, curTimeline.end - curTimeline.start);
      const curTargetTime = curTimeline.start + r * curSpan;
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

      const curTimeline = frozenTimelineRef.current ?? { start: hlsWindowStart, end: hlsLiveEdge };
      const curSpan = Math.max(0.1, curTimeline.end - curTimeline.start);
      const finalTime = curTimeline.start + finalRatio * curSpan;
      // Nhả tay: seek chính xác tuyệt đối vào frame mục tiêu
      performScrub(finalTime, true);
      // Tự động phát tiếp ngay lập tức tại mốc vừa kéo với đúng tốc độ slow đang chọn
      if (replayVideoRef.current) {
        replayVideoRef.current.playbackRate = playbackRate;
        replayVideoRef.current.play().catch(() => {});
        setIsPlaying(true);
      }
    };

    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
  };

  // Progress ratio cho fill bar: ưu tiên vị trí tay đang kéo mượt mà 60fps
  const totalSpan = !hasStreamData || activeDuration === 0 ? 0 : Math.max(1, timelineEnd - timelineStart);
  const currentVideoRatio = (!hasStreamData || activeDuration === 0)
    ? 0
    : (isLive
        ? 1.0
        : (timelineEnd > timelineStart
            ? Math.max(0, Math.min(1, (currentTime - timelineStart) / totalSpan))
            : 0));
  const seekFillRatio = dragRatio !== null ? dragRatio : currentVideoRatio;

  // Thời gian hiển thị ở đầu bên trái: đi theo tay kéo mượt mà, khi Live luôn hiện mốc mới nhất
  const displayCurrentTime = (!hasStreamData || activeDuration === 0)
    ? 0
    : (dragRatio !== null
        ? dragRatio * totalSpan
        : (isLive ? totalSpan : Math.max(0, currentTime - timelineStart)));

  return (
    <div
      ref={playerContainerRef}
      className={`glass-panel overflow-hidden shadow-2xl border border-indigo-500/20 flex flex-col transition-all ${
        isFullscreen
          ? 'fixed inset-0 z-[999999] w-screen h-screen rounded-none bg-black max-h-none border-none'
          : 'rounded-2xl'
      }`}
    >
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
        onDoubleClick={toggleFullscreen}
        onTouchStart={handleContainerTouchStart}
        onTouchMove={handleContainerTouchMove}
        onTouchEnd={handleContainerTouchEnd}
        style={{ touchAction: 'none' }}
        className={`relative w-full bg-black flex items-center justify-center group overflow-hidden select-none cursor-pointer ${
          isFullscreen ? 'flex-1 h-full max-h-none aspect-auto' : 'aspect-video max-h-[58vh]'
        }`}
        title="Nhấp đúp chuột để Phóng to / Thu nhỏ toàn màn hình (F). Dùng 2 ngón tay để zoom cận cảnh."
      >
        {/* Nút đặt lại zoom khi đang phóng to cận cảnh */}
        {mainZoom > 1.05 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMainZoom(1.0);
              setMainPan({ x: 0, y: 0 });
            }}
            className="absolute top-3 left-1/2 -translate-x-1/2 z-40 px-3 py-1 rounded-full bg-indigo-600/90 hover:bg-indigo-500 text-white text-xs font-mono font-bold shadow-xl backdrop-blur flex items-center space-x-1.5 border border-indigo-400 active:scale-95 cursor-pointer animate-fadeIn"
            title="Bấm để đưa về kích thước chuẩn 1x"
          >
            <ZoomIn className="w-3.5 h-3.5 text-amber-300" />
            <span>Zoom: {mainZoom}x (Chạm để về 1x)</span>
          </button>
        )}

        {textOverlays.map((item) => (
          <div
            key={item.id}
            data-text-overlay="true"
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
        {/* Thẻ 2: HLS DVR Replay & HLS Live Fallback (MÀN HÌNH TO KHI TUA) */}
        <video
          ref={replayVideoRef}
          className={`w-full h-full object-contain bg-black transition-opacity duration-150 ${
            (!isLive || !hasLiveFrame) && hasFrame ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
          }`}
          style={{
            transform: !isLive
              ? `translate(${mainPan.x}px, ${mainPan.y}px) scale(${mainZoom}) scaleX(${isFlipped ? -1 : 1}) rotate(${rotation}deg) scale(${rotation % 180 === 0 ? 1 : (sourceIsPortrait ? 16 / 9 : 9 / 16)})`
              : `scaleX(${isFlipped ? -1 : 1}) rotate(${rotation}deg) scale(${rotation % 180 === 0 ? 1 : (sourceIsPortrait ? 16 / 9 : 9 / 16)})`,
            transition: 'transform 0.1s ease-out',
            position: 'absolute',
            inset: 0
          }}
          crossOrigin="anonymous"
          playsInline
          muted={true}
        />

        {/* Thẻ 1: Live WebRTC
            - Khi LIVE: Màn hình to toàn bộ.
            - Khi TUA: Cửa sổ PiP nhỏ có thể kéo thả di chuyển tự do (sang trái/phải), chỉnh to/nhỏ linh hoạt */}
        <div
          data-pip-window={!isLive && hasLiveFrame ? 'true' : undefined}
          onMouseDown={(e) => {
            if (!isLive) {
              e.preventDefault();
              handlePipMouseDown(e.clientX, e.clientY);
            }
          }}
          onTouchStart={(e) => {
            if (!isLive) {
              handlePipTouchStart(e);
            }
          }}
          style={
            !isLive && hasLiveFrame
              ? {
                  position: 'absolute',
                  left: pipPos ? `${pipPos.xPercent}%` : undefined,
                  right: pipPos ? undefined : '0.75rem',
                  top: pipPos ? `${pipPos.yPercent}%` : '0.75rem',
                  width: `${pipWidth}px`,
                  zIndex: 35,
                  cursor: isPipDragging ? 'grabbing' : 'grab',
                  touchAction: 'none',
                }
              : undefined
          }
          className={`select-none ${
            isLive
              ? 'absolute inset-0 w-full h-full z-10 pointer-events-auto'
              : (hasLiveFrame
                  ? 'aspect-[9/16] sm:aspect-video rounded-xl sm:rounded-2xl overflow-hidden shadow-2xl border-2 border-red-500/90 bg-black group ring-4 ring-black/70 shadow-black'
                  : 'opacity-0 pointer-events-none absolute')
          } ${isPipDragging ? '' : 'transition-[top,left] duration-150 ease-out'}`}
          title={!isLive ? 'Kéo để di chuyển, chạm để về Live' : undefined}
        >
          <video
            ref={liveVideoRef}
            className={`w-full h-full object-contain bg-black pointer-events-none ${
              isLive && !hasLiveFrame ? 'opacity-0' : 'opacity-100'
            }`}
            style={{
              transform: isLive
                ? `translate(${mainPan.x}px, ${mainPan.y}px) scale(${mainZoom}) scaleX(${isFlipped ? -1 : 1}) rotate(${rotation}deg) scale(${rotation % 180 === 0 ? 1 : (sourceIsPortrait ? 16 / 9 : 9 / 16)})`
                : `scaleX(${isFlipped ? -1 : 1}) rotate(${rotation}deg) scale(${rotation % 180 === 0 ? 1 : (sourceIsPortrait ? 16 / 9 : 9 / 16)})`,
              transition: 'transform 0.1s ease-out'
            }}
            crossOrigin="anonymous"
            playsInline
            muted={isMuted}
            autoPlay
          />

          {/* Huy hiệu và thanh công cụ điều khiển trên màn nhỏ PiP */}
          {!isLive && hasLiveFrame && (
            <>
              {/* Nhãn LIVE nhấp nháy ở góc trên-trái */}
              <div className="absolute top-1.5 left-1.5 flex items-center space-x-1 px-1.5 py-0.5 rounded-md bg-red-600/90 text-white font-bold text-[9px] sm:text-[10px] uppercase shadow tracking-wider pointer-events-none">
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
                <span>LIVE</span>
              </div>

              {/* Các nút bấm nhanh ở góc trên-phải: Đổi góc Trái/Phải & Đổi kích thước To/Nhỏ */}
              <div className="absolute top-1.5 right-1.5 flex items-center space-x-1 z-40">
                {/* Nút chuyển nhanh góc Trái <-> Phải */}
                <button
                  type="button"
                  onClick={togglePipCorner}
                  onTouchEnd={togglePipCorner}
                  className="p-1 rounded-md bg-black/70 hover:bg-black/95 text-slate-200 hover:text-white backdrop-blur border border-white/20 shadow active:scale-95 cursor-pointer"
                  title="Chuyển góc Trái / Phải"
                >
                  <ArrowLeftRight className="w-3 h-3 text-amber-300" />
                </button>

                {/* Nút đổi kích thước To / Vừa / Nhỏ */}
                <button
                  type="button"
                  onClick={cyclePipSize}
                  onTouchEnd={cyclePipSize}
                  className="p-1 rounded-md bg-black/70 hover:bg-black/95 text-slate-200 hover:text-white backdrop-blur border border-white/20 shadow active:scale-95 cursor-pointer"
                  title="Đổi kích thước To/Nhỏ"
                >
                  <Maximize className="w-3 h-3 text-emerald-300" />
                </button>
              </div>

              {/* Tay nắm kéo góc dưới-phải để kéo giãn to/nhỏ tự do */}
              <div
                onMouseDown={handlePipResizeStart}
                onTouchStart={handlePipResizeStart}
                className="absolute bottom-0 right-0 w-6 h-6 flex items-end justify-end p-1 cursor-nwse-resize z-40 hover:opacity-100 opacity-70 active:opacity-100"
                title="Kéo góc để phóng to/thu nhỏ"
              >
                <div className="w-2.5 h-2.5 border-r-2 border-b-2 border-amber-400 rounded-br-sm" />
              </div>
            </>
          )}
        </div>

        {!hasFrame && !hasLiveFrame && (
          <div className="flex flex-col items-center justify-center p-3 sm:p-6 text-center space-y-1.5 sm:space-y-2 text-slate-500 z-20">
            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-slate-900 border border-white/10 flex items-center justify-center text-indigo-400 animate-pulse">
              <Camera className="w-5 h-5 sm:w-6 sm:h-6" />
            </div>
            <p className="text-xs sm:text-sm font-medium text-slate-300">
              {stream ? 'Đang kết nối tín hiệu trực tiếp (120/240fps)...' : 'Đang chờ điện thoại phát trực tiếp...'}
            </p>
            {!stream && (
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
            )}
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
            <div className={`w-auto min-w-[260px] sm:min-w-[460px] max-w-[92vw] text-center px-4 py-4 sm:px-10 sm:py-8 rounded-3xl font-mono border-4 shadow-2xl backdrop-blur-xl transition-all animate-scaleIn ${
              modeNotice === 'slow'
                ? 'bg-amber-500/95 text-slate-950 border-amber-100 shadow-amber-500/50'
                : 'bg-red-600/95 text-white border-red-100 shadow-red-500/50'
            }`}>
              <div className="font-black text-xl sm:text-4xl tracking-wide">
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

        {/* Hàng ảnh chụp đang chờ gửi */}
        {capturedFrames.length > 0 && (
          <div className="flex items-center space-x-2 px-2 py-1.5 bg-purple-950/60 border border-purple-500/40 rounded-xl overflow-x-auto no-scrollbar animate-fadeIn">
            <span className="text-[11px] font-bold text-purple-200 flex-shrink-0">
              Đã chụp ({capturedFrames.length}):
            </span>
            <div className="flex items-center space-x-1.5 flex-1 overflow-x-auto no-scrollbar py-0.5">
              {capturedFrames.map((thumb, idx) => (
                <div key={idx} className="relative group flex-shrink-0">
                  <img
                    src={thumb}
                    alt={`#${idx + 1}`}
                    className="w-12 h-8 object-cover rounded-md border border-purple-400/60 shadow-sm"
                  />
                  <span className="absolute bottom-0 left-0 bg-black/80 text-[9px] font-mono font-bold text-purple-200 px-1 rounded-tr">
                    #{idx + 1}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveSnap(idx);
                    }}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 hover:bg-red-500 text-white flex items-center justify-center text-[10px] shadow leading-none font-bold"
                    title="Xoá ảnh này"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={handleClearSnaps}
              className="text-[10px] text-slate-400 hover:text-red-400 px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 font-medium flex-shrink-0 transition-colors"
              title="Xoá tất cả"
            >
              Xoá hết
            </button>
          </div>
        )}

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
              type="button"
              onClick={toggleFlip}
              className={`px-2 py-1 rounded-lg border text-xs font-medium flex items-center space-x-1 transition-all ${
                isFlipped
                  ? 'bg-amber-500/25 text-amber-300 border-amber-500/50 shadow-sm ring-1 ring-amber-400/40'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-white/10'
              }`}
              title="Lật ngược hình ảnh ngang (Phím M hoặc F: Chống chữ bị ngược khi quay Camera trước)"
            >
              <FlipHorizontal className="w-3.5 h-3.5 text-amber-400" />
              <span>{isFlipped ? 'Đã Lật' : 'Lật Ảnh'}</span>
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

            {/* Cụm công cụ AI: Chụp -> Gom ảnh -> Gửi */}
            <div className="inline-flex items-center rounded-xl bg-gradient-to-r from-purple-950/80 to-indigo-950/80 p-0.5 border border-purple-500/40 shadow-sm space-x-0.5">
              {/* Nút Chụp ảnh lưu vào queue */}
              <button
                type="button"
                onClick={handleSnapCard}
                disabled={isBatchSending}
                className="px-2.5 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs flex items-center space-x-1.5 transition-all shadow-md active:scale-95 disabled:opacity-50"
                title="Chụp lưu lại hình ảnh (Phím C)"
              >
                <Camera className="w-3.5 h-3.5 text-amber-300" />
                <span>Chụp{capturedFrames.length > 0 ? ` (${capturedFrames.length})` : ''}</span>
              </button>

              {/* Nút Gửi: Luôn sáng và sẵn sàng khi đã có ảnh */}
              {capturedFrames.length > 0 && (
                <button
                  type="button"
                  onClick={handleSendBatch}
                  disabled={isBatchSending}
                  className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center space-x-1.5 transition-all shadow-md active:scale-95 disabled:opacity-50 animate-pulse"
                  title="Đóng gói tất cả ảnh đã chụp gửi AI nhận diện"
                >
                  {isBatchSending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5 text-amber-200" />
                  )}
                  <span>{isBatchSending ? 'Đang gửi...' : `Gửi (${capturedFrames.length})`}</span>
                </button>
              )}

              {/* Nút Xoá queue nếu có ảnh */}
              {capturedFrames.length > 0 && !isBatchSending && (
                <button
                  type="button"
                  onClick={handleClearSnaps}
                  className="p-1 rounded-md text-slate-400 hover:text-red-400 hover:bg-red-950/30 text-xs transition-colors"
                  title="Xoá tất cả ảnh đã chụp"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}

              {/* Nút Cài đặt Key */}
              <button
                type="button"
                onClick={handleOpenSettings}
                className={`p-1 rounded-md text-xs transition-colors ml-0.5 ${
                  aiApiKey
                    ? 'text-purple-300 hover:text-white hover:bg-purple-800/50'
                    : 'text-amber-400 hover:text-amber-200 hover:bg-amber-800/50 animate-bounce'
                }`}
                title={aiApiKey ? `Cài đặt AI (${aiProvider === 'modelapi' ? 'modelapi.vn' : 'Gemini'})` : 'Chưa có API Key - Bấm để cấu hình'}
              >
                <Key className="w-3.5 h-3.5" />
              </button>
            </div>

            {onFinishRound && (
              <button
                type="button"
                onClick={() => {
                  handleRoundFinished();
                  onFinishRound();
                }}
                className="px-2.5 py-1 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs shadow-md shadow-emerald-600/30 flex items-center space-x-1 transition-all active:scale-95 ml-auto sm:ml-1"
                title="Làm mới bộ nhớ và bắt đầu phiên mới"
              >
                <CheckCircle2 className="w-3 h-3 text-amber-300" />
                <span>Xong Phiên</span>
              </button>
            )}
          </div>

          {/* Slow Motion Speed Controls & Nút Về Live */}
          <div className="flex items-center space-x-1 bg-slate-950/70 p-1 rounded-xl border border-white/10 relative flex-shrink-0">
            {/* Nút VỀ LIVE to nổi bật khi đang xem Replay */}
            {!isLive ? (
              <button
                type="button"
                onClick={jumpToLive}
                className="px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white font-black text-[11px] shadow-md shadow-red-600/40 flex items-center space-x-1.5 transition-all active:scale-95 animate-pulse flex-shrink-0 border border-red-400"
                title="Quay lại phát trực tiếp thời gian thực (<0.2s)"
              >
                <Radio className="w-3.5 h-3.5 animate-spin" />
                <span>VỀ LIVE</span>
              </button>
            ) : (
              <div className="flex items-center space-x-1 px-1.5 py-0.5 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 text-[10px] font-bold flex-shrink-0">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-ping inline-block" />
                <span>LIVE</span>
              </div>
            )}

            {/* Menu chọn tốc độ Custom chuẩn YouTube (KHÔNG dùng thẻ select để tránh iPad văng fullscreen) */}
            <div ref={speedMenuRef} className="relative flex items-center space-x-1 flex-shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsSpeedMenuOpen(!isSpeedMenuOpen);
                }}
                className={`px-2 py-1 rounded-lg border text-xs font-mono font-bold flex items-center space-x-1.5 transition-all cursor-pointer shadow-sm active:scale-95 ${
                  isSpeedMenuOpen
                    ? 'bg-indigo-600 text-white border-indigo-400 ring-2 ring-indigo-400/50'
                    : 'bg-slate-800 hover:bg-slate-700 text-indigo-300 border-indigo-500/40'
                }`}
                title="Chọn tốc độ phát lại (Slow-Motion)"
              >
                <Gauge className="w-3.5 h-3.5 text-indigo-400" />
                <span>{isLive ? '1.0x' : (playbackRate === 0.0625 ? '1/16x' : `${playbackRate}x`)}</span>
              </button>

              {/* Popover danh sách tốc độ mở hướng lên trên giống YouTube */}
              {isSpeedMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-[100] bg-transparent"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsSpeedMenuOpen(false);
                    }}
                    onTouchEnd={(e) => {
                      e.stopPropagation();
                      setIsSpeedMenuOpen(false);
                    }}
                  />
                  <div
                    className="absolute bottom-full right-0 mb-2 w-48 bg-slate-900/98 backdrop-blur-xl border border-indigo-500/50 rounded-xl shadow-2xl p-1 z-[101] space-y-0.5 animate-fadeIn"
                    onClick={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                  >
                    <div className="text-[10px] font-bold text-slate-400 px-2 py-1 border-b border-white/10 uppercase tracking-wider flex items-center justify-between">
                      <span>Tốc độ phát</span>
                      <span className="text-amber-400 font-mono">Slow</span>
                    </div>
                    <div className="max-h-56 overflow-y-auto no-scrollbar py-0.5 space-y-0.5">
                      {speedOptions.map((rate) => {
                        const isCurrent = (!isLive && playbackRate === rate) || (isLive && rate === 1.0);
                        const label =
                          rate === 0.0625 ? '1/16x (Siêu chậm)' :
                          rate === 0.1   ? '0.1x (Cực chậm)'   :
                          rate === 0.125 ? '1/8x (Rất chậm)'   :
                          rate === 0.25  ? '0.25x (Chậm)'       :
                          rate === 0.5   ? '0.5x (Nửa tốc)'    :
                          rate === 0.75  ? '0.75x (Hơi chậm)'  :
                                          '1.0x (Bình thường)';
                        return (
                          <button
                            key={rate}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSpeedChange(rate);
                              setIsSpeedMenuOpen(false);
                            }}
                            className={`w-full text-left px-2 py-1.5 rounded-lg text-xs font-medium font-mono flex items-center justify-between transition-colors cursor-pointer ${
                              isCurrent
                                ? 'bg-indigo-600 text-white font-bold shadow-sm'
                                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                            }`}
                          >
                            <span>{label}</span>
                            {isCurrent && <span className="text-amber-300 font-black text-xs">✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Nút Âm thanh Live (Bật / Tắt tiếng) */}
            <button
              type="button"
              onClick={() => {
                const nextMuted = !isMuted;
                setIsMuted(nextMuted);
                if (liveVideoRef.current) {
                  liveVideoRef.current.muted = nextMuted;
                }
              }}
              className={`p-1.5 rounded-lg border transition-all flex items-center justify-center flex-shrink-0 cursor-pointer shadow-sm active:scale-95 ${
                !isMuted
                  ? 'bg-emerald-600 text-white border-emerald-400 ring-2 ring-emerald-400/40'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-white/10'
              }`}
              title={isMuted ? 'Bật âm thanh Trực Tiếp' : 'Tắt tiếng'}
            >
              {isMuted ? (
                <VolumeX className="w-3.5 h-3.5 text-slate-400" />
              ) : (
                <Volume2 className="w-3.5 h-3.5 text-emerald-300 animate-pulse" />
              )}
            </button>

            {/* Menu Chọn Độ Phân Giải (HD 720p / SD 480p / 360p Siêu Mượt) */}
            <div ref={resMenuRef} className="relative flex items-center space-x-1 flex-shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsResMenuOpen(!isResMenuOpen);
                }}
                className={`px-2 py-1 rounded-lg border text-xs font-mono font-bold flex items-center space-x-1 transition-all cursor-pointer shadow-sm active:scale-95 ${
                  selectedResolution === '360p'
                    ? 'bg-emerald-600/30 text-emerald-300 border-emerald-500/50'
                    : (selectedResolution === '480p'
                        ? 'bg-amber-600/30 text-amber-300 border-amber-500/50'
                        : 'bg-slate-800 hover:bg-slate-700 text-cyan-300 border-cyan-500/40')
                }`}
                title="Chọn độ phân giải (360p siêu nhẹ mượt, 480p cân bằng, 720p sắc nét - tất cả đều 60fps)"
              >
                <span>
                  {selectedResolution === '360p' ? '360p 60fps' : (selectedResolution === '480p' ? '480p 60fps' : '720p 60fps')}
                </span>
              </button>

              {isResMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-[100] bg-transparent"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsResMenuOpen(false);
                    }}
                    onTouchEnd={(e) => {
                      e.stopPropagation();
                      setIsResMenuOpen(false);
                    }}
                  />
                  <div
                    className="absolute bottom-full right-0 mb-2 w-52 bg-slate-900/98 backdrop-blur-xl border border-cyan-500/50 rounded-xl shadow-2xl p-1 z-[101] space-y-0.5 animate-fadeIn"
                    onClick={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                  >
                    <div className="text-[10px] font-bold text-slate-400 px-2 py-1 border-b border-white/10 uppercase tracking-wider flex items-center justify-between">
                      <span>Độ phân giải (Full 60fps)</span>
                      <span className="text-cyan-400 font-mono">Live</span>
                    </div>
                    <div className="py-0.5 space-y-0.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedResolution('720p');
                          setIsResMenuOpen(false);
                        }}
                        className={`w-full text-left px-2 py-1.5 rounded-lg text-xs font-medium font-mono flex items-center justify-between transition-colors cursor-pointer ${
                          selectedResolution === '720p'
                            ? 'bg-cyan-600 text-white font-bold shadow-sm'
                            : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                        }`}
                      >
                        <div>
                          <div>HD (720p 60fps)</div>
                          <div className="text-[10px] text-cyan-200 opacity-80">Sắc nét nhất</div>
                        </div>
                        {selectedResolution === '720p' && <span className="text-amber-300 font-black text-xs">✓</span>}
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedResolution('480p');
                          setIsResMenuOpen(false);
                        }}
                        className={`w-full text-left px-2 py-1.5 rounded-lg text-xs font-medium font-mono flex items-center justify-between transition-colors cursor-pointer ${
                          selectedResolution === '480p'
                            ? 'bg-amber-600 text-white font-bold shadow-sm'
                            : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                        }`}
                      >
                        <div>
                          <div>SD (480p 60fps)</div>
                          <div className="text-[10px] text-amber-200 opacity-80">Mượt mà, siêu nhẹ dữ liệu</div>
                        </div>
                        {selectedResolution === '480p' && <span className="text-amber-300 font-black text-xs">✓</span>}
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedResolution('360p');
                          setIsResMenuOpen(false);
                        }}
                        className={`w-full text-left px-2 py-1.5 rounded-lg text-xs font-medium font-mono flex items-center justify-between transition-colors cursor-pointer ${
                          selectedResolution === '360p'
                            ? 'bg-emerald-600 text-white font-bold shadow-sm'
                            : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                        }`}
                      >
                        <div>
                          <div className="flex items-center space-x-1">
                            <span>Siêu Mượt (360p 60fps)</span>
                            <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-400 text-black font-black uppercase">Nhẹ</span>
                          </div>
                          <div className="text-[10px] text-emerald-200 opacity-80">Mạng 3G/yếu mượt 100%, không cắt frame</div>
                        </div>
                        {selectedResolution === '360p' && <span className="text-amber-300 font-black text-xs">✓</span>}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Nút Phóng to toàn màn hình như YouTube */}
            <button
              type="button"
              onClick={toggleFullscreen}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-white/10 transition-all flex items-center justify-center flex-shrink-0 cursor-pointer shadow-sm active:scale-95"
              title={isFullscreen ? 'Thu nhỏ (F hoặc Esc)' : 'Toàn màn hình (F)'}
            >
              {isFullscreen ? (
                <Minimize className="w-3.5 h-3.5 text-amber-300" />
              ) : (
                <Maximize className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Modal Popup Chèn Chữ Lên Video */}
      {isTextOverlayOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 animate-fadeIn">
          <div className="bg-slate-900 border border-amber-500/40 rounded-2xl max-w-sm sm:max-w-md w-full p-3.5 sm:p-4 space-y-2.5 shadow-2xl">
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

      {/* Modal Cài Đặt AI & API Key */}
      {isKeyModalOpen && (
        <div className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 animate-fadeIn">
          <div className="bg-slate-900 border border-purple-500/40 rounded-2xl max-w-sm sm:max-w-md w-full p-4 sm:p-5 space-y-3.5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 rounded-xl bg-purple-600/30 border border-purple-500/40 flex items-center justify-center text-purple-300">
                  <Key className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-white">Cài đặt AI Nhận Diện Bài</h3>
                  <p className="text-[11px] text-slate-400">Chọn API trung gian hoặc Google Gemini chính thống</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsKeyModalOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveSettings} className="space-y-3">
              {/* Chọn Nhà Cung Cấp (Provider) */}
              <div>
                <label className="text-xs font-bold text-slate-200 block mb-1.5">
                  Lựa chọn dịch vụ AI:
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setTempProvider('modelapi')}
                    className={`px-2.5 py-2 rounded-xl border text-xs font-medium flex flex-col items-center justify-center space-y-1 transition-all ${
                      tempProvider === 'modelapi'
                        ? 'bg-purple-600/30 text-purple-200 border-purple-500 shadow-sm ring-1 ring-purple-400'
                        : 'bg-slate-950/60 text-slate-400 border-white/10 hover:bg-slate-800'
                    }`}
                  >
                    <span className="font-bold flex items-center space-x-1">
                      <span>🇻🇳 modelapi.vn</span>
                    </span>
                    <span className="text-[10px] text-slate-400">API Trung Gian (VN)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setTempProvider('gemini')}
                    className={`px-2.5 py-2 rounded-xl border text-xs font-medium flex flex-col items-center justify-center space-y-1 transition-all ${
                      tempProvider === 'gemini'
                        ? 'bg-purple-600/30 text-purple-200 border-purple-500 shadow-sm ring-1 ring-purple-400'
                        : 'bg-slate-950/60 text-slate-400 border-white/10 hover:bg-slate-800'
                    }`}
                  >
                    <span className="font-bold flex items-center space-x-1">
                      <span>⚡ Google Gemini</span>
                    </span>
                    <span className="text-[10px] text-slate-400">Chính Thống (~800ms)</span>
                  </button>
                </div>
              </div>

              {/* Cấu hình cho modelapi.vn */}
              {tempProvider === 'modelapi' ? (
                <div className="space-y-2.5 bg-slate-950/60 p-3 rounded-xl border border-white/5">
                  <div>
                    <label className="text-[11px] font-bold text-slate-300 block mb-1">
                      API Base URL:
                    </label>
                    <input
                      type="text"
                      value={tempBaseUrl}
                      onChange={(e) => setTempBaseUrl(e.target.value)}
                      placeholder="https://modelapi.vn/v1"
                      className="w-full bg-slate-900 text-white font-mono text-xs px-2.5 py-1.5 rounded-lg border border-purple-500/40 focus:outline-none focus:border-purple-400"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] font-bold text-slate-300">
                        Tên Model:
                      </label>
                      <div className="flex items-center space-x-1">
                        {['gpt-4o-mini', 'gemini-1.5-flash', 'gemini-2.0-flash'].map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setTempModel(m)}
                            className={`text-[9px] px-1.5 py-0.5 rounded font-mono transition-colors ${
                              tempModel === m ? 'bg-purple-600 text-white font-bold' : 'bg-slate-800 text-slate-400 hover:text-white'
                            }`}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    </div>
                    <input
                      type="text"
                      value={tempModel}
                      onChange={(e) => setTempModel(e.target.value)}
                      placeholder="gpt-4o-mini"
                      className="w-full bg-slate-900 text-white font-mono text-xs px-2.5 py-1.5 rounded-lg border border-purple-500/40 focus:outline-none focus:border-purple-400"
                    />
                    <span className="text-[10px] text-slate-500 italic block mt-0.5">
                      Khuyên dùng: <strong>gpt-4o-mini</strong> (siêu nhanh, rẻ, nhận diện bài cực chuẩn)
                    </span>
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-slate-300 block mb-1">
                      API Key (modelapi.vn):
                    </label>
                    <input
                      type="password"
                      value={tempApiKey}
                      onChange={(e) => setTempApiKey(e.target.value)}
                      placeholder="sk-..."
                      className="w-full bg-slate-900 text-white font-mono text-xs px-2.5 py-1.5 rounded-lg border border-purple-500/40 focus:outline-none focus:border-purple-400"
                    />
                  </div>

                  <div className="text-[10px] text-slate-400 pt-1 border-t border-white/5">
                    💡 Đăng ký và nạp tiền VNĐ dễ dàng tại <a href="https://modelapi.vn" target="_blank" rel="noreferrer" className="text-purple-400 hover:underline font-bold">modelapi.vn</a>.
                  </div>
                </div>
              ) : (
                <div className="space-y-2.5 bg-slate-950/60 p-3 rounded-xl border border-white/5">
                  <div>
                    <label className="text-[11px] font-bold text-slate-300 block mb-1">
                      Google Gemini API Key:
                    </label>
                    <input
                      type="password"
                      value={tempApiKey}
                      onChange={(e) => setTempApiKey(e.target.value)}
                      placeholder="AIzaSy... hoặc AQ...."
                      className="w-full bg-slate-900 text-white font-mono text-xs px-2.5 py-1.5 rounded-lg border border-purple-500/40 focus:outline-none focus:border-purple-400"
                    />
                  </div>

                  <div className="text-[10px] text-slate-400 space-y-1">
                    <p className="text-emerald-300 font-medium">⚡ Tối ưu tốc độ cao:</p>
                    <p>
                      Hệ thống tự động chọn model nhẹ & nhanh nhất mà key của bạn hỗ trợ (ưu tiên <strong>gemini-3.5-flash-lite</strong> tốc độ ~800ms).
                    </p>
                    <p>
                      Lấy key miễn phí tại <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer" className="text-purple-400 hover:underline font-bold">aistudio.google.com</a>.
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end space-x-2 pt-1 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => setIsKeyModalOpen(false)}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs font-bold shadow-md shadow-purple-600/30 active:scale-95"
                >
                  Lưu Cài Đặt
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Popup Hiển Thị Kết Quả */}
      {isResultOpen && (
        <div className="fixed inset-0 z-[110] bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 animate-fadeIn">
          <div className="bg-slate-900 border border-purple-500/50 rounded-2xl max-w-lg w-full p-4 sm:p-5 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div className="flex items-center space-x-2.5">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-purple-600/40">
                  <Sparkles className="w-4 h-4 text-amber-300" />
                </div>
                <div>
                  <div className="flex items-center space-x-2">
                    <h3 className="font-bold text-sm text-white">AI Nhận Diện</h3>
                    {batchElapsedMs && (
                      <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        ⚡ {(batchElapsedMs / 1000).toFixed(2)}s
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Gemini Flash Lite • 1 Request Đóng Gói
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsResultOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Trạng thái đang nhận diện */}
            {isBatchSending && (
              <div className="py-8 flex flex-col items-center justify-center space-y-3 text-center">
                <div className="relative">
                  <Loader2 className="w-10 h-10 animate-spin text-purple-400" />
                  <Sparkles className="w-4 h-4 text-amber-300 absolute -top-1 -right-1 animate-pulse" />
                </div>
                <div className="space-y-1">
                  <div className="font-bold text-sm text-white">
                    Đang xử lý {capturedFrames.length > 0 ? `${capturedFrames.length} ảnh` : ''}...
                  </div>
                  <div className="text-xs text-purple-300">Nhận diện siêu tốc song song trong 1 request</div>
                </div>
              </div>
            )}

            {/* Lỗi khi nhận diện */}
            {!isBatchSending && batchError && (
              <div className="p-3.5 bg-rose-950/40 border border-rose-500/40 rounded-xl space-y-2.5">
                <div className="text-xs text-rose-300 font-medium">
                  ⚠️ {batchError}
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsResultOpen(false);
                      handleOpenSettings();
                    }}
                    className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs flex items-center space-x-1"
                  >
                    <Key className="w-3.5 h-3.5" />
                    <span>Cài đặt AI & API Key</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleSendBatch}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium"
                  >
                    Thử lại
                  </button>
                </div>
              </div>
            )}

            {/* Hiển thị kết quả */}
            {!isBatchSending && !batchError && batchResults && (
              <div className="space-y-3.5">
                {/* Header thanh tóm tắt */}
                <div className="flex items-center justify-between bg-slate-950/60 p-2.5 rounded-xl border border-white/5">
                  <div className="flex items-center space-x-2">
                    <span className="text-xs font-bold text-slate-300">
                      Tổng cộng: <span className="text-amber-300 font-mono text-sm">{batchResults.length} ảnh</span>
                    </span>
                    {batchElapsedMs && (
                      <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        ⚡ {batchElapsedMs}ms
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={copyBatchResult}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center space-x-1.5 transition-all shadow-sm ${
                      copiedResult
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-800 hover:bg-slate-700 text-purple-300 border border-purple-500/30'
                    }`}
                  >
                    {copiedResult ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedResult ? 'Đã chép!' : 'Sao chép'}</span>
                  </button>
                </div>

                {/* Danh sách thẻ kết quả */}
                {batchResults.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5 max-h-[50vh] overflow-y-auto pr-1">
                    {batchResults.map((item, idx) => {
                      const isUnseen = item.status === 'unseen' || item.code === 'NONE';
                      const isRed = item.color === 'red' || item.suit === 'Heart' || item.suit === 'Diamond';
                      const thumb = capturedFrames[idx];

                      return (
                        <div
                          key={idx}
                          className={`rounded-xl border p-2 flex flex-col justify-between items-center transition-all select-none ${
                            isUnseen
                              ? 'bg-slate-950/90 border-slate-700/60'
                              : 'bg-white border-slate-200 shadow-md'
                          }`}
                          style={{ minHeight: '110px' }}
                        >
                          {/* Hàng trên: Số thứ tự + Ảnh chụp góc thu nhỏ */}
                          <div className="w-full flex items-center justify-between mb-1">
                            <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                              isUnseen ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-700'
                            }`}>
                              #{idx + 1}
                            </span>
                            {thumb && (
                              <img
                                src={thumb}
                                alt={`#${idx + 1}`}
                                className="w-9 h-6 object-cover rounded border border-white/20"
                              />
                            )}
                          </div>

                          {/* Chính giữa: Token hiển thị */}
                          {isUnseen ? (
                            <div className="my-auto py-2 text-center">
                              <span className="text-xs font-semibold text-slate-400 bg-slate-900/90 px-2 py-1 rounded-md border border-slate-700/60 inline-block">
                                Không thấy
                              </span>
                            </div>
                          ) : (
                            <div className="my-auto py-1 text-center">
                              <div className={`text-2xl sm:text-3xl font-black font-mono leading-none tracking-tight ${isRed ? 'text-red-600' : 'text-slate-950'}`}>
                                {item.display || `${item.rank}${item.symbol}`}
                              </div>
                            </div>
                          )}

                          {/* Hàng dưới: Badge trạng thái */}
                          <div className="w-full text-center pt-1 border-t border-slate-100/10">
                            <span className={`text-[11px] font-bold ${
                              isUnseen ? 'text-slate-500' : (isRed ? 'text-red-600' : 'text-slate-800')
                            }`}>
                              {isUnseen ? '—' : (item.display || `${item.rank}${item.symbol}`)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-6 text-slate-400 text-xs bg-slate-950/40 rounded-xl border border-white/5 space-y-2">
                    <p>Không có dữ liệu.</p>
                  </div>
                )}

                {/* Chuỗi tóm tắt dạng text để copy nhanh */}
                <div className="bg-slate-950 p-2.5 rounded-xl border border-purple-500/20 flex items-center justify-between">
                  <div className="text-xs font-mono font-bold text-amber-300 truncate mr-2">
                    {batchResults
                      .map((c) => (c.status === 'unseen' || c.code === 'NONE' ? 'Không thấy' : (c.display || `${c.rank}${c.symbol}`)))
                      .join(', ')}
                  </div>
                  <span className="text-[10px] text-slate-500 uppercase font-mono flex-shrink-0">Tóm tắt</span>
                </div>

                {/* Footer Buttons */}
                <div className="flex items-center justify-between pt-2 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => {
                      handleClearSnaps();
                      setIsResultOpen(false);
                    }}
                    className="px-3 py-1.5 rounded-xl bg-purple-600/30 hover:bg-purple-600/50 text-purple-200 text-xs font-medium flex items-center space-x-1.5 transition-colors border border-purple-500/30"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Phiên mới</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsResultOpen(false)}
                    className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs transition-colors"
                  >
                    Đóng
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

