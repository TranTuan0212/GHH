import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Socket } from 'socket.io-client';
import {
  Play,
  Pause,
  RotateCcw,
  SkipBack,
  SkipForward,
  Gauge,
  Maximize2,
  Volume2,
  VolumeX,
  Radio,
  Zap,
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

// Hàm xác định chính xác Server URL hiển thị & sao chép (tự động phân biệt Wi-Fi nội bộ và Cloudflare Tunnel HTTPS)
function resolveServerUrl(serverUrlFromServer?: string): string {
  if (typeof window === 'undefined') return 'http://localhost:4000';
  const host = window.location.hostname;
  const protocol = window.location.protocol;

  // 1. Nếu đang truy cập qua Cloudflare Tunnel hoặc tên miền HTTPS ra ngoài Internet:
  if (host.includes('trycloudflare.com') || host.includes('ngrok') || protocol === 'https:') {
    return `https://${host}`;
  }

  // 2. Nếu truy cập qua IP LAN Wi-Fi
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return `http://${host}:4000`;
  }

  // 3. Nếu đang ở localhost: dùng IP LAN backend trả về để điện thoại dễ kết nối
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);

  const [currentFrame, setCurrentFrame] = useState<string | null>(null);
  const [frameHistory, setFrameHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  const [isPlaying, setIsPlaying] = useState(true);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [isLive, setIsLive] = useState(true);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [rotation, setRotation] = useState<number>(0);

  // Text Overlays state (Draggable text over video)
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

  // Save overlays to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('live_text_overlays_' + (roomId || 'default'), JSON.stringify(textOverlays));
    } catch {}
  }, [textOverlays, roomId]);

  // Load overlays when roomId changes
  useEffect(() => {
    try {
      const saved = localStorage.getItem('live_text_overlays_' + (roomId || 'default'));
      setTextOverlays(saved ? JSON.parse(saved) : []);
    } catch {}
  }, [roomId]);

  // Add new text overlay from input
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

  // Mouse & Touch Drag Handlers
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

  // Dynamic Host / LAN IP detection for mobile pairing
  const [detectedServerUrl, setDetectedServerUrl] = useState<string>(() => resolveServerUrl());
  const [copied, setCopied] = useState(false);

  // Fetch real LAN IP from backend API
  useEffect(() => {
    fetch('/api/server-info')
      .then((res) => res.json())
      .then((data) => {
        if (data && data.serverUrl) {
          setDetectedServerUrl(resolveServerUrl(data.serverUrl));
        }
      })
      .catch(() => {});
  }, []);

  const handleCopyServerUrl = () => {
    navigator.clipboard.writeText(detectedServerUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  // Fallback demo video stream URL if HLS server is standalone
  const defaultStreamUrl = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

  // Reset video buffer whenever switching rooms
  useEffect(() => {
    setFrameHistory([]);
    setHistoryIndex(-1);
    setCurrentFrame(null);
    setIsLive(true);
  }, [roomId]);

  // Listen to Realtime Video Frames from iPhone
  useEffect(() => {
    if (!socket) return;

    const handleNewFrame = (data: { frame: string; timestamp: number; roomId?: string }) => {
      if (data && data.roomId && roomId && data.roomId !== roomId) return;
      if (data && data.frame) {
        setFrameHistory((prev) => {
          const next = [...prev, data.frame];
          if (next.length > 600) next.shift(); // Keep last 600 frames for DVR
          return next;
        });

        if (isLive) {
          setCurrentFrame(data.frame);
        }
      }
    };

    const handleRoundFinished = (data?: { roomId?: string }) => {
      if (data && data.roomId && roomId && data.roomId !== roomId) return;
      setFrameHistory([]);
      setHistoryIndex(-1);
      setIsLive(true);
      setCurrentFrame(null);
    };

    const handleInitialState = (data: any) => {
      if (data && data.roomId && roomId && data.roomId !== roomId) return;
      if (data && data.serverUrl) {
        setDetectedServerUrl(resolveServerUrl(data.serverUrl));
      }
      if (data && data.dvrFrames && Array.isArray(data.dvrFrames)) {
        const frames = data.dvrFrames.map((f: any) => f.frame).filter(Boolean);
        if (frames.length > 0) {
          setFrameHistory(frames);
          setCurrentFrame(frames[frames.length - 1]);
        }
      }
    };

    socket.on('initial_state', handleInitialState);
    socket.on('live_frame_received', handleNewFrame);
    socket.on('round_finished', handleRoundFinished);

    return () => {
      socket.off('initial_state', handleInitialState);
      socket.off('live_frame_received', handleNewFrame);
      socket.off('round_finished', handleRoundFinished);
    };
  }, [socket, isLive, roomId]);

  // Render Frame onto Canvas with GPU Hardware Acceleration (Like TikTok)
  const imgRef = useRef<HTMLImageElement | null>(null);
  const animFrameId = useRef<number | null>(null);

  useEffect(() => {
    if (!imgRef.current) {
      imgRef.current = new Image();
    }
  }, []);

  useEffect(() => {
    if (!currentFrame || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    if (animFrameId.current) {
      cancelAnimationFrame(animFrameId.current);
    }

    const img = imgRef.current || new Image();
    img.onload = () => {
      animFrameId.current = requestAnimationFrame(() => {
        if (canvas.width !== img.width || canvas.height !== img.height) {
          canvas.width = img.width;
          canvas.height = img.height;
        }
        ctx.drawImage(img, 0, 0);
      });
    };
    img.src = currentFrame;

    return () => {
      if (animFrameId.current) {
        cancelAnimationFrame(animFrameId.current);
      }
    };
  }, [currentFrame]);

  // Handle Slow-Motion Playback loop for frame sequence
  useEffect(() => {
    if (!isPlaying || isLive || frameHistory.length === 0) return;

    // Slow-mo interval speed calculation
    // Base nominal display rate ~33ms per frame (30fps)
    // 0.5x -> 66ms, 0.25x -> 132ms, 0.1x -> 330ms, 0.05x -> 660ms per frame
    const baseIntervalMs = 33;
    const intervalMs = Math.max(16, Math.floor(baseIntervalMs / playbackRate));

    const timer = setInterval(() => {
      setHistoryIndex((prevIdx) => {
        const currentIdx = prevIdx < 0 ? frameHistory.length - 1 : prevIdx;
        const nextIdx = currentIdx + 1;
        if (nextIdx >= frameHistory.length) {
          setIsPlaying(false); // Pause when reaching end of history buffer (Never auto jump to live!)
          return currentIdx;
        }
        if (frameHistory[nextIdx]) {
          setCurrentFrame(frameHistory[nextIdx]);
        }
        return nextIdx;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isPlaying, isLive, frameHistory.length, playbackRate]);

  // Handle Play/Pause
  const togglePlay = () => {
    if (!isPlaying && isLive) {
      // Switch from Live to DVR playback from recent frames
      setIsLive(false);
      const startIdx = Math.max(0, frameHistory.length - 30);
      setHistoryIndex(startIdx);
      if (frameHistory[startIdx]) setCurrentFrame(frameHistory[startIdx]);
    }
    setIsPlaying(!isPlaying);
  };

  // Change Playback Speed (Activates Slow-Mo playback mode)
  const handleSpeedChange = (speed: number) => {
    setPlaybackRate(speed);
    if (speed < 1.0) {
      setIsLive(false);
      setIsPlaying(true);
      // Start playing slow motion from recent frames
      const startIdx = Math.max(0, frameHistory.length - 30);
      setHistoryIndex(startIdx);
      if (frameHistory[startIdx]) setCurrentFrame(frameHistory[startIdx]);
    } else {
      jumpToLive();
    }
  };

  // Frame Stepping (+/- 1 frame)
  const stepFrame = (step: number) => {
    setIsPlaying(false);
    setIsLive(false);

    setHistoryIndex((prev) => {
      const current = prev < 0 ? frameHistory.length - 1 : prev;
      const target = Math.max(0, Math.min(frameHistory.length - 1, current + step));
      if (frameHistory[target]) {
        setCurrentFrame(frameHistory[target]);
      }
      return target;
    });
  };

  // Jump back to Live Realtime
  const jumpToLive = () => {
    setIsLive(true);
    setIsPlaying(true);
    setPlaybackRate(1.0);
    setHistoryIndex(-1);
    if (frameHistory.length > 0) {
      setCurrentFrame(frameHistory[frameHistory.length - 1]);
    }
  };

  // Seekbar Slider (Freeze frame on seeked index, no auto jump to live!)
  const handleSeekSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const idx = parseInt(e.target.value);
    setIsLive(false);
    setIsPlaying(false); // Pause auto-advancing so user can inspect seeked frame!
    setHistoryIndex(idx);
    if (frameHistory[idx]) {
      setCurrentFrame(frameHistory[idx]);
    }
  };

  const speedOptions = [0.05, 0.1, 0.25, 0.5, 0.75, 1.0];

  return (
    <div className="glass-panel rounded-2xl overflow-hidden shadow-2xl border border-indigo-500/20 flex flex-col">
      {/* Header Info Bar */}
      <div className="px-3 py-1.5 sm:px-4 sm:py-2 bg-slate-900/80 border-b border-white/5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-1 sm:gap-0">
        <div className="flex items-center space-x-2 sm:space-x-3 w-full sm:w-auto justify-between sm:justify-start">
          <div className="flex items-center space-x-1.5 px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-[10px] sm:text-[11px] font-semibold animate-pulse flex-shrink-0">
            <Radio className="w-3 h-3 animate-spin" />
            <span>LIVE 240FPS</span>
          </div>
          <span className="text-xs font-medium text-slate-300 truncate max-w-[180px] sm:max-w-none">
            {roomName ? `Room: ${roomName}` : (stream ? `Streamer: ${stream.username}` : 'Đang chờ luồng Live...')}
          </span>
        </div>

        <div className="flex items-center space-x-1.5 sm:space-x-2 self-end sm:self-auto">
          <span className="px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-300 text-[10px] font-mono font-medium border border-amber-500/30 flex items-center gap-1" title="Địa chỉ IP Server để nhập trên app iPhone">
            Host: {detectedServerUrl.replace('https://', '').replace('http://', '')}
          </span>
          <span className="px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 text-[10px] font-mono font-medium border border-indigo-500/30">
            240 FPS
          </span>
          <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-mono font-medium border border-emerald-500/30">
            Sync
          </span>
        </div>
      </div>

      {/* Video Canvas Container */}
      <div
        ref={videoContainerRef}
        className="relative aspect-video bg-black flex items-center justify-center group overflow-hidden max-h-[58vh]"
      >
        {/* Draggable Text Overlays */}
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

        {currentFrame ? (
          <canvas
            ref={canvasRef}
            className="w-full h-full object-contain"
            style={{
              transform: `rotate(${rotation}deg)`,
              transition: 'transform 0.2s ease-in-out'
            }}
          />
        ) : (
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

        {/* Live / Delayed Overlay Badge */}
        <div className="absolute top-2 left-2 flex flex-wrap items-center gap-1.5 z-10">
          {isLive ? (
            <span className="px-2 py-0.5 rounded-full bg-red-600 text-white font-bold text-[10px] uppercase tracking-wider flex items-center shadow-lg shadow-red-600/50">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-ping mr-1" />
              Trực Tiếp
            </span>
          ) : (
            <button
              onClick={jumpToLive}
              className="px-2 py-0.5 rounded-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-[10px] uppercase tracking-wider flex items-center shadow-lg transition-all"
            >
              <RotateCcw className="w-3 h-3 mr-1" />
              Tua lại • Nhảy tới LIVE
            </button>
          )}

          {playbackRate !== 1.0 && (
            <span className="px-2 py-0.5 rounded-full bg-indigo-600 text-white font-bold text-[10px] flex items-center border border-indigo-400 shadow-lg">
              <Zap className="w-3 h-3 mr-1 text-amber-300" />
              {playbackRate}x
            </span>
          )}
        </div>
      </div>

      {/* Controls Bar */}
      <div className="p-2 sm:p-2.5 bg-slate-900/95 space-y-1.5 border-t border-white/5">
        {/* DVR Frame Buffer Seekbar */}
        <div className="flex items-center space-x-2">
          <span className="text-[10px] sm:text-[11px] font-mono text-slate-400 min-w-[45px]">
            #{historyIndex >= 0 ? historyIndex + 1 : frameHistory.length}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(0, frameHistory.length - 1)}
            value={historyIndex >= 0 ? historyIndex : frameHistory.length - 1}
            onChange={handleSeekSlider}
            className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500 hover:accent-indigo-400"
          />
          <span className="text-[10px] sm:text-[11px] font-mono text-slate-400 min-w-[45px] text-right">
            / {frameHistory.length}
          </span>
        </div>

        {/* Action Controls */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-1.5 pt-0.5">
          {/* Main Playback & Frame Stepping */}
          <div className="flex items-center justify-between sm:justify-start space-x-1 sm:space-x-1.5">
            <button
              onClick={togglePlay}
              className="p-1.5 sm:p-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/30 transition-all flex-shrink-0"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <Play className="w-3.5 h-3.5 sm:w-4 sm:h-4 fill-current" />}
            </button>

            {/* Frame Step Back */}
            <button
              onClick={() => stepFrame(-1)}
              className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-white/10 text-xs font-medium flex items-center space-x-0.5 transition-all"
              title="Lùi 1 khung hình (1/240s)"
            >
              <ChevronLeft className="w-3 h-3" />
              <span>-1</span>
            </button>

            {/* Frame Step Forward */}
            <button
              onClick={() => stepFrame(1)}
              className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-white/10 text-xs font-medium flex items-center space-x-0.5 transition-all"
              title="Tiến 1 khung hình (1/240s)"
            >
              <span>+1</span>
              <ChevronRight className="w-3 h-3" />
            </button>

            {/* Rotate Video Button */}
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

            {/* Text Overlay Button */}
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

            {/* Finish Session Button */}
            {onFinishRound && (
              <button
                onClick={onFinishRound}
                className="px-2.5 py-1 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs shadow-md shadow-emerald-600/30 flex items-center space-x-1 transition-all active:scale-95 ml-auto sm:ml-1"
                title="Làm mới bộ nhớ hình ảnh và reset danh sách để bắt đầu phiên mới"
              >
                <CheckCircle2 className="w-3 h-3 text-amber-300" />
                <span>Xong Phiên</span>
              </button>
            )}
          </div>

          {/* Slow Motion Speed Controls (0.05x -> 1.0x) */}
          <div className="flex items-center space-x-0.5 bg-slate-950/60 p-1 rounded-xl border border-white/10 overflow-x-auto no-scrollbar max-w-full">
            <div className="flex items-center space-x-0.5 px-1 text-indigo-400 text-[10px] sm:text-[11px] font-semibold flex-shrink-0">
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
            {/* Header */}
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

            {/* Input Form: Nhập chữ để thêm trực tiếp */}
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

              {/* Color picker & Size */}
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

              {/* Submit button */}
              <button
                type="submit"
                disabled={!newTextContent.trim()}
                className="w-full py-2 rounded-xl bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400 text-slate-950 font-black text-xs flex items-center justify-center space-x-1.5 shadow-md shadow-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-95"
              >
                <Plus className="w-4 h-4 stroke-[3]" />
                <span>+ Thêm Chữ Này Lên Video</span>
              </button>
            </form>

            {/* List of existing text overlays */}
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

            {/* Footer */}
            <div className="pt-2 border-t border-white/10 flex items-center justify-between text-xs">
              <span className="text-[11px] text-slate-400 italic">
                💡 Giữ chuột hoặc chạm tay trên video để kéo thả chữ tự do
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
