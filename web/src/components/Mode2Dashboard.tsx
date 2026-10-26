import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Hls from 'hls.js';
import { StreamSession, User, CardEntry } from '../types';
import { Socket } from 'socket.io-client';
import {
  RotateCcw,
  RotateCw,
  ArrowLeftRight,
  Sliders,
  Settings,
  Layers,
  Sparkles,
  Maximize2,
  Volume2,
  VolumeX,
  Play,
  Pause,
  Sun,
  Eye,
  CheckCircle2,
  Award,
  Crosshair,
  Lock,
  Unlock,
  Radio,
  ChevronLeft,
  ChevronRight,
  Plus,
  Minus,
  Undo2,
  Trash2,
  Clock,
  Wifi
} from 'lucide-react';
import { evaluate3Cards, parseCardRank, getRankLabel } from '../utils/cardRules';
import { CardPickerPopup, CardPickerTarget } from './CardPickerPopup';

interface Mode2DashboardProps {
  stream: StreamSession | null;
  socket: Socket | null;
  roomId: string;
  roomName: string;
  user: User;
  onFinishRound?: () => void;
}

interface RoundHistory {
  roundNum: number;
  hands: { [doorIndex: number]: string[] };
  scores: { [doorIndex: number]: { title: string; points: number } };
  winnerDoor: number;
}

const SUIT_DISPLAY: Record<string, { symbol: string; color: string; isRed: boolean }> = {
  'H': { symbol: '♥', color: 'text-red-500', isRed: true },
  'D': { symbol: '♦', color: 'text-red-500', isRed: true },
  'C': { symbol: '♣', color: 'text-slate-100', isRed: false },
  'S': { symbol: '♠', color: 'text-slate-100', isRed: false },
  'CƠ': { symbol: '♥', color: 'text-red-500', isRed: true },
  'RÔ': { symbol: '♦', color: 'text-red-500', isRed: true },
  'TÉP': { symbol: '♣', color: 'text-slate-100', isRed: false },
  'BÍCH': { symbol: '♠', color: 'text-slate-100', isRed: false },
};

function formatCardItem(raw: string): { rank: string; symbol: string; isRed: boolean; full: string } {
  if (!raw) return { rank: '', symbol: '', isRed: false, full: '' };
  const s = raw.trim().toUpperCase();
  
  for (const [key, val] of Object.entries(SUIT_DISPLAY)) {
    if (s.endsWith(key)) {
      const rankPart = s.slice(0, -key.length).trim();
      return { rank: rankPart, symbol: val.symbol, isRed: val.isRed, full: `${rankPart}${val.symbol}` };
    }
  }

  // Symbol trực tiếp trong chuỗi
  if (s.includes('♥')) return { rank: s.replace('♥', '').trim(), symbol: '♥', isRed: true, full: s };
  if (s.includes('♦')) return { rank: s.replace('♦', '').trim(), symbol: '♦', isRed: true, full: s };
  if (s.includes('♣')) return { rank: s.replace('♣', '').trim(), symbol: '♣', isRed: false, full: s };
  if (s.includes('♠')) return { rank: s.replace('♠', '').trim(), symbol: '♠', isRed: false, full: s };

  return { rank: s, symbol: '', isRed: false, full: s };
}

// Hàm phát tiếng beep ngắn thông báo đã bắt được bài
function playBeepSound() {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime); // Note A5
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch {
    // AudioContext blocked by browser policy
  }
}

export const Mode2Dashboard: React.FC<Mode2DashboardProps> = ({
  stream,
  socket,
  roomId,
  roomName,
  user,
  onFinishRound
}) => {
  // Cấu hình Bàn chơi (Mặc định 7 Cửa, 3 Lá/Cửa)
  const [playerCount, setPlayerCount] = useState<number>(() => {
    const saved = localStorage.getItem('mode2_player_count');
    return saved ? parseInt(saved, 10) : 7;
  });

  const [cardsPerPlayer, setCardsPerPlayer] = useState<number>(() => {
    const saved = localStorage.getItem('mode2_cards_per_player');
    return saved ? parseInt(saved, 10) : 3;
  });

  // Trạng thái bài của từng Cửa: { [doorIndex 1..7]: string[] }
  const [doorCards, setDoorCards] = useState<{ [doorIndex: number]: string[] }>({});
  
  // Lịch sử các ván trước
  const [roundHistories, setRoundHistories] = useState<RoundHistory[]>(() => {
    const saved = localStorage.getItem('mode2_histories');
    return saved ? JSON.parse(saved) : [];
  });

  // Tăng sáng và tương phản video
  const [isBrightBoost, setIsBrightBoost] = useState<boolean>(true);
  // Chế độ phóng to lấp đầy màn hình (Fill/Cover vs Contain)
  const [isFillMode, setIsFillMode] = useState<boolean>(() => {
    return localStorage.getItem('mode2_video_fill') !== 'false';
  });

  useEffect(() => {
    localStorage.setItem('mode2_video_fill', isFillMode.toString());
  }, [isFillMode]);


  // Kích thước khung ngắm AI (Dài x Rộng)
  const [reticleSize, setReticleSize] = useState<{ width: number; height: number }>(() => {
    const saved = localStorage.getItem('mode2_reticle_size');
    return saved ? JSON.parse(saved) : { width: 220, height: 280 };
  });

  // Tọa độ Khung ngắm AI đỏ (bám chuột hoặc ghim)
  const [reticlePos, setReticlePos] = useState<{ x: number; y: number }>({ x: 120, y: 80 });
  const [isReticleLocked, setIsReticleLocked] = useState<boolean>(false);
  const [isReticleActive, setIsReticleActive] = useState<boolean>(true);

  // Trạng thái nhận diện AI
  const [aiStatus, setAiStatus] = useState<string>('Đang quét trong khung...');
  const [lastDetectedCard, setLastDetectedCard] = useState<string | null>(null);
  const [isAiFlashing, setIsAiFlashing] = useState<boolean>(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(0.35);

  // Refs video & canvas
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isScanningRef = useRef<boolean>(false);
  const lastDetectionTimeRef = useRef<number>(0);
  const lastDetectedCodeRef = useRef<string>('');
  
  // Bộ đệm lọc ảnh rõ nhất và đỉnh độ tin cậy (Peak Clarity Buffer)
  const candidateRef = useRef<{
    code: string;
    fullName: string;
    display: string;
    confidence: number;
    sharpness: number;
    count: number;
    firstSeen: number;
  } | null>(null);

  // Trạng thái điều khiển video: Live vs Tua lại
  const [isLive, setIsLive] = useState<boolean>(true);
  const [seekTime, setSeekTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(true);

  // Lật & Xoay khung hình
  const [isFlipped, setIsFlipped] = useState<boolean>(() => {
    return localStorage.getItem('mode2_video_flipped') === 'true';
  });
  const [rotation, setRotation] = useState<number>(() => {
    const s = localStorage.getItem('mode2_video_rotation');
    return s ? parseInt(s, 10) : 0;
  });

  // Tốc độ phát lại (Playback Rate: 1x, 0.5x, 0.25x, 0.125x)
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  // Địa chỉ IP Wi-Fi Server
  const [serverLanIp, setServerLanIp] = useState<string>('');
  const [copiedIp, setCopiedIp] = useState<boolean>(false);

  useEffect(() => {
    fetch('/api/server-info')
      .then((r) => r.json())
      .then((d) => {
        if (d.primaryIp) setServerLanIp(d.primaryIp);
      })
      .catch(() => {
        setServerLanIp(window.location.hostname);
      });
  }, []);

  const handleCopyIp = () => {
    const ip = serverLanIp || window.location.hostname;
    navigator.clipboard.writeText(`http://${ip}:4000`);
    setCopiedIp(true);
    setTimeout(() => setCopiedIp(false), 2000);
  };


  // Hiển thị thanh chỉnh kích thước khung ngắm
  const [showSizeControls, setShowSizeControls] = useState<boolean>(false);

  // Modal Card Picker để chỉnh sửa thủ công nếu cần
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<CardPickerTarget>({
    mode: 'add',
    groupNum: 1,
    slotIndex: 0
  });

  // Lưu cấu hình
  useEffect(() => {
    localStorage.setItem('mode2_player_count', playerCount.toString());
  }, [playerCount]);

  useEffect(() => {
    localStorage.setItem('mode2_video_flipped', isFlipped.toString());
  }, [isFlipped]);

  useEffect(() => {
    localStorage.setItem('mode2_video_rotation', rotation.toString());
  }, [rotation]);

  useEffect(() => {
    localStorage.setItem('mode2_cards_per_player', cardsPerPlayer.toString());
  }, [cardsPerPlayer]);

  useEffect(() => {
    localStorage.setItem('mode2_reticle_size', JSON.stringify(reticleSize));
  }, [reticleSize]);

  useEffect(() => {
    localStorage.setItem('mode2_histories', JSON.stringify(roundHistories.slice(-20)));
  }, [roundHistories]);

  // Tìm cửa và slot tiếp theo đang chờ lá bài
  const nextTarget = useMemo(() => {
    // Vòng 1: Cửa 1->7 lá 1. Vòng 2: Cửa 1->7 lá 2...
    for (let round = 0; round < cardsPerPlayer; round++) {
      for (let door = 1; door <= playerCount; door++) {
        const cards = doorCards[door] || [];
        if (cards.length === round) {
          return { door, slot: round };
        }
      }
    }
    return null; // Đã đủ bài cho tất cả các cửa
  }, [doorCards, playerCount, cardsPerPlayer]);

  // Đánh giá điểm từng Cửa
  const evaluations = useMemo(() => {
    const res: { [door: number]: any } = {};
    for (let d = 1; d <= playerCount; d++) {
      res[d] = evaluate3Cards(doorCards[d] || []);
    }
    return res;
  }, [doorCards, playerCount]);

  // Tìm Cửa thắng cuộc trong ván hiện tại
  const winnerDoor = useMemo(() => {
    let bestDoor = 0;
    let maxPoints = -1;
    for (let d = 1; d <= playerCount; d++) {
      const ev = evaluations[d];
      if (ev && ev.points > maxPoints && (doorCards[d] || []).length === cardsPerPlayer) {
        maxPoints = ev.points;
        bestDoor = d;
      }
    }
    return bestDoor;
  }, [evaluations, doorCards, playerCount, cardsPerPlayer]);

  // Ghi nhận lá bài vào Cửa theo vòng (Round-Robin)
  const addCardToActiveDoor = useCallback((cardCode: string) => {
    if (!nextTarget) return;

    setDoorCards((prev) => {
      const current = prev[nextTarget.door] || [];
      if (current.length >= cardsPerPlayer) return prev;
      return {
        ...prev,
        [nextTarget.door]: [...current, cardCode]
      };
    });

    playBeepSound();
    setIsAiFlashing(true);
    setTimeout(() => setIsAiFlashing(false), 450);

    // Đồng bộ socket nếu có
    if (socket && roomId) {
      socket.emit('card_added', {
        roomId,
        cardValue: cardCode,
        groupIndex: nextTarget.door,
        sequenceOrder: Date.now()
      });
    }
  }, [nextTarget, cardsPerPlayer, socket, roomId]);

  // Hoàn tác lá bài vừa nhận gần nhất
  const handleUndo = () => {
    // Tìm lá bài được chia gần nhất
    let lastDoor = -1;
    for (let d = playerCount; d >= 1; d--) {
      const cards = doorCards[d] || [];
      if (cards.length > 0) {
        if (lastDoor === -1 || cards.length > (doorCards[lastDoor] || []).length) {
          lastDoor = d;
        }
      }
    }

    if (lastDoor !== -1) {
      setDoorCards((prev) => {
        const cur = prev[lastDoor] || [];
        return {
          ...prev,
          [lastDoor]: cur.slice(0, -1)
        };
      });
    }
  };

  // Ván Mới (Lưu kết quả ván cũ vào lịch sử & xóa bài bàn hiện tại)
  const handleNewRound = () => {
    const hasAnyCards = Object.values(doorCards).some((c) => c && c.length > 0);
    if (hasAnyCards) {
      const scoreMap: { [door: number]: { title: string; points: number } } = {};
      for (let d = 1; d <= playerCount; d++) {
        scoreMap[d] = {
          title: evaluations[d]?.title || 'Chưa đủ lá',
          points: evaluations[d]?.points || 0
        };
      }

      const newHistory: RoundHistory = {
        roundNum: roundHistories.length + 1,
        hands: { ...doorCards },
        scores: scoreMap,
        winnerDoor: winnerDoor || 1
      };

      setRoundHistories((prev) => [newHistory, ...prev]);
    }

    setDoorCards({});
    if (socket && roomId) {
      socket.emit('cards_cleared', { roomId });
    }
    if (onFinishRound) onFinishRound();
  };

  // Xử lý di chuyển chuột trên Video để Khung ngắm bám theo
  const handleVideoMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isReticleLocked || !videoContainerRef.current) return;
    const rect = videoContainerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Đặt tâm khung ngắm ngay tại con trỏ chuột
    const newX = Math.max(0, Math.min(rect.width - reticleSize.width, mouseX - reticleSize.width / 2));
    const newY = Math.max(0, Math.min(rect.height - reticleSize.height, mouseY - reticleSize.height / 2));

    setReticlePos({ x: newX, y: newY });
  };

  // Click vào Video để Ghim / Nhả ghim vị trí khung ngắm
  const handleVideoClick = () => {
    setIsReticleLocked((prev) => !prev);
  };

  const hlsRef = useRef<Hls | null>(null);
  const [hasVideoSignal, setHasVideoSignal] = useState<boolean>(false);

  // KẾT NỐI LUỒNG VIDEO HLS (TƯƠNG THÍCH HOÀN HẢO CHROME / EDGE / COC COC)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!stream?.streamKey) {
      console.log('[Mode2] Đang chờ luồng stream từ camera...');
      setHasVideoSignal(false);
      return;
    }

    const streamKey = stream.streamKey;
    const replayUrl = `/replay/${streamKey}/index.m3u8`;
    const liveUrl = `/live/${streamKey}/index.m3u8`;
    let isCancelled = false;

    console.log(`[Mode2] Bắt đầu kết nối luồng: ${replayUrl}`);

    const waitForPlaylist = async (): Promise<string | null> => {
      for (let i = 0; i < 25 && !isCancelled; i++) {
        // Thử replay trước (nơi FFmpeg ghi video chuẩn)
        try {
          const res = await fetch(replayUrl, { cache: 'no-store' });
          if (res.ok) {
            console.log(`[Mode2] Playlist ${replayUrl} đã sẵn sàng!`);
            return replayUrl;
          }
        } catch {}

        // Thử live fallback
        try {
          const res2 = await fetch(liveUrl, { cache: 'no-store' });
          if (res2.ok) {
            console.log(`[Mode2] Playlist ${liveUrl} đã sẵn sàng!`);
            return liveUrl;
          }
        } catch {}

        await new Promise((r) => setTimeout(r, 600));
      }
      return null;
    };

    (async () => {
      const targetUrl = await waitForPlaylist();
      if (isCancelled || !targetUrl) return;

      if (Hls.isSupported()) {
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 20,
          maxBufferLength: 8,
          maxMaxBufferLength: 16,
          maxBufferSize: 128 * 1024 * 1024,
          maxBufferHole: 0.05,
          nudgeOffset: 0.01,
          nudgeMaxRetry: 3,
          highBufferWatchdogPeriod: 0,
          liveSyncDuration: 2.0,
          liveMaxLatencyDuration: 4.0,
          maxLiveSyncPlaybackRate: 1.05
        });

        hlsRef.current = hls;
        hls.loadSource(targetUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setHasVideoSignal(true);
          video.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                hls.recoverMediaError();
                break;
              default:
                hls.destroy();
                break;
            }
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = targetUrl;
        video.play().catch(() => {});
        setHasVideoSignal(true);
      }
    })();

    return () => {
      isCancelled = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [stream?.streamKey]);

  // Kéo handle góc dưới-phải để resize khung ngắm thủ công
  const handleReticleResizeMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = reticleSize.width;
    const startH = reticleSize.height;

    const onMouseMove = (moveEv: MouseEvent) => {
      const dw = moveEv.clientX - startX;
      const dh = moveEv.clientY - startY;
      setReticleSize({
        width: Math.max(100, Math.min(450, startW + dw)),
        height: Math.max(120, Math.min(500, startH + dh))
      });
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // VÒNG LẶP AI QUÉT KHUNG THỜI GIAN THỰC SIÊU TỐC (80ms) - BẮT DÍNH BÀI LƯỚT NHANH
  useEffect(() => {
    if (!isReticleActive) return;

    const interval = setInterval(() => {
      if (isScanningRef.current) return;
      const video = videoRef.current;
      const container = videoContainerRef.current;
      if (!video || !container || video.videoWidth === 0 || video.paused || video.ended) return;

      const containerRect = container.getBoundingClientRect();
      const W = containerRect.width;
      const H = containerRect.height;
      if (W === 0 || H === 0) return;

      if (!canvasRef.current) {
        canvasRef.current = document.createElement('canvas');
      }
      const canvas = canvasRef.current;
      const targetW = 220;
      const targetH = Math.max(40, Math.round(targetW * (reticleSize.height / reticleSize.width)));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      // Xóa canvas sạch sẽ trước khi vẽ
      ctx.clearRect(0, 0, targetW, targetH);
      ctx.save();

      // BƯỚC 1: Scale từ tọa độ khung ngắm trên màn hình sang canvas 220px
      const s = targetW / reticleSize.width;
      ctx.scale(s, s);
      // Dịch gốc tọa độ về góc trên trái của khung ngắm
      ctx.translate(-reticlePos.x, -reticlePos.y);

      // BƯỚC 2: Di chuyển về tâm Container video để áp dụng đúng ma trận biến hình hiển thị
      ctx.translate(W / 2, H / 2);

      // Áp dụng biến hình Xoay & Lật video y hệt CSS trên màn hình
      if (rotation === 90 || rotation === 270) {
        const fillScale = isFillMode ? 1.78 : 1;
        ctx.scale(fillScale, fillScale);
        ctx.rotate((rotation * Math.PI) / 180);
      } else if (rotation === 180) {
        ctx.rotate(Math.PI);
      }
      if (isFlipped) {
        ctx.scale(-1, 1);
      }

      // BƯỚC 3: Tính toán kích thước hiển thị video (object-fit contain vs cover)
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      let renderW = W;
      let renderH = H;
      const containerRatio = W / H;
      const videoRatio = vw / vh;

      if (!isFillMode) {
        // object-contain
        if (videoRatio > containerRatio) {
          renderW = W;
          renderH = W / videoRatio;
        } else {
          renderH = H;
          renderW = H * videoRatio;
        }
      } else {
        // object-cover
        if (videoRatio > containerRatio) {
          renderH = H;
          renderW = H * videoRatio;
        } else {
          renderW = W;
          renderH = W / videoRatio;
        }
      }

      // Vẽ video chuẩn xác tại tâm (0,0)
      ctx.drawImage(video, -renderW / 2, -renderH / 2, renderW, renderH);
      ctx.restore();

      // SỬ DỤNG toBlob BẤT ĐỒNG BỘ ĐỂ KHÔNG CHẶN MAIN THREAD
      isScanningRef.current = true;
      canvas.toBlob((blob) => {
        if (!blob) {
          isScanningRef.current = false;
          return;
        }

        const reader = new FileReader();
        reader.onloadend = async () => {
          const b64 = reader.result as string;
          try {
            const res = await fetch('/api/ai/yolo-detect', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                imageBase64: b64,
                confidence: confidenceThreshold,
                imgsz: 192,
                minSharpness: 0
              })
            });

            if (res.ok) {
              const json = await res.json();
              if (json.cards && json.cards.length > 0) {
                const best = json.bestCard || json.cards[0];
                const now = Date.now();
                const isSameCard = best.code === lastDetectedCodeRef.current;
                const timeDiff = now - lastDetectionTimeRef.current;

                // BẮT DÍNH TỨC THÌ KHI LƯỚT BÀI NGANG QUA KHUNG (Độ tin cậy >= 38%)
                if ((!isSameCard || timeDiff > 900) && best.confidence >= 0.38) {
                  lastDetectionTimeRef.current = now;
                  lastDetectedCodeRef.current = best.code;
                  addCardToActiveDoor(best.code);
                  setAiStatus(`⚡ Bắt dính: ${best.fullName} (${Math.round(best.confidence * 100)}%)`);
                  setLastDetectedCard(best.display);
                  setIsAiFlashing(true);
                  setTimeout(() => setIsAiFlashing(false), 300);
                } else {
                  setAiStatus(`Đang thấy: ${best.fullName} (${Math.round(best.confidence * 100)}%)`);
                }
              } else {
                setAiStatus('Đang quét trong khung đỏ (80ms)...');
              }
            }
          } catch {
            // Standby
          } finally {
            isScanningRef.current = false;
          }
        };
        reader.readAsDataURL(blob);
      }, 'image/jpeg', 0.80);
    }, 80);

    return () => clearInterval(interval);
  }, [isReticleActive, reticlePos, reticleSize, confidenceThreshold, isFlipped, rotation, isFillMode, addCardToActiveDoor]);

  // Xử lý tua lại video
  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setSeekTime(val);
    if (videoRef.current) {
      videoRef.current.currentTime = val;
    }
    setIsLive(false);
  };

  const jumpToLive = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = videoRef.current.duration || 999999;
    }
    setIsLive(true);
  };

  return (
    <div className="space-y-3 pb-8">
      {/* 1. THANH HEADER ĐIỀU KHIỂN TRÊN CÙNG (Đúng ảnh mẫu) */}
      <div className="bg-slate-900/90 border border-slate-700/80 rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2 shadow-lg backdrop-blur">
        {/* Nhóm điều chỉnh Số Cửa & Số Lá */}
        <div className="flex items-center space-x-3 text-xs sm:text-sm">
          {/* Số cửa chơi */}
          <div className="flex items-center space-x-1.5 bg-slate-800/90 border border-slate-700 px-2.5 py-1 rounded-lg">
            <span className="font-semibold text-slate-300 whitespace-nowrap">Số cửa chơi:</span>
            <button
              onClick={() => setPlayerCount((p) => Math.max(1, p - 1))}
              className="w-5 h-5 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center transition active:scale-95"
            >
              <Minus className="w-3 h-3" />
            </button>
            <span className="w-5 text-center font-bold text-amber-400 font-mono text-sm">{playerCount}</span>
            <button
              onClick={() => setPlayerCount((p) => Math.min(10, p + 1))}
              className="w-5 h-5 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center transition active:scale-95"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>

          {/* Số lá / cửa */}
          <div className="flex items-center space-x-1.5 bg-slate-800/90 border border-slate-700 px-2.5 py-1 rounded-lg">
            <span className="font-semibold text-slate-300 whitespace-nowrap">Số lá/cửa:</span>
            <button
              onClick={() => setCardsPerPlayer((c) => Math.max(1, c - 1))}
              className="w-5 h-5 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center transition active:scale-95"
            >
              <Minus className="w-3 h-3" />
            </button>
            <span className="w-5 text-center font-bold text-amber-400 font-mono text-sm">{cardsPerPlayer}</span>
            <button
              onClick={() => setCardsPerPlayer((c) => Math.min(5, c + 1))}
              className="w-5 h-5 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center transition active:scale-95"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Trạng thái kết nối */}
        <div className="flex items-center space-x-2 text-[11px] sm:text-xs text-slate-300 font-mono bg-slate-950/70 border border-slate-800 px-3 py-1 rounded-lg">
          <span className="text-slate-500 font-bold">|| Kết nối</span>
          <span className="text-slate-600">|</span>
          <span className="flex items-center space-x-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Máy chủ: <strong className="text-emerald-400">đã kết nối</strong></span>
          </span>
          <span className="text-slate-600">|</span>
          <span className="text-indigo-300">
            SERVER NET: <strong className="text-white">{stream ? 'đang nhận video' : 'sẵn sàng'}</strong>
          </span>
        </div>

        {/* Huy hiệu Wi-Fi Server IP cho iPhone */}
        <button
          type="button"
          onClick={handleCopyIp}
          className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-500/60 text-emerald-300 text-xs font-mono transition-all active:scale-95 shadow-sm"
          title="Click để sao chép địa chỉ Wi-Fi Server này nhập vào iPhone"
        >
          <Wifi className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
          <span>Wi-Fi IP: <strong className="text-white underline">{serverLanIp || '192.168.1.197'}:4000</strong></span>
          <span className="text-[10px] bg-emerald-700 hover:bg-emerald-600 text-white font-sans px-1.5 py-0.5 rounded font-bold">
            {copiedIp ? '✓ Đã chép' : 'Copy'}
          </span>
        </button>


        {/* Nút Ván mới, Hoàn tác & Cài đặt */}
        <div className="flex items-center space-x-2">
          {/* Nút Hoàn tác */}
          <button
            onClick={handleUndo}
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 text-xs font-bold flex items-center space-x-1 transition active:scale-95"
            title="Xóa lá bài vừa nhận gần nhất"
          >
            <Undo2 className="w-3.5 h-3.5" />
            <span>Hoàn tác</span>
          </button>

          {/* Nút Cài đặt */}
          <button
            onClick={() => setIsReticleActive((prev) => !prev)}
            className={`px-3 py-1 rounded-lg text-xs font-bold flex items-center space-x-1 transition shadow active:scale-95 ${
              isReticleActive ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/30' : 'bg-slate-800 text-slate-400'
            }`}
          >
            <Crosshair className="w-3.5 h-3.5 mr-0.5" />
            <span>{isReticleActive ? 'Khung AI: BẬT' : 'Khung AI: TẮT'}</span>
          </button>

          {/* Nút Ván Mới (Màu đỏ nổi bật) */}
          <button
            onClick={handleNewRound}
            className="px-3.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-black shadow-md shadow-red-600/40 flex items-center space-x-1 transition active:scale-95 tracking-wide"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Ván mới</span>
          </button>
        </div>
      </div>

      {/* 2. HÀNG TRÊN: BẢNG LỊCH SỬ KẾT QUẢ (TRÁI) + MÀN HÌNH LIVE SIÊU NÉT (PHẢI) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-stretch">
        {/* CỘT TRÁI (Lg: 5 cột): BẢNG MA TRẬN LỊCH SỬ */}
        <div className="lg:col-span-5 bg-slate-900/90 border border-slate-700/80 rounded-xl p-2.5 flex flex-col justify-between shadow-lg">
          <div>
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800 text-xs">
              <span className="font-bold text-slate-200 flex items-center space-x-1.5">
                <Clock className="w-3.5 h-3.5 text-indigo-400" />
                <span>Lịch Sử Kết Quả Các Ván</span>
              </span>
              <span className="text-[10px] text-slate-400 font-mono">Đã lưu {roundHistories.length} ván</span>
            </div>

            {/* Bảng ma trận kết quả */}
            <div className="overflow-x-auto max-h-[300px] overflow-y-auto rounded-lg border border-slate-800 no-scrollbar">
              <table className="w-full text-[11px] text-center border-collapse">
                <thead>
                  <tr className="bg-slate-800/90 text-slate-300 font-bold border-b border-slate-700">
                    <th className="py-1 px-1.5 border-r border-slate-700 text-slate-400">Ván</th>
                    {Array.from({ length: playerCount }, (_, i) => i + 1).map((door) => (
                      <th key={door} className="py-1 px-1 border-r border-slate-700 last:border-r-0 whitespace-nowrap">
                        Cửa {door}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {roundHistories.length === 0 ? (
                    <tr>
                      <td colSpan={playerCount + 1} className="py-8 text-slate-500 italic">
                        Chưa có lịch sử. Bấm [Ván mới] sau khi chia xong để lưu kết quả.
                      </td>
                    </tr>
                  ) : (
                    roundHistories.map((hist) => (
                      <tr key={hist.roundNum} className="border-b border-slate-800/60 hover:bg-slate-800/40">
                        <td className="py-1.5 px-1 font-mono font-bold text-slate-400 bg-slate-950/40 border-r border-slate-800">
                          #{hist.roundNum}
                        </td>
                        {Array.from({ length: playerCount }, (_, i) => i + 1).map((door) => {
                          const isWin = hist.winnerDoor === door;
                          const score = hist.scores[door];
                          return (
                            <td
                              key={door}
                              className={`py-1.5 px-1 border-r border-slate-800/50 last:border-r-0 font-medium ${
                                isWin
                                  ? 'bg-amber-500/20 text-amber-300 font-bold'
                                  : 'text-slate-300'
                              }`}
                            >
                              <div className="flex flex-col items-center">
                                <span>{score?.title || '--'}</span>
                                {isWin && <span className="text-[9px] text-amber-400">👑 Thắng</span>}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Thanh trạng thái lượt chia kế tiếp */}
          <div className="mt-2.5 p-2 rounded-lg bg-slate-950/80 border border-slate-800 flex items-center justify-between text-xs">
            <span className="text-slate-400">Lá bài tiếp theo sẽ vào:</span>
            {nextTarget ? (
              <span className="font-bold text-emerald-400 flex items-center space-x-1">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                <span>Cửa {nextTarget.door} (Lá {nextTarget.slot + 1})</span>
              </span>
            ) : (
              <span className="font-bold text-amber-400">Đã đủ bài tất cả cửa!</span>
            )}
          </div>
        </div>

        {/* CỘT PHẢI (Lg: 7 cột): MÀN HÌNH LIVE VIDEO + KHUNG NGẮM AI ĐỎ (THEO ẢNH) */}
        <div className="lg:col-span-7 bg-black rounded-xl border border-slate-700/80 overflow-hidden shadow-2xl relative flex flex-col justify-between">
          {/* Thanh công cụ trên đầu Video: Độ phân giải, FPS, Lật, Xoay & Cỡ Khung */}
          <div className="bg-slate-950/85 backdrop-blur px-3 py-1.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-1.5 z-20 text-[11px]">
            {/* Resolution & FPS Tags */}
            <div className="flex items-center space-x-1.5 font-mono">
              <span className="px-1.5 py-0.5 rounded bg-indigo-600 text-white font-bold text-[10px]">1080p</span>
              <span className="px-1.5 py-0.5 rounded bg-emerald-600/90 text-white font-bold text-[10px]">60 fps</span>
              <span className="text-slate-400 text-[10px]">V105 ISO 1280 1x</span>
            </div>

            {/* Điều khiển: Cỡ Khung, Lật, Xoay, Sáng & Ghim */}
            <div className="flex items-center space-x-1.5 text-xs">
              {/* Nút mở thanh chỉnh kích thước */}
              <button
                type="button"
                onClick={() => setShowSizeControls((prev) => !prev)}
                className={`px-2 py-0.5 rounded text-[11px] font-bold flex items-center space-x-1 transition ${
                  showSizeControls ? 'bg-indigo-600 text-white shadow' : 'bg-slate-800 text-slate-300 hover:text-white'
                }`}
                title="Mở giao diện chỉnh kích thước Dài / Rộng khung ngắm"
              >
                <Sliders className="w-3 h-3" />
                <span>Cỡ Khung</span>
              </button>

              {/* Nút Lật ngang video */}
              <button
                type="button"
                onClick={() => setIsFlipped((prev) => !prev)}
                className={`px-2 py-0.5 rounded text-[11px] font-bold flex items-center space-x-1 transition ${
                  isFlipped ? 'bg-cyan-600 text-white shadow' : 'bg-slate-800 text-slate-300 hover:text-white'
                }`}
                title="Lật gương ngang khung hình video"
              >
                <ArrowLeftRight className="w-3 h-3" />
                <span>{isFlipped ? 'Đã Lật ↔' : 'Lật ↔'}</span>
              </button>

              {/* Nút Xoay 90 độ video */}
              <button
                type="button"
                onClick={() => setRotation((r) => (r + 90) % 360)}
                className={`px-2 py-0.5 rounded text-[11px] font-bold flex items-center space-x-1 transition ${
                  rotation !== 0 ? 'bg-amber-600 text-white shadow' : 'bg-slate-800 text-slate-300 hover:text-white'
                }`}
                title="Xoay video 90 độ mỗi lần bấm (0 -> 90 -> 180 -> 270)"
              >
                <RotateCw className="w-3 h-3" />
                <span>{rotation !== 0 ? `Xoay ${rotation}°` : 'Xoay ↻'}</span>
              </button>

              {/* Nút Phóng to tràn khung / Vừa vặn */}
              <button
                type="button"
                onClick={() => setIsFillMode((prev) => !prev)}
                className={`px-2 py-0.5 rounded text-[11px] font-bold flex items-center space-x-1 transition ${
                  isFillMode ? 'bg-indigo-600 text-white shadow' : 'bg-slate-800 text-slate-300 hover:text-white'
                }`}
                title="Bấm để Phóng to lấp đầy màn hình (loại bỏ viền đen) hoặc xem vừa vặn"
              >
                <Maximize2 className="w-3 h-3" />
                <span>{isFillMode ? 'Phóng to ⛶' : 'Vừa vặn'}</span>
              </button>


              {/* Nút Ghim / Bám chuột */}
              <button
                type="button"
                onClick={() => setIsReticleLocked((prev) => !prev)}
                className={`px-2 py-0.5 rounded text-[11px] font-bold flex items-center space-x-1 transition ${
                  isReticleLocked
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:text-white'
                }`}
                title="Bấm để Ghim cố định hoặc thả cho bám theo chuột"
              >
                {isReticleLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                <span>{isReticleLocked ? 'Đã Ghim' : 'Bám Chuột'}</span>
              </button>

              {/* Nút Tăng sáng & Nét */}
              <button
                type="button"
                onClick={() => setIsBrightBoost((prev) => !prev)}
                className={`px-2 py-0.5 rounded text-[11px] font-bold flex items-center space-x-1 transition ${
                  isBrightBoost ? 'bg-amber-500 text-slate-950 font-black' : 'bg-slate-800 text-slate-400'
                }`}
                title="Tăng sáng & độ tương phản để soi bài rõ nhất"
              >
                <Sun className="w-3 h-3" />
                <span>{isBrightBoost ? 'Sáng (Bật)' : 'Sáng'}</span>
              </button>
            </div>
          </div>

          {/* GIAO DIỆN CHỈNH KÍCH THƯỚC KHUNG NGẮM (THAY VÌ CHỈ LĂN CHUỘT) */}
          {showSizeControls && (
            <div className="bg-slate-900/95 border-b border-slate-700/80 px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 z-20 text-xs shadow-md">
              <div className="flex items-center space-x-3">
                {/* Chỉnh Rộng */}
                <div className="flex items-center space-x-1.5 bg-slate-800 px-2 py-0.5 rounded-lg border border-slate-700">
                  <span className="text-slate-400 text-[11px]">Rộng:</span>
                  <button
                    onClick={() => setReticleSize((s) => ({ ...s, width: Math.max(80, s.width - 20) }))}
                    className="w-4 h-4 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center text-xs active:scale-95"
                  >-</button>
                  <span className="w-8 text-center font-bold text-amber-300 font-mono text-[11px]">{reticleSize.width}</span>
                  <button
                    onClick={() => setReticleSize((s) => ({ ...s, width: Math.min(450, s.width + 20) }))}
                    className="w-4 h-4 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center text-xs active:scale-95"
                  >+</button>
                </div>

                {/* Chỉnh Dài */}
                <div className="flex items-center space-x-1.5 bg-slate-800 px-2 py-0.5 rounded-lg border border-slate-700">
                  <span className="text-slate-400 text-[11px]">Dài:</span>
                  <button
                    onClick={() => setReticleSize((s) => ({ ...s, height: Math.max(100, s.height - 20) }))}
                    className="w-4 h-4 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center text-xs active:scale-95"
                  >-</button>
                  <span className="w-8 text-center font-bold text-amber-300 font-mono text-[11px]">{reticleSize.height}</span>
                  <button
                    onClick={() => setReticleSize((s) => ({ ...s, height: Math.min(500, s.height + 20) }))}
                    className="w-4 h-4 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center text-xs active:scale-95"
                  >+</button>
                </div>
              </div>

              {/* Nút Cỡ Mẫu (Presets) */}
              <div className="flex items-center space-x-1 text-[10px]">
                <span className="text-slate-400 mr-1">Cỡ mẫu:</span>
                <button
                  onClick={() => setReticleSize({ width: 150, height: 200 })}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
                >Nhỏ (150x200)</button>
                <button
                  onClick={() => setReticleSize({ width: 220, height: 280 })}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 hover:text-white font-bold transition"
                >Chuẩn (220x280)</button>
                <button
                  onClick={() => setReticleSize({ width: 280, height: 360 })}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
                >Lớn (280x360)</button>
                <button
                  onClick={() => setReticleSize({ width: 320, height: 220 })}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-indigo-300 hover:text-white transition"
                >Ngang (320x220)</button>
              </div>
            </div>
          )}

          {/* VÙNG CHỨA VIDEO & KHUNG NGẮM AI ĐỎ (TỰ ĐỘNG PHÓNG TO & THÍCH ỨNG TỶ LỆ) */}
          <div
            ref={videoContainerRef}
            onMouseMove={handleVideoMouseMove}
            onClick={handleVideoClick}
            className="relative w-full h-[460px] sm:h-[520px] md:h-[580px] bg-black overflow-hidden select-none cursor-crosshair group flex items-center justify-center"
            title="Rê chuột để di chuyển khung ngắm, Click để Ghim/Thả cố định"
          >
            {/* Thẻ Video Live trực tiếp (Giải mã HLS.js, phóng to cực đại không bị co nhỏ) */}
            <video
              ref={videoRef}
              className={`pointer-events-none transition-transform duration-150 ease-out ${
                isFillMode ? 'w-full h-full object-cover' : 'w-full h-full object-contain'
              }`}
              style={{
                transform: `${
                  (rotation === 90 || rotation === 270)
                    ? `scale(${isFillMode ? 1.78 : 1}) rotate(${rotation}deg)`
                    : `rotate(${rotation}deg)`
                } scaleX(${isFlipped ? -1 : 1})`,
                transformOrigin: 'center center',
                imageRendering: '-webkit-optimize-contrast' as any,
                filter: isBrightBoost ? 'brightness(1.15) contrast(1.12) saturate(1.08)' : 'none'
              }}
              playsInline
              muted={isMuted}
              autoPlay
              onTimeUpdate={() => {
                if (videoRef.current) {
                  setSeekTime(videoRef.current.currentTime);
                  setDuration(videoRef.current.duration || 0);
                }
              }}
            />

            {/* Màn hình chờ nếu chưa có tín hiệu video */}
            {!hasVideoSignal && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/90 text-slate-400 space-y-2 pointer-events-none z-10">
                <div className="w-10 h-10 rounded-full bg-slate-900 border border-slate-700 flex items-center justify-center text-indigo-400 animate-pulse">
                  <Radio className="w-5 h-5 animate-pulse text-indigo-400" />
                </div>
                <p className="text-xs font-mono text-slate-300">
                  {stream ? 'Đang kết nối luồng Live 120fps...' : 'Đang chờ điện thoại phát trực tiếp...'}
                </p>
              </div>
            )}

            {/* KHUNG NGẮM AI MÀU ĐỎ (DYNAMIC TARGET BOUNDING BOX) */}
            {isReticleActive && (
              <div
                style={{
                  position: 'absolute',
                  left: `${reticlePos.x}px`,
                  top: `${reticlePos.y}px`,
                  width: `${reticleSize.width}px`,
                  height: `${reticleSize.height}px`,
                  pointerEvents: 'auto',
                  transition: isReticleLocked ? 'none' : 'width 0.05s, height 0.05s'
                }}
                className={`border-2 rounded-lg pointer-events-auto transition-colors ${
                  isAiFlashing
                    ? 'border-emerald-400 bg-emerald-500/15 shadow-[0_0_25px_rgba(52,211,153,0.9)]'
                    : 'border-red-500 bg-red-500/5 shadow-[0_0_15px_rgba(239,68,68,0.7)]'
                }`}
              >
                {/* Header nhãn nổi BÊN NGOÀI KHUNG (KHÔNG CHE BÀI TRONG KHUNG) */}
                <div className="absolute -top-6 left-0 right-0 flex items-center justify-between text-[10px] font-bold text-white bg-black/85 px-2 py-0.5 rounded-t backdrop-blur border-t border-x border-red-500/50 pointer-events-none whitespace-nowrap shadow">
                  <span className="flex items-center space-x-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${isAiFlashing ? 'bg-emerald-400' : 'bg-red-500 animate-ping'}`} />
                    <span>{isReticleLocked ? '🔒 ĐÃ GHIM' : '🎯 BÁM CHUỘT'}</span>
                  </span>
                  <span className="font-mono text-amber-300 ml-1">
                    {reticleSize.width}x{reticleSize.height}
                  </span>
                </div>

                {/* Tâm ngắm chữ thập (+) */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-40">
                  <div className="w-5 h-0.5 bg-red-400" />
                  <div className="h-5 w-0.5 bg-red-400 absolute" />
                </div>

                {/* Footer thông báo trạng thái nổi BÊN DƯỚI NGOÀI KHUNG (KHÔNG CHE BÀI TRONG KHUNG) */}
                <div className="absolute -bottom-6 left-0 right-0 flex items-center justify-between text-[9px] font-bold text-slate-200 bg-black/90 px-2 py-0.5 rounded-b backdrop-blur border-b border-x border-red-500/50 pointer-events-none whitespace-nowrap shadow">
                  <span className="truncate">{aiStatus}</span>
                  {lastDetectedCard && (
                    <span className="font-black text-emerald-400 ml-1">{lastDetectedCard}</span>
                  )}
                </div>

                {/* Handle kéo góc dưới-phải để tùy chỉnh Dài x Rộng */}
                <div
                  onMouseDown={handleReticleResizeMouseDown}
                  className="absolute bottom-0 right-0 w-5 h-5 flex items-end justify-end p-0.5 cursor-nwse-resize z-30"
                  title="Kéo góc để chỉnh kích thước Dài/Rộng"
                >
                  <div className="w-2.5 h-2.5 border-r-2 border-b-2 border-red-400 rounded-br-sm" />
                </div>
              </div>
            )}
          </div>

          {/* THANH ĐIỀU KHIỂN VIDEO DƯỚI: TUA LẠI, TỐC ĐỘ & VỀ LIVE (KHÔNG PIP) */}
          <div className="bg-slate-950/90 px-3 py-1.5 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2.5 text-xs z-20">
            {/* Nút Nhảy về LIVE trực tiếp */}
            <button
              onClick={jumpToLive}
              className={`px-3 py-1 rounded-full font-black text-[11px] tracking-wider uppercase transition flex items-center space-x-1.5 shadow ${
                isLive
                  ? 'bg-red-600 text-white shadow-red-600/40'
                  : 'bg-slate-800 text-slate-300 hover:bg-red-600 hover:text-white animate-pulse'
              }`}
              title="Nhấn để quay lại xem phát trực tiếp tức thì"
            >
              <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-white' : 'bg-red-400 animate-ping'}`} />
              <span>LIVE</span>
            </button>

            {/* Thanh Timeline Tua lại (Scrubbing Seekbar) */}
            <div className="flex-1 min-w-[150px] flex items-center space-x-2">
              <span className="text-[10px] text-slate-400 font-mono">Tua:</span>
              <input
                type="range"
                min={0}
                max={duration || 100}
                step={0.1}
                value={seekTime}
                onChange={handleSeekChange}
                className="flex-1 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-red-500"
              />
              <span className="text-[10px] text-slate-400 font-mono whitespace-nowrap">
                {Math.floor(seekTime)}s / {Math.floor(duration)}s
              </span>
            </div>

            {/* Tốc độ phát lại (Playback Speed) */}
            <div className="flex items-center space-x-1 bg-slate-900 px-2 py-0.5 rounded-lg border border-slate-800 font-mono text-[10px]">
              <span className="text-slate-400 mr-0.5">Tốc độ:</span>
              {[1.0, 0.5, 0.25, 0.125].map((rate) => (
                <button
                  key={rate}
                  type="button"
                  onClick={() => {
                    setPlaybackRate(rate);
                    if (videoRef.current) {
                      videoRef.current.playbackRate = rate;
                    }
                  }}
                  className={`px-1.5 py-0.5 rounded font-bold transition ${
                    playbackRate === rate
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-slate-400 hover:text-white'
                  }`}
                  title={`Tốc độ ${rate}x`}
                >
                  {rate === 1.0 ? '1x' : `${rate}x`}
                </button>
              ))}
            </div>

            {/* Tắt/bật âm thanh */}
            <button
              onClick={() => setIsMuted((m) => !m)}
              className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
              title={isMuted ? 'Bật âm thanh' : 'Tắt tiếng'}
            >
              {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>

      {/* 3. HÀNG DƯỚI: 7 CỬA CHƠI VỚI CÁC Ô CHỨA BÀI VIỀN VÀNG (THEO ẢNH) */}
      <div className="bg-slate-900/90 border border-slate-700/80 rounded-xl p-3 shadow-xl backdrop-blur">
        <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-800 text-xs">
          <span className="font-bold text-slate-200 flex items-center space-x-1.5">
            <Layers className="w-4 h-4 text-amber-400" />
            <span>Bàn Cược {playerCount} Cửa Chơi ({cardsPerPlayer} lá/cửa)</span>
          </span>
          {winnerDoor > 0 && (
            <span className="px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-bold border border-amber-500/40 flex items-center space-x-1 animate-pulse">
              <Award className="w-3.5 h-3.5 text-amber-400" />
              <span>Cửa {winnerDoor} Thắng Lớn!</span>
            </span>
          )}
        </div>

        {/* Lưới 7 Cửa (Grid 7 Columns) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2.5 sm:gap-3">
          {Array.from({ length: playerCount }, (_, i) => i + 1).map((doorNum) => {
            const cards = doorCards[doorNum] || [];
            const evalResult = evaluations[doorNum];
            const isWinner = winnerDoor === doorNum;
            const isTargetDoor = nextTarget?.door === doorNum;

            return (
              <div
                key={doorNum}
                className={`rounded-xl p-2 flex flex-col justify-between transition-all border ${
                  isWinner
                    ? 'bg-amber-950/30 border-amber-400/80 shadow-lg shadow-amber-500/20 ring-1 ring-amber-400'
                    : isTargetDoor
                    ? 'bg-indigo-950/40 border-indigo-500/60 ring-1 ring-indigo-400/50'
                    : 'bg-slate-950/60 border-slate-800'
                }`}
              >
                {/* Tên Cửa & Huy hiệu Điểm */}
                <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-white/5">
                  <span className="font-bold text-xs sm:text-sm text-slate-200 flex items-center space-x-1">
                    <span>Cửa {doorNum}</span>
                    {isWinner && <span className="text-amber-400 text-xs">👑</span>}
                  </span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                      evalResult?.highlightClass || 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {evalResult?.title || 'Chờ bài'}
                  </span>
                </div>

                {/* CÁC Ô CHỨA LÁ BÀI (VIỀN VÀNG DẠ QUANG ĐÚNG THEO ẢNH) */}
                <div className="space-y-1.5">
                  {Array.from({ length: cardsPerPlayer }, (_, slotIdx) => {
                    const cardRaw = cards[slotIdx];
                    const cardInfo = cardRaw ? formatCardItem(cardRaw) : null;
                    const isActiveSlot = nextTarget?.door === doorNum && nextTarget?.slot === slotIdx;

                    return (
                      <div
                        key={slotIdx}
                        onClick={() => {
                          setPickerTarget({
                            mode: cardRaw ? 'edit' : 'add',
                            groupNum: doorNum,
                            slotIndex: slotIdx,
                            currentValue: cardRaw || ''
                          });
                          setPickerOpen(true);
                        }}
                        className={`h-11 sm:h-12 rounded-lg flex items-center justify-center cursor-pointer transition-all border-2 ${
                          isActiveSlot
                            ? 'border-emerald-400 bg-emerald-500/10 ring-2 ring-emerald-400 animate-pulse'
                            : cardInfo
                            ? 'border-yellow-400 bg-yellow-950/20 shadow-md shadow-yellow-500/10 hover:border-yellow-300'
                            : 'border-yellow-500/60 bg-slate-900/60 hover:border-yellow-400/80 border-dashed'
                        }`}
                        title={cardRaw ? `Lá ${slotIdx + 1}: ${cardRaw} (Nhấn để sửa)` : `Lá ${slotIdx + 1}: Chờ bài`}
                      >
                        {cardInfo ? (
                          <div className="flex items-center space-x-1 font-black">
                            <span className={`text-base sm:text-lg font-mono ${cardInfo.isRed ? 'text-red-500' : 'text-slate-100'}`}>
                              {cardInfo.rank}
                            </span>
                            <span className={`text-sm sm:text-base ${cardInfo.isRed ? 'text-red-500' : 'text-slate-100'}`}>
                              {cardInfo.symbol}
                            </span>
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-500 font-mono">
                            {isActiveSlot ? 'Đang chờ...' : `Ô ${slotIdx + 1}`}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Subtext điểm */}
                <div className="mt-2 pt-1 border-t border-white/5 text-center text-[10px] text-slate-400 font-medium">
                  {evalResult?.subText || '0/3 lá'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* POPUP CHỌN BÀI THỦ CÔNG (KHI CLICK VÀO Ô ĐỂ SỬA) */}
      <CardPickerPopup
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        target={pickerTarget}
        numGroups={playerCount}
        onSelectCard={(val, targetGroup) => {
          setDoorCards((prev) => {
            const current = [...(prev[targetGroup] || [])];
            if (pickerTarget.mode === 'edit' && pickerTarget.slotIndex !== undefined) {
              current[pickerTarget.slotIndex] = val;
            } else {
              current.push(val);
            }
            return { ...prev, [targetGroup]: current };
          });
          setPickerOpen(false);
        }}
      />
    </div>
  );
};
