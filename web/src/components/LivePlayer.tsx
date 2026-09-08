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

// Hàm xác định URL WebSocket nhị phân siêu tốc 120fps/240fps
function getBinaryWebSocketUrl(serverUrl: string, roomId: string): string {
  const proto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  let host = typeof window !== 'undefined' ? window.location.host : 'localhost:4000';

  // Nếu trình duyệt đang mở trên máy tính (localhost/127.0.0.1)
  if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    const isDevPort = window.location.port === '5173' || window.location.port === '3000';
    const wsPort = isDevPort ? '4000' : (window.location.port || '4000');
    return `${proto}${window.location.hostname}:${wsPort}/stream/binary?roomId=${encodeURIComponent(roomId || 'default')}&role=web`;
  }

  let base = serverUrl.trim();
  if (base.startsWith('https://')) {
    base = 'wss://' + base.slice(8);
  } else if (base.startsWith('http://')) {
    base = 'ws://' + base.slice(7);
  } else {
    base = proto + host;
  }
  while (base.endsWith('/')) {
    base = base.slice(0, -1);
  }
  return `${base}/stream/binary?roomId=${encodeURIComponent(roomId || 'default')}&role=web`;
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

  const [hasFrame, setHasFrame] = useState(false);
  const hasFrameRef = useRef(false);
  const [bufferCount, setBufferCount] = useState<number>(0);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  // Bộ đệm Ring Buffer lưu {timestamp thật lúc quay, bitmap}. Lưu kèm timestamp là bắt buộc để
  // phát lại Slow-Motion bám theo ĐỒNG HỒ THỰC (xem vòng lặp phát bên dưới) thay vì chỉ nhảy
  // "1 frame mỗi tick" — cách cũ không biết tốc độ quay gốc thực tế là 120fps hay 240fps nên
  // tốc độ 0.25x/0.5x hiển thị sai và bị giật do lệch nhịp setInterval.
  interface HistoryEntry {
    timestamp: number; // giây, Unix epoch — do iPhone gán tại thời điểm quay (Date().timeIntervalSince1970)
    bitmap: ImageBitmap | HTMLImageElement;
  }
  const frameBitmapsRef = useRef<HistoryEntry[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const isLiveRef = useRef<boolean>(true);
  const isPlayingRef = useRef<boolean>(true);
  const playbackRateRef = useRef<number>(1.0);

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

  // Render Frame onto Canvas with GPU Hardware Acceleration (< 0.2ms)
  const renderFrame = (frame: ImageBitmap | HTMLImageElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const w = 'width' in frame ? frame.width : (frame as HTMLImageElement).naturalWidth;
    const h = 'height' in frame ? frame.height : (frame as HTMLImageElement).naturalHeight;
    if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(frame, 0, 0);
  };

  // Đồng bộ độ dài buffer lên UI định kỳ 10Hz để seekbar mượt mà, KHÔNG re-render React 240 lần/s
  useEffect(() => {
    const interval = setInterval(() => {
      setBufferCount(frameBitmapsRef.current.length);
    }, 100);
    return () => clearInterval(interval);
  }, []);

  // Reset video buffer khi chuyển đổi Room
  useEffect(() => {
    frameBitmapsRef.current.forEach((entry) => {
      const bm = entry.bitmap;
      if (bm && 'close' in bm && typeof (bm as any).close === 'function') {
        (bm as any).close();
      }
    });
    frameBitmapsRef.current = [];
    historyIndexRef.current = -1;
    setBufferCount(0);
    setHistoryIndex(-1);
    setIsLive(true);
    isLiveRef.current = true;
    setIsPlaying(true);
    isPlayingRef.current = true;
    setPlaybackRate(1.0);
    playbackRateRef.current = 1.0;
    hasFrameRef.current = false;
    setHasFrame(false);
  }, [roomId]);

  // KẾT NỐI WEBSOCKET NHỊ PHÂN SIÊU TỐC (TURBO BINARY STREAM 120FPS/240FPS)
  // Tự động nhận Binary JPEG, giải mã trên GPU bằng createImageBitmap, tự động dọn dẹp RAM
  useEffect(() => {
    let isMounted = true;
    let ws: WebSocket | null = null;
    let reconnectTimer: any = null;

    // TRẦN ĐỘ TRỄ TUYỆT ĐỐI cho toàn hệ thống (tính từ thời điểm quay thực tế trên iPhone tới lúc
    // hiển thị trên Web) — PHẢI dùng cùng một mốc "đồng hồ thực" (Date.now()) ở MỌI tầng
    // (iOS/Server/Web), không phải đo tương đối trong riêng hàng đợi của từng tầng. Trước đây Web
    // đo "khoảng cách giữa frame mới nhất và cũ nhất TRONG HÀNG ĐỢI CỦA CHÍNH NÓ" — nếu frame đã bị
    // trễ sẵn từ iOS/Server (ví dụ đã trễ 10s trước khi tới Web), Web vẫn vô tình cho phép trễ thêm
    // tối đa 10s NỮA vì không biết frame đã "già" từ trước. Cộng dồn qua 3 tầng độc lập như vậy có
    // thể ra tới ~30s thực tế dù mỗi tầng đều cấu hình "tối đa 10s". Sửa: luôn so sánh tuổi frame
    // với Date.now() thực tế — tầng nào cũng tự động không cho tổng độ trễ vượt ngưỡng này, bất kể
    // độ trễ đã phát sinh ở đâu trước đó.
    const TOTAL_MAX_LATENCY_SEC = 10;
    type QueuedFrame = { timestamp: number; bytes: ArrayBuffer };
    const decodeQueue: QueuedFrame[] = [];
    let isDecoding = false;

    async function processDecodeQueue() {
      if (isDecoding) return;
      isDecoding = true;
      while (decodeQueue.length > 0) {
        const item = decodeQueue.shift()!;

        // Tới lượt xử lý mà đã quá hạn tổng (tuổi tuyệt đối tính từ lúc quay) -> bỏ luôn, không
        // giải mã (đỡ tốn CPU) và không hiển thị, thay vì cố hiển thị 1 hình đã trễ vô nghĩa.
        if (Date.now() / 1000 - item.timestamp > TOTAL_MAX_LATENCY_SEC) {
          continue;
        }

        try {
          const blob = new Blob([item.bytes], { type: 'image/jpeg' });
          // Giải mã trên luồng GPU nền (không chặn JS main thread), nhưng chờ tuần tự để giữ thứ tự
          const bitmap = await createImageBitmap(blob);
          if (!isMounted) {
            if (typeof bitmap.close === 'function') bitmap.close();
            break;
          }

          const history = frameBitmapsRef.current;
          history.push({ timestamp: item.timestamp, bitmap });

          // Xoay vòng bộ đệm FIFO Ring Buffer: Tối đa 1800 frames (~15-30s Slow-Mo)
          if (history.length > 1800) {
            const old = history.shift();
            if (old && 'close' in old.bitmap && typeof (old.bitmap as any).close === 'function') {
              (old.bitmap as any).close();
            }
            if (historyIndexRef.current > 0) {
              historyIndexRef.current--;
            }
          }

          if (!hasFrameRef.current) {
            hasFrameRef.current = true;
            setHasFrame(true);
          }

          if (isLiveRef.current) {
            renderFrame(bitmap);
          }
        } catch {
          // Bỏ qua lỗi giải mã nếu frame bị gián đoạn, không làm gián đoạn hàng đợi
        }
      }
      isDecoding = false;
    }

    function enqueueIncoming(buf: ArrayBuffer) {
      if (buf.byteLength < 16) return;
      const view = new DataView(buf);
      const magic = view.getUint32(0, false);
      if (magic !== 0x534C4F4D) return; // "SLOM"
      const timestamp = view.getFloat64(8, false);

      // Kiểm tra NGAY khi nhận: nếu frame đã trễ quá TOTAL_MAX_LATENCY_SEC tính từ lúc quay thực tế
      // (không phải chỉ trong hàng đợi riêng của Web) thì bỏ luôn, không xếp hàng, không giải mã.
      const nowSec = Date.now() / 1000;
      if (nowSec - timestamp > TOTAL_MAX_LATENCY_SEC) {
        return;
      }

      const jpegBytes = buf.slice(16);
      decodeQueue.push({ timestamp, bytes: jpegBytes });

      // Dọn thêm các frame đã kịp "quá hạn" trong lúc còn nằm chờ giải mã (trần TUYỆT ĐỐI theo
      // đồng hồ thực, không phải chỉ khoảng cách với frame mới nhất) — phòng khi decode chậm lại
      // (CPU yếu, tab bị throttle nền) khiến hàng đợi ứ lại.
      while (
        decodeQueue.length > 0 &&
        Date.now() / 1000 - decodeQueue[0].timestamp > TOTAL_MAX_LATENCY_SEC
      ) {
        decodeQueue.shift();
      }

      processDecodeQueue();
    }

    function connect() {
      const wsUrl = getBinaryWebSocketUrl(detectedServerUrl, roomId || 'default');
      try {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onmessage = (e) => {
          if (!isMounted) return;
          if (e.data instanceof ArrayBuffer) {
            enqueueIncoming(e.data);
          }
        };

        ws.onclose = () => {
          if (isMounted) reconnectTimer = setTimeout(connect, 2000);
        };
        ws.onerror = () => {};
      } catch {
        if (isMounted) reconnectTimer = setTimeout(connect, 2000);
      }
    }

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try { ws.close(); } catch {}
      }
    };
  }, [detectedServerUrl, roomId]);

  // Socket.IO Realtime fallback & Session lifecycle
  useEffect(() => {
    if (!socket) return;

    const handleNewFrame = (data: { frame: string; timestamp: number; roomId?: string }) => {
      if (data && data.roomId && roomId && data.roomId !== roomId) return;
      if (data && data.frame) {
        const ts = (data.timestamp || Date.now()) / 1000;
        // Cùng trần trễ tuyệt đối như đường WebSocket chính — không cộng dồn thêm ở đường fallback này
        if (Date.now() / 1000 - ts > 10) return;
        const img = new Image();
        img.onload = () => {
          const history = frameBitmapsRef.current;
          history.push({ timestamp: ts, bitmap: img });
          if (history.length > 1800) {
            const old = history.shift();
            if (old && 'close' in old.bitmap && typeof (old.bitmap as any).close === 'function') {
              (old.bitmap as any).close();
            }
            if (historyIndexRef.current > 0) historyIndexRef.current--;
          }
          if (!hasFrameRef.current) {
            hasFrameRef.current = true;
            setHasFrame(true);
          }
          if (isLiveRef.current) {
            renderFrame(img);
          }
        };
        img.src = data.frame;
      }
    };

    const handleBinaryFrame = async (buf: any) => {
      if (!buf) return;
      const arrayBuffer = buf instanceof ArrayBuffer ? buf : (buf.buffer ? buf.buffer : null);
      if (!arrayBuffer || arrayBuffer.byteLength < 16) return;
      const view = new DataView(arrayBuffer);
      if (view.getUint32(0, false) !== 0x534C4F4D) return;
      const timestamp = view.getFloat64(8, false);
      // Cùng trần trễ tuyệt đối như đường WebSocket chính
      if (Date.now() / 1000 - timestamp > 10) return;
      const jpegBytes = arrayBuffer.slice(16);
      try {
        const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        const history = frameBitmapsRef.current;
        history.push({ timestamp, bitmap });
        if (history.length > 1800) {
          const old = history.shift();
          if (old && 'close' in old.bitmap && typeof (old.bitmap as any).close === 'function') (old.bitmap as any).close();
          if (historyIndexRef.current > 0) historyIndexRef.current--;
        }
        if (!hasFrameRef.current) {
          hasFrameRef.current = true;
          setHasFrame(true);
        }
        if (isLiveRef.current) renderFrame(bitmap);
      } catch {}
    };

    // Khi kết thúc ván: XÓA SẠCH TOÀN BỘ BỘ ĐỆM VÀ GIẢI PHÓNG RAM 100%
    const handleRoundFinished = (data?: { roomId?: string }) => {
      if (data && data.roomId && roomId && data.roomId !== roomId) return;
      frameBitmapsRef.current.forEach((entry) => {
        const bm = entry.bitmap;
        if (bm && 'close' in bm && typeof (bm as any).close === 'function') {
          (bm as any).close();
        }
      });
      frameBitmapsRef.current = [];
      historyIndexRef.current = -1;
      setBufferCount(0);
      setHistoryIndex(-1);
      setIsLive(true);
      isLiveRef.current = true;
      hasFrameRef.current = false;
      setHasFrame(false);
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    };

    const handleInitialState = (data: any) => {
      if (data && data.roomId && roomId && data.roomId !== roomId) return;
      if (data && data.serverUrl) {
        setDetectedServerUrl(resolveServerUrl(data.serverUrl));
      }
    };

    socket.on('initial_state', handleInitialState);
    socket.on('live_frame_received', handleNewFrame);
    socket.on('binary_frame_received', handleBinaryFrame);
    socket.on('round_finished', handleRoundFinished);

    return () => {
      socket.off('initial_state', handleInitialState);
      socket.off('live_frame_received', handleNewFrame);
      socket.off('binary_frame_received', handleBinaryFrame);
      socket.off('round_finished', handleRoundFinished);
    };
  }, [socket, roomId]);

  // Vòng lặp phát Slow-Motion: dùng "đồng hồ ảo" bám theo TIMESTAMP THẬT của từng frame (thời điểm
  // quay thực tế trên iPhone) thay vì đếm "1 frame mỗi tick" như trước. Lý do đổi cách này:
  //
  // 1) MƯỢT: chạy theo requestAnimationFrame (đồng bộ khung hình trình duyệt, ~60Hz+) thay vì
  //    setInterval — setInterval bị trôi/giật khi tab bận (đang decode JPEG, GC...), còn rAF được
  //    trình duyệt tự canh nhịp render nên chuyển động mượt hơn hẳn.
  // 2) ĐÚNG TỐC ĐỘ: trước đây giả định nguồn quay cố định ~60fps (baseIntervalMs = 16.6) để suy ra
  //    interval, nhưng camera thực tế quay 120fps hoặc 240fps (thậm chí dao động) — nên "0.5x" hiển
  //    thị không phải 0.5x thật. Cách mới: mỗi frame nhận từ iPhone có kèm timestamp Unix thật khi
  //    quay. Ta neo "thời điểm nguồn" (anchorSourceTime) tại thời điểm bắt đầu phát, rồi mỗi lần vẽ
  //    tính "thời điểm nguồn mục tiêu" = anchorSourceTime + (thời gian thực đã trôi qua) * playbackRate,
  //    và luôn hiển thị đúng frame gần nhất có timestamp <= mục tiêu đó. Cách này tự động đúng với
  //    BẤT KỲ tốc độ quay gốc nào (120/240fps hay dao động do mạng), không cần biết trước fps nguồn.
  useEffect(() => {
    if (!isPlaying || isLive) return;

    let rafId: number;
    const anchorRealTimeMs = performance.now();
    const startIdx = historyIndexRef.current >= 0
      ? historyIndexRef.current
      : Math.max(0, frameBitmapsRef.current.length - 1);
    const anchorSourceTime = frameBitmapsRef.current[startIdx]?.timestamp ?? null;

    const tick = () => {
      const history = frameBitmapsRef.current;
      if (history.length === 0 || anchorSourceTime === null) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      const elapsedRealSec = (performance.now() - anchorRealTimeMs) / 1000;
      const targetSourceTime = anchorSourceTime + elapsedRealSec * playbackRate;

      // Tiến tới (không lùi) tới frame gần nhất có timestamp <= targetSourceTime.
      let idx = historyIndexRef.current < 0 ? 0 : historyIndexRef.current;
      while (idx + 1 < history.length && history[idx + 1].timestamp <= targetSourceTime) {
        idx++;
      }

      if (idx !== historyIndexRef.current) {
        historyIndexRef.current = idx;
        setHistoryIndex(idx);
        renderFrame(history[idx].bitmap);
      }
      // Nếu đã đuổi kịp frame mới nhất trong buffer: giữ nguyên trạng thái playing, chờ frame
      // live tiếp theo từ camera tới rồi tự động tiếp tục chạy chậm theo, không bị dừng khựng.

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, isLive, playbackRate]);

  // Bật / Tắt Phát
  const togglePlay = () => {
    if (!isPlaying && isLive) {
      // Khi đang Live mà bấm dừng -> chuyển sang xem Slow-Mo/DVR từ vị trí gần nhất
      setIsLive(false);
      isLiveRef.current = false;
      const history = frameBitmapsRef.current;
      const startIdx = Math.max(0, history.length - 30);
      historyIndexRef.current = startIdx;
      setHistoryIndex(startIdx);
      if (history[startIdx]) renderFrame(history[startIdx].bitmap);
    }
    const nextPlaying = !isPlaying;
    setIsPlaying(nextPlaying);
    isPlayingRef.current = nextPlaying;
  };

  // Thay đổi tốc độ phát Slow-Motion (chạy chậm từ từ theo luồng Live)
  const handleSpeedChange = (speed: number) => {
    setPlaybackRate(speed);
    playbackRateRef.current = speed;

    if (speed < 1.0) {
      if (isLiveRef.current) {
        // Chuyển từ Live sang Slow:
        // Bắt đầu chạy chậm từ khoảng 40 frame trước (~0.5-1s trước) để xem chuyển động chậm mượt mà
        setIsLive(false);
        isLiveRef.current = false;
        setIsPlaying(true);
        isPlayingRef.current = true;
        const history = frameBitmapsRef.current;
        const startIdx = Math.max(0, history.length - 40);
        historyIndexRef.current = startIdx;
        setHistoryIndex(startIdx);
        if (history[startIdx]) {
          renderFrame(history[startIdx].bitmap);
        }
      } else {
        // Đang ở trong chế độ Slow: tiếp tục chạy với tốc độ mới mà không bị giật lùi
        // (useEffect ở trên sẽ tự neo lại anchorSourceTime = frame hiện tại khi playbackRate đổi)
        setIsPlaying(true);
        isPlayingRef.current = true;
      }
    } else {
      // Chọn 1.0x: Nhảy về Live trực tiếp
      jumpToLive();
    }
  };

  // Tua từng khung hình (+/- 1 frame)
  const stepFrame = (step: number) => {
    setIsPlaying(false);
    isPlayingRef.current = false;
    setIsLive(false);
    isLiveRef.current = false;

    const history = frameBitmapsRef.current;
    if (history.length === 0) return;

    let current = historyIndexRef.current;
    if (current < 0) current = history.length - 1;

    const target = Math.max(0, Math.min(history.length - 1, current + step));
    historyIndexRef.current = target;
    setHistoryIndex(target);
    if (history[target]) {
      renderFrame(history[target].bitmap);
    }
  };

  // Nhảy ngay về xem Trực Tiếp (Live)
  const jumpToLive = () => {
    setIsLive(true);
    isLiveRef.current = true;
    setIsPlaying(true);
    isPlayingRef.current = true;
    setPlaybackRate(1.0);
    playbackRateRef.current = 1.0;
    historyIndexRef.current = -1;
    setHistoryIndex(-1);
    const history = frameBitmapsRef.current;
    if (history.length > 0) {
      renderFrame(history[history.length - 1].bitmap);
    }
  };

  // Kéo thanh trượt DVR Seekbar
  const handleSeekSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const idx = parseInt(e.target.value, 10);
    setIsLive(false);
    isLiveRef.current = false;
    historyIndexRef.current = idx;
    setHistoryIndex(idx);
    const history = frameBitmapsRef.current;
    if (history[idx]) {
      renderFrame(history[idx].bitmap);
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

        {hasFrame ? (
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
            <span className="px-2.5 py-1 rounded-full bg-red-600 text-white font-bold text-[10px] sm:text-[11px] uppercase tracking-wider flex items-center shadow-lg shadow-red-600/50">
              <span className="w-2 h-2 rounded-full bg-white animate-ping mr-1.5" />
              Trực Tiếp
            </span>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={jumpToLive}
                className="px-2.5 py-1 rounded-full bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white font-bold text-[10px] sm:text-[11px] uppercase tracking-wider flex items-center shadow-lg shadow-red-600/40 transition-all active:scale-95 animate-pulse"
                title="Bấm để nhảy ngay về hình ảnh Trực Tiếp (Live)"
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                Về Live
              </button>

              <span className="px-2.5 py-1 rounded-full bg-amber-500/25 text-amber-300 font-bold font-mono text-[10px] sm:text-[11px] border border-amber-500/40 flex items-center shadow-md backdrop-blur-md">
                <Gauge className="w-3.5 h-3.5 mr-1 text-amber-400" />
                Slow {playbackRate}x {isPlaying ? '• Đang chạy theo' : '• Tạm dừng'}
              </span>

              {historyIndex >= 0 && bufferCount > 0 && (
                <span className="hidden xs:inline-flex px-2 py-0.5 rounded-full bg-slate-900/80 text-slate-300 font-mono text-[10px] border border-white/10 backdrop-blur-sm">
                  Trễ: -{((bufferCount - 1 - historyIndex) / 60).toFixed(1)}s ({bufferCount - 1 - historyIndex} frame)
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Controls Bar */}
      <div className="p-2 sm:p-2.5 bg-slate-900/95 space-y-1.5 border-t border-white/5">
        {/* DVR Frame Buffer Seekbar */}
        <div className="flex items-center space-x-2">
          <span className="text-[10px] sm:text-[11px] font-mono text-slate-400 min-w-[45px]">
            #{historyIndex >= 0 ? historyIndex + 1 : bufferCount}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(0, bufferCount - 1)}
            value={historyIndex >= 0 ? historyIndex : Math.max(0, bufferCount - 1)}
            onChange={handleSeekSlider}
            className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500 hover:accent-indigo-400"
          />
          <span className="text-[10px] sm:text-[11px] font-mono text-slate-400 min-w-[45px] text-right">
            / {bufferCount}
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
