import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

export interface MarkedFrame {
  index: number;
  timestamp: number;
  timeStr: string;
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

  // Đếm số frame THỰC SỰ nhận/giải mã được mỗi giây (không phải fps camera báo cáo), để chẩn đoán
  // xem có đang bị rớt frame ở đâu đó trước khi tới Web hay không (mạng, camera không kịp encode...).
  const receivedFrameCountRef = useRef(0);
  const [receivedFps, setReceivedFps] = useState(0);
  const lastFpsCheckRef = useRef({ time: performance.now(), count: 0 });
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
  // "Mốc" timestamp của frame MỚI NHẤT đã thực sự được vẽ lên canvas khi đang Live — dùng chung
  // cho cả 2 đường nhận dữ liệu (WebSocket nhị phân & Socket.IO base64 fallback). Vì đường base64
  // giải mã bất đồng bộ (Image.onload) nên có thể hoàn tất KHÔNG đúng thứ tự tới; mốc này đảm bảo
  // Live không bao giờ "vẽ lùi" (hiện một frame cũ hơn frame đã hiện trước đó).
  const lastLiveRenderedTsRef = useRef<number>(0);
  const isLiveRef = useRef<boolean>(true);
  const isPlayingRef = useRef<boolean>(true);
  const playbackRateRef = useRef<number>(1.0); // tốc độ MỤC TIÊU do người dùng chọn

  // Tốc độ TỨC THỜI đang thực sự dùng để phát (được "ease" dần về playbackRateRef.current mỗi
  // khung hình) — đây là điểm mấu chốt tạo hiệu ứng vào/ra chậm mượt giống video slo-mo iPhone
  // xuất ra (đầu/cuối chạy thường, giữa chậm dần rồi nhanh dần lại), thay vì đổi tốc độ đột ngột.
  const currentRateRef = useRef<number>(1.0);
  // "Đồng hồ ảo" theo mốc thời gian THẬT của nguồn (timestamp lúc quay) — được cộng dồn mỗi frame
  // theo currentRateRef.current, KHÔNG tính lại từ một điểm neo cố định như trước, để tốc độ có
  // thể thay đổi liên tục (ramp) mà vẫn ra đúng vị trí, không bị nhảy/lướt khung hình.
  const sourceTimeRef = useRef<number | null>(null);

  // Ở tốc độ r < 1, mỗi giây thực trôi qua playhead chỉ tiến r giây source-time trong khi live edge
  // vẫn tiến đúng 1 giây/giây -> khoảng cách (gap) giữa playhead và live TĂNG DẦN theo (1 - r)
  // giây/giây, không có điểm dừng. Muốn rút ngắn gap về 0 mà không cắt cảnh, cần một tốc độ r > 1
  // ("bắt kịp") để gap giảm dần theo (r - 1) giây/giây, rồi tự khớp vào Live khi gap chạm 0.
  const CATCH_UP_RATE = 6.0;
  const isCatchingUpRef = useRef<boolean>(false);
  const [isCatchingUp, setIsCatchingUp] = useState(false);
  // Nhớ tốc độ Slow-Mo gần nhất người dùng chọn (để phím Enter lần 1 vào lại đúng tốc độ quen dùng)
  const lastSlowSpeedRef = useRef<number>(0.25);

  const [markedFrame, setMarkedFrame] = useState<MarkedFrame | null>(null);
  const markedFrameRef = useRef<MarkedFrame | null>(null);

  // Bộ tích luỹ thời gian để đảm bảo mọi khung hình được phát liền kề nhau 100%, không mất frame
  const frameTimeAccumulatorRef = useRef<number>(0);

  const [isPlaying, setIsPlaying] = useState(true);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [isLive, setIsLive] = useState(true);
  // Thông báo nổi bật khi đổi chế độ bằng Enter: LIVE hoặc SLOW-MO kèm chi tiết mốc
  const [modeNotice, setModeNotice] = useState<'slow' | 'live' | null>(null);
  const [modeNoticeTitle, setModeNoticeTitle] = useState<string>('');
  const [modeNoticeSub, setModeNoticeSub] = useState<string>('');
  const [modeNoticeHint, setModeNoticeHint] = useState<string>('');
  const [modeNoticeKey, setModeNoticeKey] = useState(0);
  const modeNoticeTimerRef = useRef<number | null>(null);
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

  // Độ trễ mục tiêu khi vào Slow-Mo: lùi lại ~10s TÍNH THEO THỜI GIAN THỰC đã quay (không phải
  // số frame cố định) — vì camera có thể là 60/120/240fps, "lùi 40 frame" ở 240fps chỉ là ~0.17s,
  // quá ngắn để xem chậm; còn ở 30fps lại thành hơn 1s, không nhất quán.
  const SLOWMO_REPLAY_DELAY_SEC = 10;

  // ============================================================================
  // TỰ ĐỘNG TÍNH TỐC ĐỘ SLOW-MO KHI BẤM ENTER, DỰA TRÊN FPS QUAY THỰC TẾ CỦA CAMERA
  // ----------------------------------------------------------------------------
  // Ý tưởng: timeline phát ra màn hình luôn ~30 khung hình/giây. Nếu camera quay 120fps, để phát
  // đúng 30 khung/giây thì phải trải 120 khung quay ra thành 4 giây xem -> chậm 4x -> rate = 0.25.
  // Nếu quay 240fps thì trải ra 8 giây -> chậm 8x -> rate = 0.125. Công thức chung:
  //     rate = TARGET_PLAYBACK_FPS / fpsNguồnThực
  // fpsNguồnThực được đo trực tiếp từ khoảng cách timestamp thật giữa các frame đã nhận (không
  // dùng con số camera "tự khai báo" 240fps cố định), nên tự thích ứng nếu người dùng quay 120fps
  // thay vì 240fps, hoặc mạng/camera đang tụt xuống 60fps.
  // Mục tiêu 60 FPS giúp Slow-Mo hiển thị mượt trên màn hình 60Hz và phát đủ
  // từng frame nguồn ở 120/240 FPS (120->0.5x, 240->0.25x).
  const TARGET_PLAYBACK_FPS = 60;
  // Các mốc fps quay Slo-Mo phổ biến trên iPhone — dùng để "bắt" (snap) kết quả đo về đúng mốc
  // gần nhất, tránh sai số do jitter mạng làm khoảng cách timestamp giữa các frame không đều.
  const KNOWN_SOURCE_FPS = [240, 120, 60, 30];

  const [detectedSourceFps, setDetectedSourceFps] = useState<number>(240);
  const detectedSourceFpsRef = useRef<number>(240);

  // Đo fps quay thực tế bằng cách lấy TRUNG VỊ (median) khoảng cách timestamp giữa các frame gần
  // đây nhất trong buffer — dùng trung vị (không phải trung bình) để 1-2 frame đến trễ/gộp do
  // mạng không làm lệch kết quả. Dùng timestamp THẬT lúc quay (không phải lúc frame tới Web) nên
  // không bị ảnh hưởng bởi độ trễ mạng, chỉ phản ánh đúng tốc độ camera đang quay.
  function estimateSourceFps(history: HistoryEntry[]): number {
    const SAMPLE = 30;
    if (history.length < 2) return detectedSourceFpsRef.current;
    const slice = history.slice(Math.max(0, history.length - SAMPLE));
    const deltas: number[] = [];
    for (let i = 1; i < slice.length; i++) {
      const d = slice[i].timestamp - slice[i - 1].timestamp;
      // Bỏ các khoảng bất thường (đứng hình mạng, frame trùng timestamp...) để không làm sai lệch
      if (d > 0.0005 && d < 0.5) deltas.push(d);
    }
    if (deltas.length === 0) return detectedSourceFpsRef.current;
    deltas.sort((a, b) => a - b);
    const medianDt = deltas[Math.floor(deltas.length / 2)];
    const rawFps = 1 / medianDt;

    let closest = KNOWN_SOURCE_FPS[0];
    let minDiff = Infinity;
    for (const f of KNOWN_SOURCE_FPS) {
      const diff = Math.abs(f - rawFps);
      if (diff < minDiff) {
        minDiff = diff;
        closest = f;
      }
    }
    return closest;
  }

  // Tự động tính tốc độ Slow-Mo chuẩn xuất video Slo-Mo iOS:
  // - 240fps -> 0.25x (chạy 60fps hiển thị mượt mà trên màn hình)
  // - 120fps -> 0.25x (chạy 30fps) hoặc 0.5x
  // - 60fps -> 0.5x (chạy 30fps chuẩn)
  function computeAutoSlowRate(sourceFps: number): number {
    if (sourceFps >= 200) return 0.25;
    if (sourceFps >= 100) return 0.25;
    return 0.5;
  }

  function showModeNotice(mode: 'slow' | 'live', title: string, sub = '', hint = '') {
    // Tăng key để MỌI lần đổi chế độ/tốc độ đều tạo một flash mới.
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

  // Tìm index trong history là khung hình ĐẦU TIÊN có timestamp >= (mốc mới nhất - delaySec).
  // Dùng timestamp thật (Date().timeIntervalSince1970 do iPhone gán) nên luôn đúng ~10s bất kể
  // fps nguồn là bao nhiêu. Nếu buffer chưa đủ 10s dữ liệu, tự động lùi về khung hình cũ nhất
  // đang có (idx 0) thay vì báo lỗi.
  function findStartIndexForDelay(history: HistoryEntry[], delaySec: number): number {
    if (history.length === 0) return 0;
    const latestTs = history[history.length - 1].timestamp;
    const targetTs = latestTs - delaySec;
    let idx = history.length - 1;
    while (idx > 0 && history[idx - 1].timestamp >= targetTs) {
      idx--;
    }
    return idx;
  }

  // Chèn frame mới vào buffer lịch sử ĐÚNG vị trí theo timestamp tăng dần. Cần thiết vì đường
  // Socket.IO base64 (Image.onload) giải mã bất đồng bộ nên các frame có thể "về đích" không đúng
  // thứ tự — nếu chỉ push() thẳng vào cuối mảng, buffer sẽ không còn sắp xếp theo thời gian, làm
  // hỏng mọi thuật toán tìm kiếm dựa trên giả định mảng tăng dần (findStartIndexForDelay, vòng lặp
  // phát Slow-Mo...). Trường hợp phổ biến nhất (>99%, đặc biệt với đường WS nhị phân vốn đã xử lý
  // tuần tự) là frame mới nhất luôn tới sau cùng nên chi phí thực tế gần như O(1).
  function insertFrameSorted(entry: HistoryEntry) {
    const history = frameBitmapsRef.current;
    if (history.length === 0 || entry.timestamp >= history[history.length - 1].timestamp) {
      history.push(entry);
      return;
    }
    let pos = history.length - 1;
    while (pos > 0 && history[pos - 1].timestamp > entry.timestamp) {
      pos--;
    }
    history.splice(pos, 0, entry);
    // Nếu chèn vào trước vị trí đang xem trong Slow-Mo, dịch index đang xem lên 1 để playhead
    // không vô tình nhảy hình.
    if (historyIndexRef.current >= pos) {
      historyIndexRef.current++;
    }
  }

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
    // Canvas mặc định có thể dùng nội suy chất lượng thấp khi CSS scale (object-contain) phóng to
    // canvas nhỏ lên khung hiển thị lớn hơn -> nhìn "nhòe". Ép chất lượng nội suy cao nhất mỗi lần
    // vẽ (rẻ, không đáng kể về hiệu năng so với chi phí decode JPEG) để hình luôn nét nhất có thể.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, 0, 0);
  };

  // Đồng bộ độ dài buffer lên UI định kỳ 10Hz để seekbar mượt mà, KHÔNG re-render React 240 lần/s
  useEffect(() => {
    const interval = setInterval(() => {
      setBufferCount(frameBitmapsRef.current.length);

      // Tính fps thực nhận mỗi ~1 giây (đếm số frame mới decode được kể từ lần đo trước)
      const now = performance.now();
      const last = lastFpsCheckRef.current;
      const elapsedSec = (now - last.time) / 1000;
      if (elapsedSec >= 1) {
        const framesSince = receivedFrameCountRef.current - last.count;
        setReceivedFps(Math.round(framesSince / elapsedSec));
        lastFpsCheckRef.current = { time: now, count: receivedFrameCountRef.current };
      }
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
    currentRateRef.current = 1.0;
    isCatchingUpRef.current = false;
    setIsCatchingUp(false);
    sourceTimeRef.current = null;
    markedFrameRef.current = null;
    setMarkedFrame(null);
    frameTimeAccumulatorRef.current = 0;
    hasFrameRef.current = false;
    setHasFrame(false);
    lastLiveRenderedTsRef.current = 0;
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
    const TOTAL_MAX_LATENCY_SEC = 60;
    type QueuedFrame = { timestamp: number; bytes: ArrayBuffer };
    const decodeQueue: QueuedFrame[] = [];
    let isDecoding = false;

    async function processDecodeQueue() {
      if (isDecoding) return;
      isDecoding = true;
      while (decodeQueue.length > 0) {
        const item = decodeQueue.shift()!;

        // Tới lượt xử lý mà đã quá hạn tổng (tuổi tuyệt đối tính từ lúc quay) -> bỏ luôn
        if (Date.now() / 1000 > item.timestamp && Date.now() / 1000 - item.timestamp > TOTAL_MAX_LATENCY_SEC) {
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
          insertFrameSorted({ timestamp: item.timestamp, bitmap });
          receivedFrameCountRef.current++;

          // Xoay vòng bộ đệm FIFO Ring Buffer: Tối đa 3000 frames (~12.5s ở 240fps, 25s ở 120fps)
          if (history.length > 3000) {
            // Khi đang xem slow-mo ở vị trí gần đầu, bảo vệ tối thiểu 100 frame trước playhead
            if (historyIndexRef.current < 0 || historyIndexRef.current > 100) {
              const old = history.shift();
              if (old && 'close' in old.bitmap && typeof (old.bitmap as any).close === 'function') {
                (old.bitmap as any).close();
              }
              if (historyIndexRef.current > 0) {
                historyIndexRef.current--;
              }
              if (markedFrameRef.current && markedFrameRef.current.index > 0) {
                markedFrameRef.current.index--;
                setMarkedFrame({ ...markedFrameRef.current });
              }
            }
          }

          if (!hasFrameRef.current) {
            hasFrameRef.current = true;
            setHasFrame(true);
          }

          // Khi đang xem Live trực tiếp: vẽ ngay frame mới lên canvas nếu là frame mới nhất
          if (isLiveRef.current) {
            if (item.timestamp < lastLiveRenderedTsRef.current - 5.0) {
              lastLiveRenderedTsRef.current = 0;
            }
            if (item.timestamp >= lastLiveRenderedTsRef.current) {
              lastLiveRenderedTsRef.current = item.timestamp;
              renderFrame(bitmap);
            }
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

      // Kiểm tra ngay khi nhận: chỉ bỏ frame nếu thực sự quá cũ (trên 60s)
      const nowSec = Date.now() / 1000;
      if (nowSec > timestamp && nowSec - timestamp > TOTAL_MAX_LATENCY_SEC) {
        return;
      }

      const jpegBytes = buf.slice(16);
      decodeQueue.push({ timestamp, bytes: jpegBytes });

      while (
        decodeQueue.length > 0 &&
        Date.now() / 1000 > decodeQueue[0].timestamp &&
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
        const nowSec = Date.now() / 1000;
        if (nowSec > ts && nowSec - ts > 60) return;
        const img = new Image();
        img.onload = () => {
          const history = frameBitmapsRef.current;
          insertFrameSorted({ timestamp: ts, bitmap: img });
          receivedFrameCountRef.current++;
          if (history.length > 3000) {
            if (historyIndexRef.current < 0 || historyIndexRef.current > 100) {
              const old = history.shift();
              if (old && 'close' in old.bitmap && typeof (old.bitmap as any).close === 'function') {
                (old.bitmap as any).close();
              }
              if (historyIndexRef.current > 0) historyIndexRef.current--;
              if (markedFrameRef.current && markedFrameRef.current.index > 0) {
                markedFrameRef.current.index--;
                setMarkedFrame({ ...markedFrameRef.current });
              }
            }
          }
          if (!hasFrameRef.current) {
            hasFrameRef.current = true;
            setHasFrame(true);
          }
          if (isLiveRef.current) {
            if (ts < lastLiveRenderedTsRef.current - 5.0) lastLiveRenderedTsRef.current = 0;
            if (ts >= lastLiveRenderedTsRef.current) {
              lastLiveRenderedTsRef.current = ts;
              renderFrame(img);
            }
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
      const nowSec = Date.now() / 1000;
      if (nowSec > timestamp && nowSec - timestamp > 60) return;
      const jpegBytes = arrayBuffer.slice(16);
      try {
        const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        const history = frameBitmapsRef.current;
        insertFrameSorted({ timestamp, bitmap });
        receivedFrameCountRef.current++;
        if (history.length > 3000) {
          if (historyIndexRef.current < 0 || historyIndexRef.current > 100) {
            const old = history.shift();
            if (old && 'close' in old.bitmap && typeof (old.bitmap as any).close === 'function') (old.bitmap as any).close();
            if (historyIndexRef.current > 0) historyIndexRef.current--;
            if (markedFrameRef.current && markedFrameRef.current.index > 0) {
              markedFrameRef.current.index--;
              setMarkedFrame({ ...markedFrameRef.current });
            }
          }
        }
        if (!hasFrameRef.current) {
          hasFrameRef.current = true;
          setHasFrame(true);
        }
        if (isLiveRef.current) {
          if (timestamp < lastLiveRenderedTsRef.current - 5.0) lastLiveRenderedTsRef.current = 0;
          if (timestamp >= lastLiveRenderedTsRef.current) {
            lastLiveRenderedTsRef.current = timestamp;
            renderFrame(bitmap);
          }
        }
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
      isCatchingUpRef.current = false;
      setIsCatchingUp(false);
      hasFrameRef.current = false;
      setHasFrame(false);
      lastLiveRenderedTsRef.current = 0;
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
  //    quay. Mỗi khung hình trình duyệt (tick), ta CỘNG DỒN vào "đồng hồ ảo" (sourceTimeRef) một
  //    lượng = thời gian thực vừa trôi qua (dtSec) × tốc độ TỨC THỜI hiện tại (currentRateRef —
  //    đang tự "ease" dần về tốc độ mục tiêu, xem mục 3), rồi hiển thị đúng frame gần nhất có
  //    timestamp <= đồng hồ ảo đó. Cách cộng dồn liên tục này (thay vì tính từ một điểm neo cố
  //    định với tốc độ không đổi như bản trước) cho phép tốc độ phát TRÔI MƯỢT theo thời gian mà
  //    vẫn bám đúng timestamp nguồn — không phụ thuộc biết trước fps nguồn là 120/240fps hay dao
  //    động do mạng.
  // 3) RAMP MƯỢT KIỂU IPHONE: video Slo-Mo do iPhone xuất ra không đổi tốc độ đột ngột — đầu/cuối
  //    chạy tốc độ thường, đoạn giữa chậm dần rồi nhanh dần lại. Ta mô phỏng bằng cách KHÔNG dùng
  //    thẳng tốc độ mục tiêu (playbackRateRef) để tính đồng hồ ảo, mà dùng currentRateRef — một
  //    giá trị "đuổi theo" playbackRateRef.current mỗi khung hình theo hàm mũ (ease). Nhờ vậy khi
  //    người dùng bấm đổi tốc độ, chuyển động trôi êm dần sang tốc độ mới thay vì giật cục, và
  //    quan trọng nhất: KHÔNG có khung hình nào bị lướt/bỏ qua để "tua" tới vị trí mới — chỉ có
  //    tốc độ hiển thị thay đổi dần theo thời gian thực.
  // LƯU Ý: dependency chỉ còn [isPlaying, isLive] — CỐ TÌNH bỏ playbackRate ra khỏi mảng phụ
  // thuộc. Nếu để playbackRate trong đó, mỗi lần bấm đổi tốc độ effect sẽ hủy & chạy lại từ đầu,
  // mất hết trạng thái currentRateRef/sourceTimeRef đang có -> tốc độ đổi ĐỘT NGỘT thay vì êm.
  // Thay vào đó, tick() đọc playbackRateRef.current (ref, không phải state) mỗi khung hình để biết
  // tốc độ MỤC TIÊU mới nhất, rồi tự "đuổi theo" dần — đúng cơ chế ramp mượt.
  useEffect(() => {
    if (!isPlaying || isLive) return;

    let rafId: number;
    let lastMs = performance.now();
    let lastUiUpdateMs = 0;

    // Tốc độ hội tụ về target mỗi giây (khoảng 0.3 - 0.4s để ease mượt sang tốc độ slow-mo)
    const EASE_PER_SEC = 5;

    const tick = (nowMs: number) => {
      const dtMs = Math.min(100, Math.max(0, nowMs - lastMs));
      lastMs = nowMs;

      const history = frameBitmapsRef.current;
      if (history.length === 0) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      const targetRate = playbackRateRef.current;
      const dtSec = dtMs / 1000;
      const easeAmount = 1 - Math.exp(-EASE_PER_SEC * dtSec);
      currentRateRef.current += (targetRate - currentRateRef.current) * easeAmount;

      // CHẾ ĐỘ BẮT KỊP LIVE (catch-up, r > 1):
      if (isCatchingUpRef.current) {
        let cur = historyIndexRef.current < 0 ? 0 : historyIndexRef.current;
        if (cur >= history.length - 1) {
          jumpToLive(false);
          return;
        }
        const srcFps = detectedSourceFpsRef.current || 240;
        const framesToAdvance = Math.max(1, Math.round((currentRateRef.current * dtMs) / (1000 / srcFps)));
        const next = Math.min(history.length - 1, cur + framesToAdvance);
        historyIndexRef.current = next;
        if (nowMs - lastUiUpdateMs > 66) {
          lastUiUpdateMs = nowMs;
          setHistoryIndex(next);
        }
        renderFrame(history[next].bitmap);
        rafId = requestAnimationFrame(tick);
        return;
      }

      // CHẾ ĐỘ PHÁT CHẬM SLOW-MOTION:
      // Chuẩn Slo-Mo iOS: Phát mượt mà 60 FPS (hoặc 30 FPS) theo chu kỳ hiển thị màn hình,
      // không phụ thuộc vào jitter/độ trễ mạng giữa các gói tin.
      // BẢO ĐẢM 100% CÁC KHUNG HÌNH LIỀN KỀ NHAU (idx -> idx + 1), KHÔNG BỎ QUA BẤT KỲ KHUNG HÌNH NÀO.
      frameTimeAccumulatorRef.current += dtMs;

      const recordedFps = detectedSourceFpsRef.current || 240;
      const effectiveRate = Math.max(0.01, Math.min(1.0, currentRateRef.current));
      // Tốc độ khung hình hiển thị (target display FPS):
      // Ví dụ: quay 240fps với tốc độ 0.25x -> target 60 FPS hiển thị (16.67ms/frame).
      // Quay 60fps với tốc độ 0.5x -> target 30 FPS hiển thị (33.33ms/frame).
      const targetPlaybackFps = Math.max(10, Math.min(120, recordedFps * effectiveRate));
      const frameDisplayMs = 1000 / targetPlaybackFps;

      let idx = historyIndexRef.current < 0 ? 0 : historyIndexRef.current;
      if (idx + 1 < history.length) {
        if (frameTimeAccumulatorRef.current >= frameDisplayMs) {
          frameTimeAccumulatorRef.current -= frameDisplayMs;
          if (frameTimeAccumulatorRef.current > frameDisplayMs * 2) {
            frameTimeAccumulatorRef.current = 0;
          }

          idx += 1;
          historyIndexRef.current = idx;
          renderFrame(history[idx].bitmap);

          // Throttled UI update để giao diện không bị drop FPS vì re-render liên tục
          if (nowMs - lastUiUpdateMs > 66) {
            lastUiUpdateMs = nowMs;
            setHistoryIndex(idx);
          }
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      if (historyIndexRef.current >= 0) {
        setHistoryIndex(historyIndexRef.current);
      }
    };
  }, [isPlaying, isLive]);

  // Bật / Tắt Phát
  const togglePlay = () => {
    if (!isPlaying && isLive) {
      // Khi đang Live mà bấm dừng -> chuyển sang xem Slow-Mo/DVR từ vị trí gần nhất
      setIsLive(false);
      isLiveRef.current = false;
      const history = frameBitmapsRef.current;
      const startIdx = findStartIndexForDelay(history, SLOWMO_REPLAY_DELAY_SEC);
      historyIndexRef.current = startIdx;
      setHistoryIndex(startIdx);
      sourceTimeRef.current = history[startIdx]?.timestamp ?? null;
      currentRateRef.current = playbackRateRef.current;
      if (history[startIdx]) renderFrame(history[startIdx].bitmap);
    }
    const nextPlaying = !isPlaying;
    setIsPlaying(nextPlaying);
    isPlayingRef.current = nextPlaying;
  };

  // Thay đổi tốc độ phát Slow-Motion. Nguyên tắc: KHÔNG bao giờ lướt/nhảy cóc qua nhiều khung
  // hình liên tiếp để "tua" tới vị trí mới (nhìn giống tua nhanh) — nếu cần đổi vị trí (rời Live),
  // đặt lại vị trí NGAY LẬP TỨC (chỉ 1 lần render, giống một cú cắt cảnh), sau đó để vòng lặp phát
  // chính (currentRateRef) tự "ease" êm dịu từ tốc độ thường xuống tốc độ Slow mục tiêu theo THỜI
  // GIAN, giống hệt cách video Slo-Mo iPhone xuất ra: đầu chạy thường, giữa chậm dần rồi nhanh
  // dần lại — chứ không phải các khung hình bị lướt/tua nhanh qua mắt người xem.
  const handleSpeedChange = (speed: number) => {
    setPlaybackRate(speed);
    showModeNotice(speed < 1 ? 'slow' : 'live', speed < 1 ? `SLOW ${speed}x` : 'LIVE • TRỰC TIẾP');
    playbackRateRef.current = speed;

    // Người dùng chủ động chọn tốc độ khác -> không còn ở chế độ "bắt kịp Live" tự động nữa
    isCatchingUpRef.current = false;
    setIsCatchingUp(false);

    if (speed < 1.0) {
      lastSlowSpeedRef.current = speed;
      if (isLiveRef.current) {
        // Rời Live: neo lại vị trí vài chục khung hình trước đó (đã có sẵn trong buffer) để có
        // đủ khung hình mà "chạy chậm" qua — đặt 1 LẦN DUY NHẤT, không render các khung hình ở
        // giữa, nên không có cảm giác tua/lướt frame.
        setIsLive(false);
        isLiveRef.current = false;

        const history = frameBitmapsRef.current;
        const startIdx = findStartIndexForDelay(history, SLOWMO_REPLAY_DELAY_SEC);
        historyIndexRef.current = startIdx;
        setHistoryIndex(startIdx);
        sourceTimeRef.current = history[startIdx]?.timestamp ?? null;
        // Bắt đầu ramp từ tốc độ THƯỜNG (1.0x) rồi êm dịu giảm dần về tốc độ Slow vừa chọn.
        currentRateRef.current = 1.0;
        if (history[startIdx]) renderFrame(history[startIdx].bitmap);
      }
      // Nếu đang ở trong Slow rồi và chỉ đổi sang mức Slow khác: không cần làm gì thêm —
      // playbackRateRef.current vừa cập nhật ở trên, vòng lặp phát sẽ tự ease currentRateRef
      // tới tốc độ mới một cách mượt mà, không giật, không tua.
      setIsPlaying(true);
      isPlayingRef.current = true;
    } else {
      // Chọn 1.0x trong khi đang xem Slow: KHÔNG cắt cảnh nhảy thẳng về Live như trước — để
      // vòng lặp phát tự tăng tốc mượt (ease currentRateRef -> 1.0x) rồi tự chuyển sang Live
      // ngay khi đuổi kịp khung hình mới nhất (xử lý trong tick() của vòng lặp phát chính).
      if (isLiveRef.current) return; // đã Live sẵn rồi thì không cần làm gì
      setIsPlaying(true);
      isPlayingRef.current = true;
    }
  };

  // Bắt kịp Live thật nhanh mà KHÔNG cắt cảnh: đặt tốc độ mục tiêu lên CATCH_UP_RATE (> 1x) —
  // vòng lặp phát chính sẽ tự "ease" currentRateRef lên tốc độ này (mượt, không giật), khiến gap
  // giữa playhead và live edge co lại dần theo (CATCH_UP_RATE - 1) giây/giây, thay vì đứng yên như
  // khi chọn 1.0x. Khi playhead đuổi kịp khung hình mới nhất, tick() sẽ tự khớp sang Live (xem
  // đoạn xử lý isCatchingUpRef trong vòng lặp phát chính ở trên) — không có cú cắt cảnh nào cả vì
  // lúc đó khung hình đang hiển thị đã chính là khung hình mới nhất.
  const catchUpToLive = () => {
    if (isLiveRef.current) return; // đã Live rồi thì không cần bắt kịp
    isCatchingUpRef.current = true;
    setIsCatchingUp(true);
    setPlaybackRate(CATCH_UP_RATE);
    playbackRateRef.current = CATCH_UP_RATE;
    setIsPlaying(true);
    isPlayingRef.current = true;
    // KHÔNG đổi sourceTimeRef/historyIndexRef ở đây -> giữ nguyên vị trí đang xem, để currentRateRef
    // tự ease êm dịu lên CATCH_UP_RATE, không có khung hình nào bị lướt/bỏ qua.
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
    sourceTimeRef.current = history[target]?.timestamp ?? null;
    if (history[target]) {
      renderFrame(history[target].bitmap);
    }
  };

  // Nhảy ngay về xem Trực Tiếp (Live)
  const jumpToLive = (showNotice = true) => {
    setIsLive(true);
    isLiveRef.current = true;
    setIsPlaying(true);
    isPlayingRef.current = true;
    setPlaybackRate(1.0);
    playbackRateRef.current = 1.0;
    currentRateRef.current = 1.0;
    sourceTimeRef.current = null;
    frameTimeAccumulatorRef.current = 0;
    isCatchingUpRef.current = false;
    setIsCatchingUp(false);
    historyIndexRef.current = -1;
    setHistoryIndex(-1);
    const history = frameBitmapsRef.current;
    if (history.length > 0) {
      lastLiveRenderedTsRef.current = history[history.length - 1].timestamp;
      renderFrame(history[history.length - 1].bitmap);
    }
    if (showNotice) {
      showModeNotice(
        'live',
        '🔴 LIVE • ĐANG PHÁT TRỰC TIẾP',
        'Đã chuyển về luồng video thời gian thực',
        'Bấm [Enter] để gắn mốc & tua chậm'
      );
    }
  };

  // Nhảy về đúng mốc khung hình đã gắn
  const jumpToMarker = () => {
    if (!markedFrameRef.current) return;
    const marker = markedFrameRef.current;
    const history = frameBitmapsRef.current;
    if (marker.index >= 0 && marker.index < history.length) {
      setIsLive(false);
      isLiveRef.current = false;
      setIsPlaying(true);
      isPlayingRef.current = true;
      historyIndexRef.current = marker.index;
      setHistoryIndex(marker.index);
      frameTimeAccumulatorRef.current = 0;
      renderFrame(history[marker.index].bitmap);
      showModeNotice(
        'slow',
        '📍 VỀ MỐC KHUNG HÌNH',
        `Đang xem khung hình #${marker.index + 1} (${marker.timeStr})`,
        'Bấm [Enter] để quay về LIVE'
      );
    }
  };

  // Kéo thanh trượt DVR Seekbar
  const handleSeekSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const idx = parseInt(e.target.value, 10);
    setIsLive(false);
    isLiveRef.current = false;
    historyIndexRef.current = idx;
    setHistoryIndex(idx);
    frameTimeAccumulatorRef.current = 0;
    const history = frameBitmapsRef.current;
    if (history[idx]) {
      renderFrame(history[idx].bitmap);
    }
  };

  const speedOptions = [0.05, 0.1, 0.125, 0.25, 0.5, 0.75, 1.0];

  // ============================================================================
  // ENTER = đổi chế độ Live <-> Slow-Mo và gắn mốc khung hình chuẩn iOS
  const handleEnterModeSwitch = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
    if (isTextOverlayOpen) return;

    // Nếu người dùng đang gõ vào input hoặc textarea (ví dụ ô nhập thẻ bài), không can thiệp để họ gõ Enter bình thường
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as any).isContentEditable)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (isLiveRef.current) {
      // 1. ĐANG PHÁT LIVE: Bấm Enter -> GẮN MỐC KHUNG HÌNH VÀ TUA CHẬM CHUẨN IOS
      const history = frameBitmapsRef.current;
      if (history.length === 0) return;

      const liveIdx = history.length - 1;
      const liveTs = history[liveIdx]?.timestamp || Date.now() / 1000;
      const d = new Date();
      const timeStr = d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');

      const marker: MarkedFrame = {
        index: liveIdx,
        timestamp: liveTs,
        timeStr
      };
      markedFrameRef.current = marker;
      setMarkedFrame(marker);

      const srcFps = estimateSourceFps(history);
      detectedSourceFpsRef.current = srcFps;
      setDetectedSourceFps(srcFps);

      const autoRate = computeAutoSlowRate(srcFps);
      const targetSlowRate = lastSlowSpeedRef.current && lastSlowSpeedRef.current < 1.0
        ? lastSlowSpeedRef.current
        : autoRate;

      setIsLive(false);
      isLiveRef.current = false;
      setIsPlaying(true);
      isPlayingRef.current = true;

      // Đặt playhead ngay tại khung hình mốc vừa gắn
      historyIndexRef.current = liveIdx;
      setHistoryIndex(liveIdx);
      frameTimeAccumulatorRef.current = 0;
      isCatchingUpRef.current = false;
      setIsCatchingUp(false);

      // Bắt đầu tốc độ tức thời từ 1.0x rồi ease mượt về targetSlowRate (giống video Slo-Mo iPhone xuất ra)
      setPlaybackRate(targetSlowRate);
      playbackRateRef.current = targetSlowRate;
      currentRateRef.current = 1.0;

      renderFrame(history[liveIdx].bitmap);

      showModeNotice(
        'slow',
        '🐢 SLOW MOTION • ĐANG TUA CHẬM',
        `Đã gắn mốc khung hình #${liveIdx + 1} (${timeStr}) • Tốc độ: ${targetSlowRate}x`,
        'Bấm [Enter] lần nữa để quay về LIVE'
      );
    } else {
      // 2. ĐANG Ở SLOW-MO: Bấm Enter lần nữa -> QUAY VỀ LIVE BÌNH THƯỜNG
      jumpToLive(true);
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
  }, [isTextOverlayOpen]);

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
            <span>{isLive ? `LIVE • ${detectedSourceFps}FPS` : `SLOW • ${playbackRate}x`}</span>
          </div>
          <span className="text-xs font-medium text-slate-300 truncate max-w-[180px] sm:max-w-none">
            {roomName ? `Room: ${roomName}` : (stream ? `Streamer: ${stream.username}` : 'Đang chờ luồng Live...')}
          </span>
        </div>

        <div className="flex items-center space-x-1.5 sm:space-x-2 self-end sm:self-auto">
          <span className="px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-300 text-[10px] font-mono font-medium border border-amber-500/30 flex items-center gap-1" title="Địa chỉ IP Server để nhập trên app iPhone">
            Host: {detectedServerUrl.replace('https://', '').replace('http://', '')}
          </span>
          <span
            className="px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 text-[10px] font-mono font-medium border border-indigo-500/30"
            title="Fps quay camera đo được tự động từ khoảng cách timestamp thật giữa các frame (không phải số cố định)"
          >
            {detectedSourceFps} FPS
          </span>
          <span
            className={`px-1.5 py-0.2 rounded text-[10px] font-mono font-medium border ${
              receivedFps >= 180
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                : receivedFps >= 90
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                : 'bg-red-500/20 text-red-300 border-red-500/30'
            }`}
            title="Số khung hình THỰC SỰ nhận/giải mã được mỗi giây (khác với 240 FPS camera báo cáo). Số này thấp nghĩa là đang bị rớt frame ở đâu đó trước khi tới Web (mạng hoặc camera không kịp encode)."
          >
            {receivedFps} FPS thực nhận
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
                onClick={() => jumpToLive(true)}
                className="px-2.5 py-1 rounded-full bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white font-bold text-[10px] sm:text-[11px] uppercase tracking-wider flex items-center shadow-lg shadow-red-600/40 transition-all active:scale-95 animate-pulse"
                title="Bấm để nhảy ngay về hình ảnh Trực Tiếp (Live)"
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                Về Live
              </button>

              <span className={`px-2.5 py-1 rounded-full font-bold font-mono text-[10px] sm:text-[11px] border flex items-center shadow-md backdrop-blur-md ${
                isCatchingUp
                  ? 'bg-emerald-500/25 text-emerald-300 border-emerald-500/40 animate-pulse'
                  : 'bg-amber-500/25 text-amber-300 border-amber-500/40'
              }`}>
                <Gauge className={`w-3.5 h-3.5 mr-1 ${isCatchingUp ? 'text-emerald-400' : 'text-amber-400'}`} />
                {isCatchingUp
                  ? 'Đang bắt kịp Live...'
                  : `Slow ${playbackRate}x ${isPlaying ? '• Đang tua chậm' : '• Tạm dừng'}`}
              </span>

              {markedFrame && (
                <button
                  type="button"
                  onClick={jumpToMarker}
                  className="px-2.5 py-1 rounded-full bg-amber-500/25 hover:bg-amber-500/40 text-amber-300 font-bold font-mono text-[10px] sm:text-[11px] border border-amber-400/50 flex items-center shadow-md transition-all active:scale-95"
                  title="Bấm để nhảy về đúng mốc khung hình đã gắn"
                >
                  <span className="mr-1">📍</span>
                  <span>Mốc #{markedFrame.index + 1} ({markedFrame.timeStr})</span>
                </button>
              )}

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
        <div className="flex items-center justify-between gap-2 pb-1">
          <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-[11px] sm:text-xs font-black font-mono ${
            isLive
              ? 'bg-red-600/20 text-red-300 border-red-500/40'
              : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
          }`}>
            <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-red-400 animate-pulse' : 'bg-amber-400'}`} />
            {isLive ? 'CHẾ ĐỘ: LIVE • TRỰC TIẾP' : `CHẾ ĐỘ: SLOW • ${playbackRate}x`}
          </div>
          {!isLive && (
            <button
              type="button"
              onClick={() => jumpToLive(true)}
              className="px-3 py-1 rounded-full bg-red-600 hover:bg-red-500 text-white text-[11px] font-bold transition-all active:scale-95"
            >
              VỀ LIVE
            </button>
          )}
        </div>

        {/* DVR Frame Buffer Seekbar với Ghim Mốc trực quan */}
        <div className="flex items-center space-x-2">
          <span className="text-[10px] sm:text-[11px] font-mono text-slate-400 min-w-[45px]">
            #{historyIndex >= 0 ? historyIndex + 1 : bufferCount}
          </span>
          <div className="relative w-full flex items-center py-1">
            <input
              type="range"
              min={0}
              max={Math.max(0, bufferCount - 1)}
              value={historyIndex >= 0 ? historyIndex : Math.max(0, bufferCount - 1)}
              onChange={handleSeekSlider}
              className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500 hover:accent-indigo-400"
            />
            {markedFrame && bufferCount > 1 && (
              <button
                type="button"
                onClick={jumpToMarker}
                style={{
                  left: `${Math.min(99, Math.max(1, (markedFrame.index / Math.max(1, bufferCount - 1)) * 100))}%`
                }}
                className="absolute -top-1 -translate-x-1/2 w-3.5 h-3.5 bg-amber-400 hover:bg-amber-300 rounded-full border-2 border-slate-900 shadow-lg cursor-pointer transition-transform hover:scale-125 z-10"
                title={`Mốc khung hình đã gắn: #${markedFrame.index + 1} (${markedFrame.timeStr}) - Bấm để nhảy về mốc này`}
              />
            )}
          </div>
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

            {/* Nút Nhảy về Mốc Khung Hình đã gắn */}
            {markedFrame && (
              <button
                onClick={jumpToMarker}
                className="px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-bold flex items-center space-x-1 transition-all active:scale-95"
                title={`Nhảy về mốc khung hình #${markedFrame.index + 1} (${markedFrame.timeStr})`}
              >
                <span>📍 Về Mốc</span>
              </button>
            )}

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
            <div
              className="flex items-center space-x-0.5 px-1 text-indigo-400 text-[10px] sm:text-[11px] font-semibold flex-shrink-0"
              title={`Enter tự động chọn tốc độ = ${TARGET_PLAYBACK_FPS}fps / ${detectedSourceFps}fps quay = ${computeAutoSlowRate(detectedSourceFps)}x`}
            >
              <Gauge className="w-3 h-3" />
              <span>Slow (Enter tự {computeAutoSlowRate(detectedSourceFps)}x):</span>
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
