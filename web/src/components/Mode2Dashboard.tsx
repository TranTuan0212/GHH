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
  const [isBrightBoost, setIsBrightBoost] = useState<boolean>(false);
  // Chế độ phóng to lấp đầy màn hình (Fill/Cover vs Contain)
  const [isFillMode, setIsFillMode] = useState<boolean>(() => {
    return localStorage.getItem('mode2_video_fill') === 'true';
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
  const [capturedHistory, setCapturedHistory] = useState<Array<{
    image: string;
    cardName: string;
    confidence: number;
    timestamp: string;
  }>>([]);
  const [capturedFrame, setCapturedFrame] = useState<{
    image: string;
    cardName: string;
    confidence: number;
    timestamp: string;
  } | null>(null);
  const [isAiFlashing, setIsAiFlashing] = useState<boolean>(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(0.35);

  // Refs video (Cơ chế Kép: Live WebRTC 0 delay + HLS Replay 120fps) & canvas
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const replayVideoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
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
  const [hasWebRtcSignal, setHasWebRtcSignal] = useState<boolean>(false);

  // Quản lý phiên Stream (Đồng bộ từ props và tự động thăm dò luồng mới khi iPhone phát lại)
  const [activeStreamSession, setActiveStreamSession] = useState<StreamSession | null>(stream);

  useEffect(() => {
    setActiveStreamSession(stream);
  }, [stream]);

  // Đồng bộ trạng thái Stream tức thì qua Socket.io
  useEffect(() => {
    if (!socket) return;
    const handleStatusChanged = (data: { roomId?: string; status: 'LIVE' | 'ENDED'; session?: StreamSession }) => {
      if (data.status === 'LIVE' && data.session) {
        console.log('[Mode2] ⚡ Socket thông báo có luồng Live mới:', data.session.streamKey);
        setActiveStreamSession(data.session);
        setHasVideoSignal(false);
        setHasWebRtcSignal(false);
      } else if (data.status === 'ENDED') {
        console.log('[Mode2] ⏹ Socket thông báo phiên Live kết thúc');
        setActiveStreamSession(null);
        setHasVideoSignal(false);
        setHasWebRtcSignal(false);
      }
    };
    socket.on('stream_status_changed', handleStatusChanged);
    return () => {
      socket.off('stream_status_changed', handleStatusChanged);
    };
  }, [socket]);

  // Tự động kiểm tra luồng mới mỗi 2s liên tục (chuyển đổi luồng tức thì không cần F5)
  useEffect(() => {
    let cancelled = false;
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/stream/active?roomId=${encodeURIComponent(roomId || '')}`);
        if (res.ok) {
          const data = await res.json();
          if (cancelled) return;
          if (data?.stream?.status === 'LIVE') {
            setActiveStreamSession((prev) => {
              if (prev?.streamKey !== data.stream.streamKey) {
                console.log('[Mode2] Tự động bắt luồng Live mới từ server:', data.stream.streamKey);
                setHasVideoSignal(false);
                setHasWebRtcSignal(false);
                return data.stream;
              }
              return prev;
            });
          } else if (data?.stream?.status === 'ENDED' || !data?.stream) {
            // Khi phiên stream cũ kết thúc, xóa active session để ngắt WebRTC/HLS cũ, ngừng gọi 404
            setActiveStreamSession((prev) => {
              if (prev !== null) {
                console.log('[Mode2] Phiên Live cũ đã dừng, reset player chờ luồng mới...');
                setHasVideoSignal(false);
                setHasWebRtcSignal(false);
                return null;
              }
              return prev;
            });
          }
        }
      } catch {}
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
    };
  }, [roomId]);

  // KẾT NỐI CƠ CHẾ KÉP (DUAL-ENGINE): WEBRTC LIVE 0 DELAY (<0.2S) + HLS REPLAY 120FPS
  const whepUrl = useMemo(() => {
    const sKey = activeStreamSession?.streamKey;
    if (!sKey) return '';
    try {
      const hostname = window.location.hostname || '127.0.0.1';
      return `http://${hostname}:8889/${sKey}/whep`;
    } catch {
      return '';
    }
  }, [activeStreamSession?.streamKey]);

  // 1. Kết nối WebRTC WHEP Live trực tiếp (Zero Delay <0.2s, 60fps mượt tuyệt đối) với Auto-Retry Loop
  useEffect(() => {
    if (!whepUrl) return;
    let cancelled = false;
    let peer: RTCPeerConnection | null = null;
    let sessionUrl: string | null = null;

    setHasWebRtcSignal(false);

    const connectWebRtc = async () => {
      for (let attempt = 1; !cancelled; attempt++) {
        try {
          if (peerRef.current) {
            peerRef.current.close();
            peerRef.current = null;
          }

          peer = new RTCPeerConnection();
          peerRef.current = peer;
          let receivedTrack = false;
          peer.addTransceiver('video', { direction: 'recvonly' });
          peer.addTransceiver('audio', { direction: 'recvonly' });

          peer.ontrack = (event) => {
            const { streams, receiver } = event;
            try {
              const anyReceiver = receiver as any;
              if (anyReceiver && 'playoutDelayHint' in anyReceiver) {
                anyReceiver.playoutDelayHint = 0;
              }
              if (anyReceiver && 'jitterBufferTarget' in anyReceiver) {
                anyReceiver.jitterBufferTarget = 0;
              }
            } catch {}
            if (cancelled || !streams[0] || !liveVideoRef.current) return;
            receivedTrack = true;
            liveVideoRef.current.srcObject = streams[0];
            liveVideoRef.current.play().catch(() => {});
            setHasVideoSignal(true);
            setHasWebRtcSignal(true);
            console.log('[Mode2] WebRTC Live đã nhận video track thành công (Zero Delay)!');

            const vTrack = streams[0].getVideoTracks()[0];
            if (vTrack) {
              vTrack.onended = () => {
                console.log('[Mode2] WebRTC video track ended');
                setHasWebRtcSignal(false);
              };
            }
          };

          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);

          await new Promise<void>((resolve) => {
            if (peer!.iceGatheringState === 'complete') return resolve();
            const t = setTimeout(resolve, 250);
            peer!.addEventListener('icegatheringstatechange', () => {
              if (peer!.iceGatheringState === 'complete') {
                clearTimeout(t);
                resolve();
              }
            }, { once: true });
          });

          const res = await fetch(whepUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
            body: peer.localDescription?.sdp
          });

          if (!res.ok) {
            throw new Error(`WHEP HTTP ${res.status}`);
          }

          const loc = res.headers.get('location');
          sessionUrl = loc ? new URL(loc, whepUrl).toString() : null;

          const answer = await res.text();
          if (cancelled) break;
          await peer.setRemoteDescription({ type: 'answer', sdp: answer });

          // Chờ video track đến (tối đa 5s)
          await new Promise<void>((resolve, reject) => {
            if (receivedTrack) return resolve();
            const timer = setTimeout(() => {
              if (!receivedTrack) reject(new Error('Chờ video track timeout'));
              else resolve();
            }, 5000);
            peer!.addEventListener('track', () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });

          peer.onconnectionstatechange = () => {
            if (peer?.connectionState === 'failed' || peer?.connectionState === 'disconnected') {
              console.log('[Mode2] WebRTC disconnected, fallback to HLS...');
              setHasWebRtcSignal(false);
            }
          };

          // Kết nối thành công! Thoát retry loop
          break;
        } catch (err) {
          if (sessionUrl) {
            fetch(sessionUrl, { method: 'DELETE' }).catch(() => {});
            sessionUrl = null;
          }
          if (peerRef.current) {
            peerRef.current.close();
            peerRef.current = null;
          }
          if (cancelled) break;
          // FFmpeg/MediaMTX đang khởi tạo -> Chờ 400ms và thử lại
          await new Promise((r) => setTimeout(r, 400));
        }
      }
    };

    connectWebRtc();

    return () => {
      cancelled = true;
      if (sessionUrl) {
        fetch(sessionUrl, { method: 'DELETE' }).catch(() => {});
        sessionUrl = null;
      }
      if (peerRef.current) {
        peerRef.current.close();
        peerRef.current = null;
      }
    };
  }, [whepUrl]);

  // 2. Kết nối HLS Replay DVR Master (để tua chậm, tua lại chi tiết từng frame 120fps)
  useEffect(() => {
    const video = replayVideoRef.current;
    if (!video || !activeStreamSession?.streamKey) return;

    const streamKey = activeStreamSession.streamKey;
    const replayUrl = `/replay/${streamKey}/index.m3u8`;
    const liveHlsUrl = activeStreamSession.hlsPlaylistUrl || `/live/${streamKey}/index.m3u8`;
    let isCancelled = false;

    (async () => {
      let activeHlsUrl = replayUrl;
      // Đợi playlist sẵn sàng (thử cả replay và live)
      for (let i = 0; i < 30 && !isCancelled; i++) {
        try {
          const resReplay = await fetch(replayUrl, { method: 'HEAD', cache: 'no-store' });
          if (resReplay.ok) {
            activeHlsUrl = replayUrl;
            break;
          }
          const resLive = await fetch(liveHlsUrl, { method: 'HEAD', cache: 'no-store' });
          if (resLive.ok) {
            activeHlsUrl = liveHlsUrl;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 400));
      }
      if (isCancelled) return;

      if (Hls.isSupported()) {
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 30, // Giữ 30s để tua lại mượt mà 120fps
          maxBufferLength: 8,
          maxMaxBufferLength: 16,
          maxBufferSize: 128 * 1024 * 1024,
          maxBufferHole: 0.2,
          nudgeOffset: 0.1,
          nudgeMaxRetry: 5,
          highBufferWatchdogPeriod: 0,
          liveSyncDuration: 1.5,
          liveMaxLatencyDuration: Infinity,
          maxLiveSyncPlaybackRate: 1.0
        });

        hlsRef.current = hls;
        hls.loadSource(activeHlsUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!hasVideoSignal) setHasVideoSignal(true);
          video.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              hls.startLoad();
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
            }
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = activeHlsUrl;
        if (!hasVideoSignal) setHasVideoSignal(true);
        video.play().catch(() => {});
      }
    })();

    return () => {
      isCancelled = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [activeStreamSession?.streamKey, activeStreamSession?.hlsPlaylistUrl]);

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

  // VÒNG LẶP AI QUÉT REAL-TIME SIÊU TỐC (~35 FPS PIPELINING) - BẮT TRỌN MỌI CÚ LƯỚT BÀI
  useEffect(() => {
    if (!isReticleActive) return;

    let isCancelled = false;
    let inFlightCount = 0;
    let lastDispatchTime = 0;
    let rafId: number | null = null;

    const processFrameRealtime = () => {
      if (isCancelled || !isReticleActive) return;

      const now = Date.now();
      // Nhịp quét siêu tốc 33ms (~30 lần/giây): mượt mà tuyệt đối, 0% nghẽn CPU
      if (now - lastDispatchTime < 33 || inFlightCount >= 1) {
        rafId = requestAnimationFrame(processFrameRealtime);
        return;
      }

      const liveVideo = liveVideoRef.current;
      const replayVideo = replayVideoRef.current;
      const container = videoContainerRef.current;

      const activeVideo = (isLive && hasWebRtcSignal && liveVideo && liveVideo.videoWidth > 0 && !liveVideo.paused)
        ? liveVideo
        : ((replayVideo && replayVideo.videoWidth > 0 && !replayVideo.paused)
          ? replayVideo
          : (liveVideo || replayVideo));

      if (!activeVideo || !container || activeVideo.videoWidth === 0 || activeVideo.paused || activeVideo.ended) {
        rafId = requestAnimationFrame(processFrameRealtime);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const W = containerRect.width;
      const H = containerRect.height;
      if (W === 0 || H === 0) {
        rafId = requestAnimationFrame(processFrameRealtime);
        return;
      }

      // Hàm chụp cắt ảnh CHÍNH XÁC 100% theo khung đỏ người dùng đã đặt (không padding thừa)
      const captureCrop = (videoEl: HTMLVideoElement): string | null => {
        if (!videoEl || videoEl.videoWidth === 0 || videoEl.paused || videoEl.ended) return null;
        if (!canvasRef.current) {
          canvasRef.current = document.createElement('canvas');
        }
        const canvas = canvasRef.current;
        // Cắt đúng 100% NATIVE 1080p Resolution từ video gốc (KHÔNG NÉN CO NHỎ)
        const vw = videoEl.videoWidth;
        const vh = videoEl.videoHeight;
        if (vw === 0 || vh === 0) return null;

        let renderW = W;
        let renderH = H;
        const containerRatio = W / H;
        const videoRatio = vw / vh;
        if (videoRatio > containerRatio) {
          renderW = W;
          renderH = W / videoRatio;
        } else {
          renderH = H;
          renderW = H * videoRatio;
        }

        // Tỷ lệ pixel thực tế từ video 1080p gốc (Native 1080p)
        const nativeScale = vw / renderW;
        const targetW = Math.max(160, Math.round(reticleSize.width * nativeScale));
        const targetH = Math.max(160, Math.round(reticleSize.height * nativeScale));

        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;

        ctx.clearRect(0, 0, targetW, targetH);
        ctx.save();

        // Scale 1:1 theo đúng điểm ảnh thực tế của video 1080p
        const s = nativeScale;
        ctx.scale(s, s);
        ctx.translate(-reticlePos.x, -reticlePos.y);
        ctx.translate(W / 2, H / 2);

        if (rotation === 90 || rotation === 270) {
          ctx.rotate((rotation * Math.PI) / 180);
        } else if (rotation === 180) {
          ctx.rotate(Math.PI);
        }
        if (isFlipped) {
          ctx.scale(-1, 1);
        }

        ctx.drawImage(videoEl, -renderW / 2, -renderH / 2, renderW, renderH);
        ctx.restore();

        return canvas.toDataURL('image/jpeg', 0.80);
      };

      const dataUrl = captureCrop(activeVideo);
      if (!dataUrl) {
        rafId = requestAnimationFrame(processFrameRealtime);
        return;
      }

      // Xử lý khi AI nhận diện được quân bài (Ngưỡng nhạy chuẩn 0.25 - Ăn ngay tức thì)
      const handleCardMatch = (best: any, sourceImg: string) => {
        const tNow = Date.now();
        const conf = best.confidence || 0;

        if (conf < 0.25) return;

        const isSameCard = best.code === lastDetectedCodeRef.current;
        const timeDiff = tNow - lastDetectionTimeRef.current;

        // Bắt dính tức thì: Cooldown 350ms cho cùng 1 lá, hoặc ăn ngay lập tức nếu khác lá
        if ((!isSameCard || timeDiff > 350) && conf >= 0.25) {
          lastDetectionTimeRef.current = tNow;
          lastDetectedCodeRef.current = best.code;
          addCardToActiveDoor(best.code);
          setAiStatus('⚡ Bắt dính: ' + best.fullName + ' (' + Math.round(conf * 100) + '%)');
          setLastDetectedCard(best.display);
          setIsAiFlashing(true);
          setTimeout(() => setIsAiFlashing(false), 250);

          // Hiển thị frame ảnh bắt được lên góc phải HUD
          const newCap = {
            image: sourceImg,
            cardName: best.display + ' ' + best.fullName,
            confidence: Math.round(conf * 100),
            timestamp: new Date().toLocaleTimeString('vi-VN')
          };
          setCapturedFrame(newCap);
          setCapturedHistory((prev) => [newCap, ...prev.slice(0, 4)]);
        } else {
          setAiStatus('Đang thấy: ' + best.fullName + ' (' + Math.round(conf * 100) + '%)');
        }
      };

      lastDispatchTime = now;
      inFlightCount++;

      fetch('/api/ai/yolo-detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: dataUrl,
          confidence: 0.25,
          imgsz: 192,
          minSharpness: 0
        })
      })
        .then((r) => r.json())
        .then((json) => {
          if (json.cards && json.cards.length > 0) {
            handleCardMatch(json.bestCard || json.cards[0], dataUrl);
          } else {
            // ĐỐI CHIẾU 120FPS REPLAY: Khi Live không bắt được (bài lướt nhanh bị mờ),
            // lấy ngay frame của luồng Master 120fps Replay (tốc độ chụp 1/240s không nhòe) để AI đọc
            if (replayVideo && replayVideo.videoWidth > 0 && !replayVideo.paused && !replayVideo.ended) {
              const replayUrl = captureCrop(replayVideo);
              if (replayUrl && replayUrl !== dataUrl) {
                fetch('/api/ai/yolo-detect', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    imageBase64: replayUrl,
                    confidence: 0.25,
                    imgsz: 192
                  })
                })
                  .then((r2) => r2.json())
                  .then((jsonReplay) => {
                    if (jsonReplay.cards && jsonReplay.cards.length > 0) {
                      handleCardMatch(jsonReplay.bestCard || jsonReplay.cards[0], replayUrl);
                    }
                  })
                  .catch(() => {});
              }
            }
            setAiStatus('⚡ Đang quét khung đỏ (Full AI Local)...');
          }
        })
        .catch(() => {})
        .finally(() => {
          inFlightCount = Math.max(0, inFlightCount - 1);
        });

      rafId = requestAnimationFrame(processFrameRealtime);
    };

    rafId = requestAnimationFrame(processFrameRealtime);

    return () => {
      isCancelled = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [isReticleActive, reticlePos, reticleSize, confidenceThreshold, isFlipped, rotation, isFillMode, addCardToActiveDoor, isLive, hasWebRtcSignal]);

  // Xử lý tua lại video
  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setSeekTime(val);
    if (replayVideoRef.current) {
      replayVideoRef.current.currentTime = val;
    }
    setIsLive(false);
  };

  const jumpToLive = () => {
    if (liveVideoRef.current) {
      liveVideoRef.current.play().catch(() => {});
    }
    if (replayVideoRef.current && replayVideoRef.current.buffered.length > 0) {
      const bEnd = replayVideoRef.current.buffered.end(replayVideoRef.current.buffered.length - 1);
      replayVideoRef.current.currentTime = Math.max(0, bEnd - 0.5);
      replayVideoRef.current.playbackRate = 1.0;
      replayVideoRef.current.play().catch(() => {});
    }
    setPlaybackRate(1.0);
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
            {/* Thẻ 1: Live WebRTC WHEP (Siêu mượt, Độ trễ <0.2s, 0 khựng giật) */}
            <video
              ref={liveVideoRef}
              className={`pointer-events-none transition-transform duration-150 ease-out absolute inset-0 ${
                isLive && hasWebRtcSignal ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none z-0'
              } ${isFillMode ? 'w-full h-full object-cover' : 'w-full h-full object-contain'}`}
              style={{
                transform: `${
                  (rotation === 90 || rotation === 270)
                    ? `rotate(${rotation}deg)`
                    : `rotate(${rotation}deg)`
                } scaleX(${isFlipped ? -1 : 1})`,
                transformOrigin: 'center center',
                imageRendering: 'auto',
                filter: isBrightBoost ? 'brightness(1.08) contrast(1.06)' : 'none'
              }}
              playsInline
              muted={isMuted}
              autoPlay
            />

            {/* Thẻ 2: HLS Replay DVR Master (Tua lại mượt mà từng khung hình 120fps / Fallback Live) */}
            <video
              ref={replayVideoRef}
              className={`pointer-events-none transition-transform duration-150 ease-out absolute inset-0 ${
                !isLive || !hasWebRtcSignal ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none z-0'
              } ${isFillMode ? 'w-full h-full object-cover' : 'w-full h-full object-contain'}`}
              style={{
                transform: `${
                  (rotation === 90 || rotation === 270)
                    ? `rotate(${rotation}deg)`
                    : `rotate(${rotation}deg)`
                } scaleX(${isFlipped ? -1 : 1})`,
                transformOrigin: 'center center',
                imageRendering: 'auto',
                filter: isBrightBoost ? 'brightness(1.08) contrast(1.06)' : 'none'
              }}
              playsInline
              muted={isMuted}
              autoPlay
              onTimeUpdate={() => {
                if (replayVideoRef.current && !isLive) {
                  setSeekTime(replayVideoRef.current.currentTime);
                  setDuration(replayVideoRef.current.duration || 0);
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
                  {activeStreamSession ? 'Đang kết nối luồng Live 120fps...' : 'Đang chờ điện thoại phát trực tiếp...'}
                </p>
              </div>
            )}

            {/* KHUNG NGẮM AI MÀU ĐỎ (DYNAMIC TARGET BOUNDING BOX - LUÔN NẰM TRÊN MẶT VIDEO VỚI Z-30) */}
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
                className={`z-30 border-2 rounded-lg pointer-events-auto transition-colors ${
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

            {/* KHUNG HIỂN THỊ ẢNH TRÍCH XUẤT THỰC TẾ CỦA LÁ BÀI RÕ NÉT NHẤT */}
            {capturedFrame && (
              <div className="absolute top-2.5 right-2.5 z-30 bg-slate-950/95 border-2 border-emerald-500 rounded-xl p-1.5 shadow-[0_0_25px_rgba(16,185,129,0.5)] backdrop-blur-md flex flex-col items-center pointer-events-auto transition-all animate-in fade-in zoom-in-95 duration-200">
                <div className="flex items-center justify-between w-full px-1 mb-1 text-[10px] font-bold text-emerald-400">
                  <span className="flex items-center gap-1">📸 Frame bắt được</span>
                  <span className="text-amber-300 font-mono font-black">{capturedFrame.confidence}%</span>
                </div>
                <div className="w-24 h-32 sm:w-28 sm:h-36 rounded-lg overflow-hidden bg-black border border-emerald-500/40 flex items-center justify-center relative shadow-inner">
                  <img
                    src={capturedFrame.image}
                    alt={capturedFrame.cardName}
                    className="w-full h-full object-contain"
                  />
                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black via-black/85 to-transparent p-1 text-center">
                    <span className="text-[11px] font-black text-white">{capturedFrame.cardName}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between w-full px-1 mt-1 text-[9px] text-slate-400 font-mono">
                  <span>{capturedFrame.timestamp}</span>
                  <span className="text-emerald-400 font-bold">HD 400px</span>
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
                    if (replayVideoRef.current) {
                      replayVideoRef.current.playbackRate = rate;
                    }
                    if (liveVideoRef.current) {
                      liveVideoRef.current.playbackRate = rate;
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

      {/* KHAY SOI FRAME BÀI NÉT NHẤT (1080p @ 120fps Frame Inspector) */}
      <div className="bg-slate-900/90 border border-slate-700/80 rounded-xl p-3 shadow-xl backdrop-blur">
        <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800 text-xs">
          <span className="font-bold text-slate-200 flex items-center space-x-1.5">
            <Crosshair className="w-4 h-4 text-emerald-400" />
            <span>Khay Soi Frame Quân Bài Nét Nhất (1080p @ 120fps Native Frame)</span>
          </span>
          <span className="text-[10px] text-slate-400 font-mono">
            {capturedHistory.length > 0 ? `Đã lưu ${capturedHistory.length} frame gần nhất` : 'Đang chờ phát hiện bài...'}
          </span>
        </div>

        {capturedFrame ? (
          <div className="flex flex-wrap items-center gap-3">
            {/* Ảnh frame hiện tại to rõ nét nhất */}
            <div className="flex items-center space-x-3 bg-slate-950 p-2 rounded-xl border border-emerald-500/60 shadow-[0_0_20px_rgba(16,185,129,0.3)]">
              <div className="w-20 h-28 sm:w-24 sm:h-32 bg-black rounded-lg overflow-hidden border border-emerald-500/40 relative flex items-center justify-center">
                <img src={capturedFrame.image} alt={capturedFrame.cardName} className="w-full h-full object-contain" />
              </div>
              <div className="flex flex-col justify-center space-y-1">
                <span className="text-[10px] uppercase font-bold text-emerald-400 tracking-wider">⚡ Vừa Bắt Dính</span>
                <span className="text-xl sm:text-2xl font-black text-white tracking-wide">{capturedFrame.cardName}</span>
                <div className="flex items-center space-x-2 text-[11px] font-mono">
                  <span className="bg-emerald-950 text-emerald-300 px-2 py-0.5 rounded font-bold border border-emerald-800">
                    {capturedFrame.confidence}% Độ tin cậy
                  </span>
                  <span className="text-slate-400">{capturedFrame.timestamp}</span>
                </div>
                <span className="text-[10px] text-slate-500 font-mono">Chuẩn 1080p Native Pixel</span>
              </div>
            </div>

            {/* Dải lịch sử 4 lá gần nhất */}
            {capturedHistory.length > 1 && (
              <div className="flex-1 min-w-[200px] flex items-center space-x-2 overflow-x-auto py-1">
                <span className="text-[11px] text-slate-400 font-bold whitespace-nowrap mr-1">Lịch sử:</span>
                {capturedHistory.slice(1).map((item, idx) => (
                  <div key={idx} className="flex flex-col items-center bg-slate-950/80 p-1.5 rounded-lg border border-slate-800 flex-shrink-0">
                    <div className="w-12 h-16 rounded overflow-hidden bg-black border border-slate-700">
                      <img src={item.image} alt={item.cardName} className="w-full h-full object-contain" />
                    </div>
                    <span className="text-[10px] font-bold text-white mt-0.5">{item.cardName}</span>
                    <span className="text-[9px] text-slate-400 font-mono">{item.confidence}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="py-4 text-center text-slate-500 text-xs italic">
            Chưa có quân bài nào trong khung đỏ. Hãy đưa lá bài vào khung đỏ trên màn hình Live để AI bắt dính frame 1080p sắc nét!
          </div>
        )}
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
