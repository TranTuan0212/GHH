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
  Wifi,
  Filter
} from 'lucide-react';
import { parseCardRank, getRankLabel } from '../utils/cardRules';
import { GameMode, computeAllGroupAnswers, evaluate3Cards as eval3Cards, evaluate2Cards, parseCard } from './DataGroupingUI';
import {
  Server1GameMode,
  SuitRuleType,
  evaluateAllDoorsServer1,
  getMaxCardsPerDoor
} from '../utils/server1GameEngine';
import { CardPickerPopup, CardPickerTarget } from './CardPickerPopup';

interface Mode2DashboardProps {
  stream: StreamSession | null;
  socket: Socket | null;
  roomId: string;
  roomName: string;
  user: User;
  onFinishRound?: () => void;
}

export interface Mode2CardItem {
  code: string;
  image?: string;
  sharpness?: number;
  confidence?: number;
  timestamp?: string;
}

interface RoundHistory {
  roundNum: number;
  hands: { [doorIndex: number]: Mode2CardItem[] };
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

function getConversionFormula(cards: Mode2CardItem[], gameMode: string): string {
  if (!cards || cards.length === 0) return '';
  if (gameMode !== '3cards' && gameMode !== 'lieng3' && gameMode !== '2cards') return '';
  const parsed = cards.map(c => parseCard(c.code));
  
  if ((gameMode === '3cards' || gameMode === 'lieng3') && cards.length === 3) {
    const ranks = parsed.map(p => p.rank);
    if (ranks[0] !== '0' && ranks[0] === ranks[1] && ranks[1] === ranks[2]) {
      return `${ranks[0]}+${ranks[1]}+${ranks[2]} ➔ Sáp ${ranks[0]}`;
    }
    const is3Tay = ranks.every(r => ['J', 'Q', 'K'].includes(r));
    if (is3Tay) {
      return `${ranks.join('+')} ➔ Ba Tây`;
    }
  }
  
  const values = parsed.map(p => p.value);
  const sum = values.reduce((a, b) => a + b, 0);
  const pts = sum % 10;
  
  if (cards.length === 1) {
    return `${values[0]} ➔ ${pts} Điểm`;
  }
  return `${values.join('+')}=${sum} ➔ ${pts} Điểm`;
}

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

// Lazy singleton AudioContext để không bao giờ làm đứng main thread khi bắt bài
let globalAudioCtx: AudioContext | null = null;
let audioUnlocked = false;
let activeTtsAudio: HTMLAudioElement | null = null;

if (typeof window !== 'undefined') {
  const unlockAudio = () => {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
      if (!globalAudioCtx) {
        globalAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (globalAudioCtx.state === 'suspended') {
        globalAudioCtx.resume().catch(() => {});
      }
    } catch {}
  };
  window.addEventListener('pointerdown', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio, { passive: true });
  window.addEventListener('touchstart', unlockAudio, { passive: true });
}
function playBeepSound() {
  try {
    if (!audioUnlocked && !globalAudioCtx) return;
    if (!globalAudioCtx) {
      globalAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (globalAudioCtx.state === 'suspended') {
      if (!audioUnlocked) return;
      globalAudioCtx.resume().catch(() => {});
    }
    const osc = globalAudioCtx.createOscillator();
    const gain = globalAudioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, globalAudioCtx.currentTime);
    gain.gain.setValueAtTime(0.12, globalAudioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, globalAudioCtx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(globalAudioCtx.destination);
    osc.start();
    osc.stop(globalAudioCtx.currentTime + 0.12);
  } catch {}
}

export const Mode2Dashboard: React.FC<Mode2DashboardProps> = ({
  stream,
  socket,
  roomId,
  roomName,
  user,
  onFinishRound
}) => {
  // Cấu hình Bàn chơi đầy đủ 10 bộ môn chuẩn App Server 1
  const [gameMode, setGameMode] = useState<Server1GameMode>(() => {
    const saved = localStorage.getItem('mode2_game_mode');
    if (saved === 'poker') return 'texas5';
    return (saved as Server1GameMode) || '3cards';
  });

  const [suitRule, setSuitRule] = useState<SuitRuleType>(() => {
    return (localStorage.getItem('mode2_suit_rule') as SuitRuleType) || 'ro_bonus';
  });

  const [communityCards, setCommunityCards] = useState<Mode2CardItem[]>([]);
  const communityCardsRef = useRef<Mode2CardItem[]>(communityCards);
  useEffect(() => {
    communityCardsRef.current = communityCards;
  }, [communityCards]);

  const [playerCount, setPlayerCount] = useState<number>(() => {
    const saved = localStorage.getItem('mode2_player_count');
    return saved ? parseInt(saved, 10) : 7;
  });

  const [cardsPerPlayer, setCardsPerPlayer] = useState<number>(() => {
    const saved = localStorage.getItem('mode2_cards_per_player');
    return saved ? parseInt(saved, 10) : 3;
  });

  // Tự động đồng bộ số lá/cửa theo thể loại bài của Server 1
  useEffect(() => {
    const maxForMode = getMaxCardsPerDoor(gameMode, 2);
    setCardsPerPlayer(maxForMode);
    localStorage.setItem('mode2_cards_per_player', maxForMode.toString());
  }, [gameMode]);

  const [dealStrategy, setDealStrategy] = useState<'roundRobin' | 'sequential'>('roundRobin');
  const [selectedDoorFilter, setSelectedDoorFilter] = useState<number | 'all'>('all');

  // Trạng thái bài của từng Cửa kèm ảnh snapshot 1080p @ 120fps: { [doorIndex 1..N]: Mode2CardItem[] }
  const [doorCards, setDoorCards] = useState<{ [doorIndex: number]: Mode2CardItem[] }>({});
  const doorCardsRef = useRef(doorCards);
  useEffect(() => {
    doorCardsRef.current = doorCards;
  }, [doorCards]);
  
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


  // Tọa độ chuẩn hóa của Khung ngắm AI (gắn chết theo Video Frame gốc 0.0 - 1.0)
  const [normRoi, setNormRoi] = useState<{ normX: number; normY: number; normW: number; normH: number }>(() => {
    const saved = localStorage.getItem('mode2_norm_roi');
    if (saved) {
      try {
        const p = JSON.parse(saved);
        if (typeof p.normX === 'number' && typeof p.normY === 'number') {
          return {
            normX: p.normX,
            normY: p.normY,
            normW: p.normW || 0.28,
            normH: p.normH || 0.35
          };
        }
      } catch {}
    }
    return { normX: 0.50, normY: 0.52, normW: 0.28, normH: 0.35 };
  });
  const [isReticleActive, setIsReticleActive] = useState<boolean>(true);

  // Trạng thái nhận diện AI
  const [aiStatus, setAiStatus] = useState<string>('Đang quét 120fps trong khung...');
  const [lastDetectedCard, setLastDetectedCard] = useState<string | null>(null);
  const [capturedHistory, setCapturedHistory] = useState<Array<{
    image: string;
    cardName: string;
    confidence: number;
    sharpness?: number;
    timestamp: string;
  }>>([]);
  const [capturedFrame, setCapturedFrame] = useState<{
    image: string;
    cardName: string;
    confidence: number;
    sharpness?: number;
    timestamp: string;
  } | null>(null);
  const [isAiFlashing, setIsAiFlashing] = useState<boolean>(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(0.35);

  // Refs video (Cơ chế Kép: Live WebRTC 0 delay + HLS Replay 120fps) & canvas
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const clientCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const aiCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [lastScanRtt, setLastScanRtt] = useState<number>(0);
  const scanReqTimeRef = useRef<number>(0);
  const replayVideoRef = useRef<HTMLVideoElement | null>(null);
  const [hasVideoSignal, setHasVideoSignal] = useState<boolean>(false);
  const [hasWebRtcSignal, setHasWebRtcSignal] = useState<boolean>(false);
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

  // Giọng đọc kết quả bằng Web Speech API tiếng Việt
  const [isTtsEnabled, setIsTtsEnabled] = useState<boolean>(() => {
    return localStorage.getItem('mode2_tts_enabled') !== 'false';
  });
  const lastSpokenRoundHashRef = useRef<string>('');

  // Trạng thái điều khiển video: Live vs Tua lại
  const [isLive, setIsLive] = useState<boolean>(true);
  const [seekPercent, setSeekPercent] = useState<number>(100); // 100% = Live
  const [dvrWindow, setDvrWindow] = useState<{ start: number; end: number; duration: number }>({ start: 0, end: 0, duration: 0 });
  const isSeekingRef = useRef<boolean>(false);
  const [isDraggingSeek, setIsDraggingSeek] = useState<boolean>(false);
  const isDraggingSeekRef = useRef<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);

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
    const isDomain = window.location.hostname.includes('slomoview.stream');
    navigator.clipboard.writeText(isDomain ? 'https://slomoview.stream' : `http://${ip}:4000`);
    setCopiedIp(true);
    setTimeout(() => setCopiedIp(false), 2000);
  };


  // Hiển thị thanh chỉnh kích thước khung ngắm
  const [showSizeControls, setShowSizeControls] = useState<boolean>(false);
  // Xem ảnh trích xuất phóng to 1:1 gốc
  const [zoomImage, setZoomImage] = useState<string | null>(null);

  // Màn hình Soi Live RAM Crop trực tiếp từ Server 120fps (4 Kênh song song)
  const [debugCrop, setDebugCrop] = useState<{
    image: string;
    cropBox: number[];
    cropSize: string;
    detectedCard: string;
    bestConf: number;
    sharpness?: number;
    sourceFps?: number;
    scanFps?: number;
    isDetected: boolean;
    channels?: {
      id: number;
      seq: number;
      sharpness: number;
      card: string;
      conf: number;
      mode?: string;
    }[];
  } | null>(null);
  const [showDebugMonitor, setShowDebugMonitor] = useState<boolean>(true);

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
    localStorage.setItem('mode2_norm_roi', JSON.stringify(normRoi));
  }, [normRoi]);

  useEffect(() => {
    localStorage.setItem('mode2_histories', JSON.stringify(roundHistories.slice(-20)));
  }, [roundHistories]);

  // Tìm cửa và slot tiếp theo đang chờ lá bài (hỗ trợ Phỏm Cửa 1 = 10 lá & Poker 5 lá bài chung)
  const nextTarget = useMemo(() => {
    const getDoorCap = (d: number) => (gameMode === 'phom9' && d === 1 ? 10 : cardsPerPlayer);

    if (dealStrategy === 'sequential') {
      for (let door = 1; door <= playerCount; door++) {
        const cards = doorCards[door] || [];
        const cap = getDoorCap(door);
        if (cards.length < cap) {
          return { door, slot: cards.length, isCommunity: false };
        }
      }
    } else {
      const maxRounds = gameMode === 'phom9' ? 10 : cardsPerPlayer;
      for (let round = 0; round < maxRounds; round++) {
        for (let door = 1; door <= playerCount; door++) {
          const cap = getDoorCap(door);
          if (round >= cap) continue;
          const cards = doorCards[door] || [];
          if (cards.length === round) {
            return { door, slot: round, isCommunity: false };
          }
        }
      }
    }

    if (gameMode === 'texas5' && communityCards.length < 5) {
      return { door: 0, slot: communityCards.length, isCommunity: true };
    }

    return null;
  }, [doorCards, communityCards, playerCount, cardsPerPlayer, dealStrategy, gameMode]);

  // Đánh giá toàn bộ các Cửa bằng Server 1 Game Engine (hỗ trợ đủ 10 bộ môn bài)
  const server1Evals = useMemo(() => {
    const doorsMatrix: string[][] = [];
    for (let d = 1; d <= playerCount; d++) {
      doorsMatrix.push((doorCards[d] || []).map((c) => c.code));
    }
    const commCodes = communityCards.map((c) => c.code);
    return evaluateAllDoorsServer1(doorsMatrix, commCodes, gameMode, suitRule);
  }, [doorCards, communityCards, playerCount, gameMode, suitRule]);

  // Đánh giá điểm từng Cửa
  const evaluations = useMemo(() => {
    const res: { [door: number]: any } = {};
    for (let d = 1; d <= playerCount; d++) {
      const items = doorCards[d] || [];
      const cap = gameMode === 'phom9' && d === 1 ? 10 : cardsPerPlayer;
      const ev = server1Evals[d - 1];
      const isComplete = ev && ev.score >= 0;
      res[d] = {
        title: isComplete ? ev.title : 'Chờ bài',
        subText: ev?.subTitle ? `${ev.subTitle} (${items.length}/${cap})` : `${items.length}/${cap} lá`,
        points: ev?.score ?? -1,
        chiGroups: ev?.chiGroups,
        chiTitles: ev?.chiTitles,
        highlightClass: isComplete
          ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/40'
          : 'bg-slate-800 text-slate-400'
      };
    }
    return res;
  }, [doorCards, playerCount, gameMode, cardsPerPlayer, server1Evals]);

  // Đối chiếu kết quả & Xếp hạng thắng thua giữa tất cả các Cửa theo chuẩn App Server 1
  const groupAnswersResult = useMemo(() => {
    const baseAnswers = server1Evals.map((ev, idx) => {
      const groupNum = idx + 1;
      const isComplete = ev.score >= 0;
      return {
        groupNum,
        label: isComplete ? ev.title : 'Chờ bài',
        subTitle: ev.subTitle || '',
        score: ev.score,
        isComplete,
        rank: undefined as number | undefined,
        chiGroups: ev.chiGroups,
        chiTitles: ev.chiTitles,
        highlightClass: isComplete
          ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/40'
          : 'bg-slate-800 text-slate-400'
      };
    });

    const completed = baseAnswers
      .filter((a) => a.isComplete && a.score >= 0)
      .sort((a, b) => b.score - a.score);

    let currentRank = 1;
    for (let i = 0; i < completed.length; i++) {
      if (i > 0 && Math.abs(completed[i].score - completed[i - 1].score) > 0.001) {
        currentRank = i + 1;
      }
      completed[i].rank = currentRank;
    }

    const rankByGroup = new Map<number, number>();
    completed.forEach((c) => {
      if (c.rank) rankByGroup.set(c.groupNum, c.rank);
    });

    const answers = baseAnswers.map((a) => {
      const rk = rankByGroup.get(a.groupNum);
      return {
        ...a,
        rank: rk,
        highlightClass:
          rk === 1
            ? 'bg-amber-500 text-slate-950 font-black shadow'
            : a.isComplete
            ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-500/40'
            : 'bg-slate-800 text-slate-400'
      };
    });

    const winnerGroupNum = completed.length > 0 ? completed[0].groupNum : null;
    const leaderboardText =
      completed.length >= 2
        ? '🏆 Xếp hạng: ' +
          completed
            .map((c) => `Hạng ${c.rank}: Cửa ${c.groupNum} (${c.label})`)
            .join(' ➔ ')
        : '';

    return {
      answers,
      sortedComplete: completed,
      winnerGroupNum,
      completeGroupsCount: completed.length,
      leaderboardText
    };
  }, [server1Evals]);

  const isAllDoorsComplete = useMemo(() => {
    if (playerCount <= 0) return false;
    return groupAnswersResult.completeGroupsCount >= playerCount;
  }, [playerCount, groupAnswersResult.completeGroupsCount]);

  const winnerDoor = isAllDoorsComplete ? (groupAnswersResult.winnerGroupNum || 0) : 0;

  // Danh sách các quân bài đã chia theo Cửa để hiển thị ở Khay Soi & Bàn Cược
  const doorCardImages = useMemo(() => {
    const list: { doorNum: number; slotIdx: number; item: Mode2CardItem }[] = [];
    for (let d = 1; d <= playerCount; d++) {
      if (selectedDoorFilter !== 'all' && selectedDoorFilter !== d) continue;
      const items = doorCards[d] || [];
      items.forEach((item, sIdx) => {
        list.push({ doorNum: d, slotIdx: sIdx, item });
      });
    }
    return list;
  }, [doorCards, playerCount, selectedDoorFilter]);

  // Ghi nhận lá bài vào Cửa — Chống trùng bài 100% trong cùng ván (dùng doorCardsRef chống race-condition)
  const addCardToActiveDoor = useCallback(
    (cardCode: string, image?: string, sharpness?: number, confidence?: number, updateOnly?: boolean) => {
      if (updateOnly) {
        setDoorCards((prev) => {
          const next = { ...prev };
          for (let d = playerCount; d >= 1; d--) {
            const list = next[d];
            if (list && list.length > 0) {
              const lastIdx = list.length - 1;
              if (list[lastIdx].code === cardCode) {
                const updated = [...list];
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  image: image || updated[lastIdx].image,
                  sharpness: sharpness || updated[lastIdx].sharpness,
                  confidence: confidence || updated[lastIdx].confidence
                };
                next[d] = updated;
                doorCardsRef.current = next;
                return next;
              }
            }
          }
          return prev;
        });
        return true;
      }

      const currentCards = doorCardsRef.current;
      const currentComm = communityCardsRef.current;
      const alreadyDealt =
        Object.values(currentCards).some((cards) => Array.isArray(cards) && cards.some((c) => c.code === cardCode)) ||
        currentComm.some((c) => c.code === cardCode);
      if (alreadyDealt) return false;

      const getDoorCap = (d: number) => (gameMode === 'phom9' && d === 1 ? 10 : cardsPerPlayer);

      // Tìm cửa tiếp theo theo dealStrategy (sequential hoặc round_robin)
      let targetDoor = -1;
      if (dealStrategy === 'sequential') {
        for (let d = 1; d <= playerCount; d++) {
          const list = currentCards[d] || [];
          if (list.length < getDoorCap(d)) {
            targetDoor = d;
            break;
          }
        }
      } else {
        // round_robin (vòng tròn: lá 1 lần lượt các cửa -> lá 2 -> ...; Phỏm vòng 10 vào Cửa 1)
        const maxRounds = gameMode === 'phom9' ? 10 : cardsPerPlayer;
        for (let s = 0; s < maxRounds; s++) {
          for (let d = 1; d <= playerCount; d++) {
            if (s >= getDoorCap(d)) continue;
            const list = currentCards[d] || [];
            if (list.length === s) {
              targetDoor = d;
              break;
            }
          }
          if (targetDoor !== -1) break;
        }
      }

      const newItem: Mode2CardItem = {
        code: cardCode,
        image,
        sharpness,
        confidence,
        timestamp: new Date().toLocaleTimeString('vi-VN')
      };

      // Nếu là Texas Hold'em và đã chia đủ 2 lá tẩy cho các cửa -> chia tiếp vào 5 lá bài chung
      if (targetDoor === -1) {
        if (gameMode === 'texas5' && currentComm.length < 5) {
          const nextComm = [...currentComm, newItem];
          communityCardsRef.current = nextComm;
          setCommunityCards(nextComm);
          playBeepSound();
          setIsAiFlashing(true);
          setTimeout(() => setIsAiFlashing(false), 450);
          return true;
        }
        return false;
      }

      const updatedMap = {
        ...currentCards,
        [targetDoor]: [...(currentCards[targetDoor] || []), newItem]
      };
      doorCardsRef.current = updatedMap;
      setDoorCards(updatedMap);

      playBeepSound();
      setIsAiFlashing(true);
      setTimeout(() => setIsAiFlashing(false), 450);

      if (socket && roomId) {
        socket.emit('card_added', {
          roomId,
          cardValue: cardCode,
          groupIndex: targetDoor,
          sequenceOrder: Date.now()
        });
      }
      return true;
    },
    [cardsPerPlayer, playerCount, dealStrategy, gameMode, socket, roomId]
  );

  // Hoàn tác lá bài vừa nhận gần nhất
  const handleUndo = () => {
    if (gameMode === 'texas5' && communityCards.length > 0) {
      const nextComm = communityCards.slice(0, -1);
      communityCardsRef.current = nextComm;
      setCommunityCards(nextComm);
      return;
    }

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
        const next = {
          ...prev,
          [lastDoor]: cur.slice(0, -1)
        };
        doorCardsRef.current = next;
        return next;
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

    doorCardsRef.current = {};
    setDoorCards({});
    communityCardsRef.current = [];
    setCommunityCards([]);
    setCapturedFrame(null);
    if (socket && roomId) {
      socket.emit('cards_cleared', { roomId });
    }
    if (onFinishRound) onFinishRound();
  };

  const [webrtcRetryTick, setWebrtcRetryTick] = useState<number>(0);
  const [dvrResetTick, setDvrResetTick] = useState<number>(0);
  const hasWebRtcSignalRef = useRef<boolean>(false);
  useEffect(() => {
    hasWebRtcSignalRef.current = hasWebRtcSignal;
  }, [hasWebRtcSignal]);

  // XONG PHIÊN: Xóa sạch toàn bộ dữ liệu bài, lịch sử các ván, kết quả, âm thanh và DB server
  const handleResetSession = useCallback(() => {
    doorCardsRef.current = {};
    setDoorCards({});
    communityCardsRef.current = [];
    setCommunityCards([]);
    setRoundHistories([]);
    localStorage.removeItem('mode2_histories');
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (activeTtsAudio) {
      try {
        activeTtsAudio.pause();
        activeTtsAudio.currentTime = 0;
      } catch {}
      activeTtsAudio = null;
    }
    lastSpokenRoundHashRef.current = '';
    setCapturedHistory([]);
    setCapturedFrame(null);
    setDebugCrop(null);
    prevThumbRef.current = null;
    setLastDetectedCard('');
    // Giữ nguyên luồng Live WebRTC đang phát, không làm đen màn hình!
    setIsLive(true);
    setSeekPercent(100);
    setPlaybackRate(1.0);
    if (liveVideoRef.current && liveVideoRef.current.paused) {
      liveVideoRef.current.play().catch(() => {});
    }
    if (onFinishRound) {
      onFinishRound();
    } else if (socket && roomId) {
      socket.emit('finish_round', { roomId });
    }
    if (socket && roomId) {
      socket.emit('reset_session_ram', { roomId });
      socket.emit('cards_cleared', { roomId });
    }
    // Sau 1.5s khi server đã tạo lại playlist DVR 0s mới, nạp lại ngầm HLS DVR
    setTimeout(() => {
      setDvrResetTick((t) => t + 1);
    }, 1500);
  }, [socket, roomId, onFinishRound]);

  // 1. Tính toán vùng hiển thị thực tế của Video bên trong container (loại bỏ viền đen)
  const getRenderedVideoRect = useCallback(() => {
    const container = videoContainerRef.current;
    if (!container) return { x: 0, y: 0, width: 800, height: 450 };
    const cw = container.clientWidth || 800;
    const ch = container.clientHeight || 450;
    const isRotated = rotation === 90 || rotation === 270;
    const vidRatio = isRotated ? (1080 / 1920) : (1920 / 1080);
    const cRatio = cw / ch;

    let renderW = cw;
    let renderH = ch;
    let offsetX = 0;
    let offsetY = 0;

    if (isFillMode) {
      if (cRatio > vidRatio) {
        renderW = cw;
        renderH = cw / vidRatio;
        offsetY = (ch - renderH) / 2;
      } else {
        renderH = ch;
        renderW = ch * vidRatio;
        offsetX = (cw - renderW) / 2;
      }
    } else {
      if (cRatio > vidRatio) {
        renderH = ch;
        renderW = ch * vidRatio;
        offsetX = (cw - renderW) / 2;
      } else {
        renderW = cw;
        renderH = cw / vidRatio;
        offsetY = (ch - renderH) / 2;
      }
    }

    return { x: offsetX, y: offsetY, width: renderW, height: renderH };
  }, [rotation, isFillMode]);

  // BỘ ĐỆM FRAME 120 FPS & ĐỒNG BỘ NATIVE VIDEO FRAME CALLBACK (CÓ MOTION GATE & DUAL 120FPS VIEW)
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const motionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevThumbRef = useRef<Uint8ClampedArray | null>(null);
  const isAiBusyRef = useRef<boolean>(false);
  const lastAiSendTimeRef = useRef<number>(0);
  const lastScannedTimeRef = useRef<number>(-1);
  const latestAiDetectionRef = useRef<{ cropBox?: number[]; detectedCard?: string; bestConf?: number; time: number } | null>(null);

  const renderFrame120Fps = useCallback((forcedScan: boolean = false) => {
    const video = (isLive && hasWebRtcSignal) ? liveVideoRef.current : (replayVideoRef.current || liveVideoRef.current);
    if (!video || video.readyState < 2) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    const curTime = video.currentTime || 0;
    const isRotated = rotation === 90 || rotation === 270;
    const orientedW = isRotated ? vh : vw;
    const orientedH = isRotated ? vw : vh;

    const cropW = Math.max(80, Math.round(normRoi.normW * orientedW));
    const cropH = Math.max(80, Math.round(normRoi.normH * orientedH));
    const cropX = Math.max(0, Math.min(orientedW - cropW, Math.round(normRoi.normX * orientedW - cropW / 2)));
    const cropY = Math.max(0, Math.min(orientedH - cropH, Math.round(normRoi.normY * orientedH - cropH / 2)));

    // Tái sử dụng offscreen canvas duy nhất để tránh cấp phát bộ nhớ & GC rác gây giật lag
    if (!offscreenCanvasRef.current) {
      offscreenCanvasRef.current = document.createElement('canvas');
    }
    const offCanvas = offscreenCanvasRef.current;
    if (offCanvas.width !== orientedW || offCanvas.height !== orientedH) {
      offCanvas.width = orientedW;
      offCanvas.height = orientedH;
    }
    const oCtx = offCanvas.getContext('2d');
    if (!oCtx) return;

    oCtx.imageSmoothingEnabled = false;
    oCtx.save();
    oCtx.translate(orientedW / 2, orientedH / 2);
    if (rotation !== 0) {
      oCtx.rotate((rotation * Math.PI) / 180);
    }
    if (isFlipped) {
      oCtx.scale(-1, 1);
    }
    oCtx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
    oCtx.restore();

    const now = performance.now();

    // 1. Vẽ Khung 1 [Client Live ROI] mượt mà 120 FPS không rớt 1 frame nào
    if (clientCanvasRef.current) {
      const cCan = clientCanvasRef.current;
      if (cCan.width !== cropW || cCan.height !== cropH) {
        cCan.width = cropW;
        cCan.height = cropH;
      }
      const ctx1 = cCan.getContext('2d');
      if (ctx1) {
        ctx1.imageSmoothingEnabled = false;
        ctx1.drawImage(offCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      }
    }

    // 2. Vẽ Khung 2 [Server AI View] mượt mà 120 FPS nguyên bản + vẽ đè Bounding Box AI
    if (aiCanvasRef.current) {
      const aCan = aiCanvasRef.current;
      if (aCan.width !== cropW || aCan.height !== cropH) {
        aCan.width = cropW;
        aCan.height = cropH;
      }
      const aCtx = aCan.getContext('2d');
      if (aCtx) {
        aCtx.imageSmoothingEnabled = false;
        aCtx.drawImage(offCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        const curAi = latestAiDetectionRef.current;
        if (curAi && (now - curAi.time < 500)) {
          if (curAi.cropBox && curAi.cropBox.length === 4) {
            const [bx1, by1, bx2, by2] = curAi.cropBox;
            aCtx.strokeStyle = '#10b981';
            aCtx.lineWidth = 3;
            aCtx.strokeRect(bx1, by1, bx2 - bx1, by2 - by1);
          }
          if (curAi.detectedCard && (curAi.bestConf || 0) > 35) {
            aCtx.fillStyle = 'rgba(0, 0, 0, 0.75)';
            aCtx.fillRect(2, 2, 140, 22);
            aCtx.fillStyle = '#34d399';
            aCtx.font = 'bold 12px monospace';
            aCtx.fillText(`${curAi.detectedCard} (${curAi.bestConf}%)`, 6, 17);
          }
        }
      }
    }

    // 3. Đo nhanh biến thiên chuyển động (Motion Check) trên Canvas thu nhỏ 32x32 (<0.05ms)
    let hasMotion = false;
    if (clientCanvasRef.current) {
      if (!motionCanvasRef.current) {
        motionCanvasRef.current = document.createElement('canvas');
        motionCanvasRef.current.width = 32;
        motionCanvasRef.current.height = 32;
      }
      const mCtx = motionCanvasRef.current.getContext('2d', { willReadFrequently: true });
      if (mCtx) {
        mCtx.drawImage(clientCanvasRef.current, 0, 0, 32, 32);
        const imgData = mCtx.getImageData(0, 0, 32, 32).data;
        if (prevThumbRef.current && prevThumbRef.current.length === imgData.length) {
          let diffSum = 0;
          const prev = prevThumbRef.current;
          for (let i = 0; i < imgData.length; i += 4) {
            diffSum += Math.abs(imgData[i] - prev[i]) + Math.abs(imgData[i + 1] - prev[i + 1]) + Math.abs(imgData[i + 2] - prev[i + 2]);
          }
          const avgDiff = diffSum / (32 * 32 * 3);
          if (avgDiff > 4.0) {
            hasMotion = true;
          }
        } else {
          hasMotion = true;
        }
        prevThumbRef.current = new Uint8ClampedArray(imgData);
      }
    }

    // 4. Gửi ảnh tới AI Worker: Tách sang microtask để 0% ảnh hưởng đến nhịp render 120 FPS (hết đứng hình!)
    const timeSinceLastAi = now - lastAiSendTimeRef.current;
    const shouldSendAi = forcedScan || (!isAiBusyRef.current && (hasMotion ? timeSinceLastAi >= 20 : timeSinceLastAi >= 400));

    if (shouldSendAi && socket) {
      isAiBusyRef.current = true;
      lastAiSendTimeRef.current = now;
      scanReqTimeRef.current = now;

      if (!captureCanvasRef.current) {
        captureCanvasRef.current = document.createElement('canvas');
      }
      const capCan = captureCanvasRef.current;
      if (capCan.width !== cropW || capCan.height !== cropH) {
        capCan.width = cropW;
        capCan.height = cropH;
      }
      const capCtx = capCan.getContext('2d');
      if (capCtx) {
        capCtx.imageSmoothingEnabled = false;
        capCtx.drawImage(offCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        setTimeout(() => {
          try {
            const cropBase64 = capCan.toDataURL('image/png');
            const timeStr = `${Math.floor(curTime / 60)}:${(curTime % 60).toFixed(2).padStart(5, '0')}`;
            socket.emit('scan_exact_frame', {
              imageBase64: cropBase64,
              currentTime: curTime,
              timeStr,
              roomId: roomId || 'default'
            });
          } catch {
            isAiBusyRef.current = false;
          }
        }, 0);
      }

      setTimeout(() => {
        isAiBusyRef.current = false;
      }, 180);
    }
  }, [isLive, hasWebRtcSignal, rotation, isFlipped, normRoi, socket, roomId]);

  const scanCurrentFrameFromVideo = useCallback(async (forced: boolean = false) => {
    renderFrame120Fps(forced);
  }, [renderFrame120Fps]);

  // Xử lý kéo thả Ô đỏ trực tiếp trên Video
  const handleReticleDragStart = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const rect = getRenderedVideoRect();
    const startNormX = normRoi.normX;
    const startNormY = normRoi.normY;

    const onMove = (moveEv: MouseEvent | TouchEvent) => {
      const curX = 'touches' in moveEv ? moveEv.touches[0].clientX : (moveEv as MouseEvent).clientX;
      const curY = 'touches' in moveEv ? moveEv.touches[0].clientY : (moveEv as MouseEvent).clientY;
      const dx = curX - clientX;
      const dy = curY - clientY;
      const newNormX = Math.max(0.06, Math.min(0.94, startNormX + dx / rect.width));
      const newNormY = Math.max(0.06, Math.min(0.94, startNormY + dy / rect.height));
      setNormRoi((prev) => ({ ...prev, normX: newNormX, normY: newNormY }));
    };

    const onEnd = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      setTimeout(() => scanCurrentFrameFromVideo(true), 40);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove);
    window.addEventListener('touchend', onEnd);
  };

  // Xử lý co giãn kích thước Ô đỏ
  const handleReticleResize = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const rect = getRenderedVideoRect();
    const startNormW = normRoi.normW;
    const startNormH = normRoi.normH;

    const onMove = (moveEv: MouseEvent | TouchEvent) => {
      const curX = 'touches' in moveEv ? moveEv.touches[0].clientX : (moveEv as MouseEvent).clientX;
      const curY = 'touches' in moveEv ? moveEv.touches[0].clientY : (moveEv as MouseEvent).clientY;
      const dw = curX - clientX;
      const dh = curY - clientY;
      const newNormW = Math.max(0.08, Math.min(0.85, startNormW + dw / rect.width));
      const newNormH = Math.max(0.08, Math.min(0.85, startNormH + dh / rect.height));
      setNormRoi((prev) => ({ ...prev, normW: newNormW, normH: newNormH }));
    };

    const onEnd = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      setTimeout(() => scanCurrentFrameFromVideo(true), 40);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove);
    window.addEventListener('touchend', onEnd);
  };

  const hlsRef = useRef<Hls | null>(null);


  // Quản lý phiên Stream (Đồng bộ từ props và tự động thăm dò luồng mới khi iPhone phát lại)
  const [activeStreamSession, setActiveStreamSession] = useState<StreamSession | null>(stream);

  useEffect(() => {
    setActiveStreamSession(stream);
  }, [stream]);

  // Đồng bộ trạng thái Stream tức thì qua Socket.io
  useEffect(() => {
    if (!socket) return;
    const handleStatusChanged = (data: { roomId?: string; status: 'LIVE' | 'ENDED' | 'IDLE'; session?: StreamSession }) => {
      if (data.status === 'LIVE' && data.session) {
        console.log('[Mode2] ⚡ Socket thông báo có luồng Live:', data.session.streamKey);
        setActiveStreamSession((prev) => {
          const isNewStream = !prev || prev.streamKey !== data.session!.streamKey || prev.status !== 'LIVE';
          if (isNewStream) {
            setHasVideoSignal(false);
            setHasWebRtcSignal(false);
            setIsLive(true);
            setSeekPercent(100);
            setWebrtcRetryTick((t) => t + 1);
          } else if (!hasWebRtcSignalRef.current) {
            // Cùng streamKey (vd: sau khi bấm Xong Phiên) nhưng nếu WebRTC chưa lên thì kích hoạt nối lại
            setIsLive(true);
            setSeekPercent(100);
            setWebrtcRetryTick((t) => t + 1);
          } else {
            // Cùng streamKey và WebRTC đang phát mượt -> Giữ nguyên hình Live, chỉ đảm bảo đang ở chế độ LIVE
            setIsLive(true);
            setSeekPercent(100);
          }
          return data.session!;
        });
      } else if (data.status === 'ENDED') {
        console.log('[Mode2] ⏹ Socket thông báo phiên Live kết thúc (vẫn giữ Replay DVR để tua xem)');
        setActiveStreamSession((prev) => prev ? { ...prev, status: 'ENDED' } : null);
        setIsLive(false);
        setHasWebRtcSignal(false);
      } else if (data.status === 'IDLE') {
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

  // ĐỒNG BỘ TỌA ĐỘ KHUNG ĐỎ (ROI) LÊN SERVER
  useEffect(() => {
    if (!socket || !isReticleActive) return;
    const rw = Math.round(normRoi.normW * 100);
    const rh = Math.round(normRoi.normH * 100);
    const rx = Math.round(normRoi.normX * 100);
    const ry = Math.round(normRoi.normY * 100);
    setAiStatus(`📐 Đã áp dụng cỡ ô soi: ${rw}% x ${rh}% (Tâm ${rx}%, ${ry}%)`);

    socket.emit('set_reticle_roi', {
      normX: normRoi.normX,
      normY: normRoi.normY,
      normW: normRoi.normW,
      normH: normRoi.normH,
      rotation,
      isFlipped,
      isActive: isReticleActive,
      roomId: roomId || 'default'
    });
  }, [socket, normRoi, rotation, isFlipped, isReticleActive, roomId]);

  // NHẬN DIỆN TỪ SERVER-SIDE AI WORKER (120FPS NATIVE DIRECT STREAM)
  useEffect(() => {
    if (!socket) return;
    const handleServerCardDetected = (data: {
      card: any;
      allCards?: any[];
      confidence?: number;
      sharpness?: number;
      image?: string;
      timestamp?: string;
      updateFrameOnly?: boolean;
      roomId?: string;
    }) => {
      if (!data?.card) return;
      if (data?.roomId && data.roomId !== 'default' && roomId && data.roomId !== roomId && user?.role !== 'ADMIN') return;
      const best = data.card;
      const conf = data.confidence || best.confidence || 0.95;
      const sharp = data.sharpness || 0;

      setLastDetectedCard(best.display || best.code);
      setAiStatus(`🎯 120fps bắt dính: ${best.fullName || best.display} (${Math.round(conf * 100)}% | Độ nét ${sharp})`);

      const cardTitle = best.display || best.fullName || best.code;
      const frameData = {
        image: data.image || '',
        cardName: cardTitle,
        confidence: Math.round(conf * 100),
        sharpness: sharp,
        timestamp: data.timestamp || new Date().toLocaleTimeString('vi-VN')
      };

      if (data.updateFrameOnly) {
        // Cập nhật lại đúng lá bài đó bằng bức ảnh 120fps sắc nét hơn vào Cửa & Khay soi!
        addCardToActiveDoor(best.code, data.image, sharp, conf, true);
        setCapturedFrame((prev) => (!prev || sharp >= (prev.sharpness || 0) ? frameData : prev));
        setCapturedHistory((prev) => {
          const idx = prev.findIndex((item) => item.cardName === cardTitle);
          if (idx !== -1) {
            if (sharp >= (prev[idx].sharpness || 0)) {
              const next = [...prev];
              next[idx] = frameData;
              return next;
            }
          }
          return prev;
        });
        return;
      }

      setCapturedFrame(frameData);
      setCapturedHistory((prev) => {
        const existingIdx = prev.findIndex((item) => item.cardName === cardTitle);
        if (existingIdx !== -1) {
          // Nếu lá bài này đã có trong danh sách gần đây, chỉ giữ bức ảnh NÉT HƠN và không nhân đôi
          if (sharp >= (prev[existingIdx].sharpness || 0)) {
            const next = [...prev];
            next[existingIdx] = frameData;
            return next;
          }
          return prev;
        }
        return [frameData, ...prev.filter((item) => item.cardName !== cardTitle).slice(0, 7)];
      });
      addCardToActiveDoor(best.code, data.image, sharp, conf, false);
    };

    socket.on('card_detected', handleServerCardDetected);
    return () => {
      socket.off('card_detected', handleServerCardDetected);
    };
  }, [socket, addCardToActiveDoor]);

  // NHẬN LUỒNG SOI LIVE RAM CROP TRỰC TIẾP TỪ SERVER AI
  useEffect(() => {
    if (!socket) return;
    const handleDebugCrop = (data: any) => {
      if (data?.roomId && data.roomId !== 'default' && roomId && data.roomId !== roomId && user?.role !== 'ADMIN') return;
      if (data && data.image) {
        isAiBusyRef.current = false;
        if (scanReqTimeRef.current > 0) {
          setLastScanRtt(Math.round(performance.now() - scanReqTimeRef.current));
        }
        setDebugCrop(data);

        // Vẽ trực tiếp lên Khung 2 [Server AI View] có vẽ Bounding Box
        if (aiCanvasRef.current) {
          const aCan = aiCanvasRef.current;
          const aCtx = aCan.getContext('2d');
          const img = new Image();
          img.onload = () => {
            if (aCan.width !== img.width || aCan.height !== img.height) {
              aCan.width = img.width;
              aCan.height = img.height;
            }
            if (aCtx) {
              aCtx.drawImage(img, 0, 0);
              if (data.cropBox && data.cropBox.length === 4) {
                const [bx1, by1, bx2, by2] = data.cropBox;
                if (bx2 > bx1 && by2 > by1) {
                  aCtx.strokeStyle = '#10b981';
                  aCtx.lineWidth = 3;
                  aCtx.strokeRect(bx1, by1, bx2 - bx1, by2 - by1);
                }
              }
            }
          };
          img.src = data.image;
        }
      }
    };

    socket.on('ai_debug_crop', handleDebugCrop);
    return () => {
      socket.off('ai_debug_crop', handleDebugCrop);
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
              if (prev?.streamKey !== data.stream.streamKey || prev?.status !== 'LIVE') {
                console.log('[Mode2] Tự động bắt luồng Live mới từ server:', data.stream.streamKey);
                setHasVideoSignal(false);
                setHasWebRtcSignal(false);
                setIsLive(true);
                setSeekPercent(100);
                setWebrtcRetryTick((t) => t + 1);
                return data.stream;
              }
              if (!hasWebRtcSignalRef.current && (!peerRef.current || peerRef.current.connectionState === 'failed' || peerRef.current.connectionState === 'disconnected' || peerRef.current.connectionState === 'closed')) {
                setWebrtcRetryTick((t) => t + 1);
              }
              return prev;
            });
          } else if (data?.stream?.status === 'ENDED') {
            setActiveStreamSession((prev) => {
              if (prev && prev.streamKey === data.stream.streamKey && prev.status === 'ENDED') return prev;
              return data.stream;
            });
            setIsLive(false);
            setHasWebRtcSignal(false);
          } else if (!data?.stream) {
            setHasVideoSignal(false);
            setHasWebRtcSignal(false);
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
    if (!sKey || activeStreamSession?.status === 'ENDED') return '';
    try {
      const cleanKey = sKey.replace(/^live\//, '');
      if (typeof window !== 'undefined' && window.location.origin) {
        return `${window.location.origin}/api/whep/${encodeURIComponent(cleanKey)}`;
      }
      const hostname = window.location.hostname || '127.0.0.1';
      return `http://${hostname}:8889/live/${cleanKey}/whep`;
    } catch {
      return '';
    }
  }, [activeStreamSession?.streamKey, activeStreamSession?.status]);

  // 1. Kết nối WebRTC WHEP Live trực tiếp (Zero Delay <0.2s, 60fps mượt tuyệt đối) với Auto-Retry Loop kiên trì
  useEffect(() => {
    if (!whepUrl) return;
    let cancelled = false;
    let peer: RTCPeerConnection | null = null;
    let sessionUrl: string | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const triggerAutoReconnect = () => {
      if (cancelled) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (!cancelled) {
          setWebrtcRetryTick((t) => t + 1);
        }
      }, 700);
    };

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
                anyReceiver.playoutDelayHint = 0.05;
              }
              if (anyReceiver && 'jitterBufferTarget' in anyReceiver) {
                anyReceiver.jitterBufferTarget = 50;
              }
            } catch {}
            if (cancelled || !streams[0] || !liveVideoRef.current) return;
            if (event.track.kind === 'video') {
              receivedTrack = true;
            }
            liveVideoRef.current.srcObject = streams[0];
            liveVideoRef.current.playbackRate = 1.0;
            liveVideoRef.current.muted = isMuted;
            liveVideoRef.current.play().catch(() => {
              if (liveVideoRef.current) {
                liveVideoRef.current.muted = true;
                liveVideoRef.current.play().catch(() => {});
              }
              const unlockOnGesture = () => {
                if (liveVideoRef.current) liveVideoRef.current.muted = false;
                setIsMuted(false);
                window.removeEventListener('pointerdown', unlockOnGesture, true);
                window.removeEventListener('keydown', unlockOnGesture, true);
              };
              window.addEventListener('pointerdown', unlockOnGesture, true);
              window.addEventListener('keydown', unlockOnGesture, true);
            });
            if (replayVideoRef.current && !replayVideoRef.current.paused) {
              replayVideoRef.current.pause();
            }
            setHasVideoSignal(true);
            setHasWebRtcSignal(true);
            console.log('[Mode2] WebRTC Live đã nhận video track thành công (Zero-Playout-Delay Mode)!');

            const vTrack = streams[0].getVideoTracks()[0];
            if (vTrack) {
              vTrack.onended = () => {
                console.log('[Mode2] WebRTC video track ended -> tự động nối lại...');
                setHasWebRtcSignal(false);
                triggerAutoReconnect();
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

          // Chờ video track đến (tối đa 2.5s)
          await new Promise<void>((resolve, reject) => {
            if (receivedTrack) return resolve();
            const timer = setTimeout(() => {
              if (!receivedTrack) reject(new Error('Chờ video track timeout'));
              else resolve();
            }, 2500);
            peer!.addEventListener('track', (ev) => {
              if (ev.track.kind === 'video') {
                clearTimeout(timer);
                resolve();
              }
            });
          });

          peer.onconnectionstatechange = () => {
            if (peer?.connectionState === 'failed' || peer?.connectionState === 'disconnected') {
              console.log('[Mode2] WebRTC disconnected -> fallback to HLS & tự động nối lại...');
              setHasWebRtcSignal(false);
              triggerAutoReconnect();
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
          // Chờ MediaMTX nhận RTMP từ iPhone (thử liên tục mỗi 500ms cho đến khi luồng lên)
          await new Promise((r) => setTimeout(r, attempt <= 15 ? 500 : 1000));
        }
      }
    };

    connectWebRtc();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (sessionUrl) {
        fetch(sessionUrl, { method: 'DELETE' }).catch(() => {});
        sessionUrl = null;
      }
      if (peerRef.current) {
        peerRef.current.close();
        peerRef.current = null;
      }
    };
  }, [whepUrl, webrtcRetryTick]);

  // 2. Kết nối HLS Replay DVR Master (để tua chậm, tua lại chi tiết từng frame 120fps)
  useEffect(() => {
    const video = replayVideoRef.current;
    if (!video || !activeStreamSession?.streamKey) return;

    const streamKey = activeStreamSession.streamKey;
    const replayUrl = `/replay/${streamKey}/index.m3u8?r=${dvrResetTick}`;
    const liveHlsUrl = `${activeStreamSession.hlsPlaylistUrl || `/live/${streamKey}/index.m3u8`}?r=${dvrResetTick}`;
    let isCancelled = false;

    (async () => {
      let activeHlsUrl = replayUrl;
      // Chờ cho tới khi FFmpeg ghi xong segment .m3u8 đầu tiên (tránh lỗi 404 làm đứng HLS)
      for (let attempt = 1; !isCancelled && attempt <= 30; attempt++) {
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
        await new Promise((r) => setTimeout(r, 800));
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
          backBufferLength: 25,
          maxBufferLength: 8,
          maxMaxBufferLength: 16,
          maxBufferSize: 128 * 1024 * 1024,
          maxBufferHole: 0.1,
          nudgeOffset: 0.05,
          nudgeMaxRetry: 5,
          highBufferWatchdogPeriod: 0,
          liveSyncDuration: 2.0,
          liveMaxLatencyDuration: 4.0,
          maxLiveSyncPlaybackRate: 1.0 // Cố định 1.0x chống giật khựng do buffer underrun
        });

        hlsRef.current = hls;
        hls.loadSource(activeHlsUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setHasVideoSignal(true);
          if (!hasWebRtcSignalRef.current) {
            video.play().catch(() => {});
          }
        });

        hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
          if (data?.details) {
            const total = data.details.totalduration || 0;
            const start = data.details.fragments[0]?.start || 0;
            const end = start + total;
            if (total > 0) {
              setDvrWindow({ start, end, duration: total });
            }
          }
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
        setHasVideoSignal(true);
        if (!hasWebRtcSignalRef.current) {
          video.play().catch(() => {});
        }
      }
    })();

    return () => {
      isCancelled = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [activeStreamSession?.streamKey, activeStreamSession?.hlsPlaylistUrl, dvrResetTick]);



  // ĐỒNG BỘ TRẠNG THÁI SERVER AI & ÉP LUỒNG LIVE BÁM SÁT THỜI GIAN THỰC 1:1 (CHỐNG TRỄ SLO-MO)
  useEffect(() => {
    if (!isReticleActive) return;
    // Giữ tham chiếu hợp lệ
    void canvasRef.current;
    void lastDetectedCodeRef.current;
    void lastDetectionTimeRef.current;

    if (isLive && hasWebRtcSignal) {
      if (replayVideoRef.current && !replayVideoRef.current.paused) {
        replayVideoRef.current.pause();
      }
      if (liveVideoRef.current && liveVideoRef.current.paused) {
        liveVideoRef.current.play().catch(() => {});
      }
    } else if (replayVideoRef.current && replayVideoRef.current.paused) {
      replayVideoRef.current.play().catch(() => {});
    }

    setAiStatus('⚡ AI đang quét bám sát từng frame trực tiếp 120 FPS...');

    // Đồng bộ từng khung hình theo chuẩn requestVideoFrameCallback (120 FPS native)
    let active = true;
    let rVfcId: number | null = null;
    let animId: number | null = null;

    const frameLoop = () => {
      if (!active) return;
      renderFrame120Fps(false);

      const curVid = (isLive && hasWebRtcSignal) ? liveVideoRef.current : (replayVideoRef.current || liveVideoRef.current);
      if (curVid && 'requestVideoFrameCallback' in curVid) {
        rVfcId = (curVid as any).requestVideoFrameCallback(frameLoop);
      } else {
        animId = requestAnimationFrame(frameLoop);
      }
    };

    const initialVid = (isLive && hasWebRtcSignal) ? liveVideoRef.current : (replayVideoRef.current || liveVideoRef.current);
    if (initialVid && 'requestVideoFrameCallback' in initialVid) {
      rVfcId = (initialVid as any).requestVideoFrameCallback(frameLoop);
    } else {
      animId = requestAnimationFrame(frameLoop);
    }

    const syncInterval = setInterval(() => {
      if (!isLive) return;
      if (hasWebRtcSignal && liveVideoRef.current) {
        const v = liveVideoRef.current;
        if (v.paused) v.play().catch(() => {});
        // TUYỆT ĐỐI KHÔNG gán v.currentTime trên luồng WebRTC srcObject để tránh làm đứng bộ giải mã phần cứng Chrome
      } else if (!hasWebRtcSignal && replayVideoRef.current) {
        const rv = replayVideoRef.current;
        if (rv.buffered && rv.buffered.length > 0) {
          const bEnd = rv.buffered.end(rv.buffered.length - 1);
          const lag = bEnd - rv.currentTime;
          if (lag > 1.2) {
            rv.currentTime = Math.max(0, bEnd - 0.35);
            rv.playbackRate = 1.05;
          } else if (lag > 0.6) {
            rv.playbackRate = 1.05;
          } else {
            rv.playbackRate = 1.0;
          }
        }
      }
    }, 250);

    return () => {
      active = false;
      const v = (isLive && hasWebRtcSignal) ? liveVideoRef.current : (replayVideoRef.current || liveVideoRef.current);
      if (v && rVfcId !== null && 'cancelVideoFrameCallback' in v) {
        (v as any).cancelVideoFrameCallback(rVfcId);
      }
      if (animId !== null) {
        cancelAnimationFrame(animId);
      }
      clearInterval(syncInterval);
    };
  }, [isReticleActive, isLive, hasWebRtcSignal, renderFrame120Fps]);

  // Đọc kết quả Cửa Nhất và Cửa Nhì bằng Giọng đọc Tiếng Việt (Server TTS + Web Speech API fallback, lặp lại 2 lần)
  const speakRoundResult = useCallback((forceSpeak: boolean = false) => {
    if (!isTtsEnabled && !forceSpeak) return;

    const completed = (groupAnswersResult.sortedComplete || []).filter((a) => a.isComplete && a.score >= 0);
    if (!isAllDoorsComplete || completed.length < playerCount) return;

    const currentHash = completed.map((a) => `${a.groupNum}:${a.score}:${a.label}`).join('|');
    if (!forceSpeak && lastSpokenRoundHashRef.current === currentHash) return;
    lastSpokenRoundHashRef.current = currentHash;

    const rank1 = completed.filter((a) => a.rank === 1);
    const rank2 = completed.filter((a) => a.rank === 2);

    const cleanReason = (lbl: string) => {
      let c = (lbl || '')
        .replace(/\(♦\)/g, ' có rô ')
        .replace(/♦/g, ' rô ')
        .replace(/♥/g, ' cơ ')
        .replace(/♣/g, ' tép ')
        .replace(/♠/g, ' bích ')
        .replace(/[\(\)\u{1F451}\u{2B50}\u{2728}\u{1F525}\u{1F31F}]/gu, '')
        .trim();
      return c.replace(/\s+/g, ' ').toLowerCase();
    };

    let textToSpeak = '';
    if (rank1.length > 1) {
      const names = rank1.map((d) => `Cửa ${d.groupNum}`).join(' và ');
      const r = cleanReason(rank1[0].label);
      textToSpeak = `${names} đồng hạng nhất với lý do ${r}.`;
    } else if (rank1.length === 1) {
      const w = rank1[0];
      const wReason = cleanReason(w.label);
      const r1 = `Cửa ${w.groupNum} về nhất với lý do ${wReason}.`;
      if (rank2.length > 1) {
        const names2 = rank2.map((d) => `Cửa ${d.groupNum}`).join(' và ');
        const r2 = cleanReason(rank2[0].label);
        textToSpeak = `${r1} ${names2} đồng hạng nhì với lý do ${r2}.`;
      } else if (rank2.length === 1) {
        const s = rank2[0];
        const sReason = cleanReason(s.label);
        textToSpeak = `${r1} Cửa ${s.groupNum} về nhì với lý do ${sReason}.`;
      } else {
        textToSpeak = r1;
      }
    }

    if (!textToSpeak) return;

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (activeTtsAudio) {
      try {
        activeTtsAudio.pause();
        activeTtsAudio.currentTime = 0;
      } catch {}
      activeTtsAudio = null;
    }

    let repeat = 0;

    const playNativeSpeechFallback = () => {
      if (!('speechSynthesis' in window) || repeat >= 2) return;
      try {
        window.speechSynthesis.resume();
        const u = new SpeechSynthesisUtterance(textToSpeak);
        u.lang = 'vi-VN';
        u.rate = 0.95;
        const voices = window.speechSynthesis.getVoices();
        const viVoice = voices.find((v) => v.lang === 'vi-VN' || v.lang.toLowerCase().startsWith('vi'));
        if (viVoice) u.voice = viVoice;
        u.onend = () => {
          repeat++;
          if (repeat < 2) {
            setTimeout(playNativeSpeechFallback, 700);
          }
        };
        window.speechSynthesis.speak(u);
      } catch {}
    };

    const playServerTts = () => {
      if (repeat >= 2) return;
      try {
        const audio = new Audio(`/api/tts?text=${encodeURIComponent(textToSpeak)}`);
        activeTtsAudio = audio;
        audio.onended = () => {
          repeat++;
          if (repeat < 2) {
            setTimeout(playServerTts, 650);
          }
        };
        audio.onerror = () => {
          playNativeSpeechFallback();
        };
        audio.play().catch(() => {
          playNativeSpeechFallback();
        });
      } catch {
        playNativeSpeechFallback();
      }
    };

    setTimeout(playServerTts, 50);
  }, [groupAnswersResult.sortedComplete, isTtsEnabled, isAllDoorsComplete, playerCount]);

  // Tự động đọc kết quả khi ván bài chia xong đủ các cửa
  useEffect(() => {
    if (isAllDoorsComplete && groupAnswersResult.completeGroupsCount >= playerCount && playerCount >= 2) {
      speakRoundResult(false);
    }
  }, [isAllDoorsComplete, groupAnswersResult.completeGroupsCount, playerCount, speakRoundResult]);

  // Tua bước chính xác từng khoảng giây (Replay DVR)
  const stepReplay = (offsetSeconds: number) => {
    setIsLive(false);
    const rv = replayVideoRef.current;
    if (!rv) return;
    if (liveVideoRef.current && !liveVideoRef.current.paused) {
      liveVideoRef.current.pause();
    }
    
    let curTime = rv.currentTime;
    let s = dvrWindow.start;
    let e = dvrWindow.end;
    let dur = dvrWindow.duration;
    if (rv.seekable && rv.seekable.length > 0) {
      s = rv.seekable.start(0);
      e = rv.seekable.end(0);
      dur = e - s;
    }
    
    if (isLive || curTime < s || curTime > e || curTime === 0) {
      curTime = Math.max(s, e - 0.2);
    }
    
    let targetTime = curTime + offsetSeconds;
    if (dur > 0) {
      targetTime = Math.max(s, Math.min(e, targetTime));
      const pct = Math.max(0, Math.min(100, ((targetTime - s) / dur) * 100));
      setSeekPercent(pct);
    }
    
    rv.pause();
    rv.currentTime = targetTime;
    setTimeout(() => scanCurrentFrameFromVideo(true), 60);
  };

  // Xử lý tua lại video theo chuẩn DVR Sliding Window
  const handleSeekChange = (pct: number) => {
    setSeekPercent(pct);
    if (pct >= 99 && activeStreamSession?.status === 'LIVE') {
      jumpToLive();
      return;
    }
    setIsLive(false);
    const rv = replayVideoRef.current;
    if (rv) {
      let s = dvrWindow.start;
      let dur = dvrWindow.duration;
      if (rv.seekable && rv.seekable.length > 0) {
        s = rv.seekable.start(0);
        const eTime = rv.seekable.end(0);
        dur = eTime - s;
      }
      if (dur > 0) {
        const targetTime = s + (pct / 100) * dur;
        rv.currentTime = targetTime;
        setTimeout(() => scanCurrentFrameFromVideo(true), 40);
      }
    }
    if (liveVideoRef.current && !liveVideoRef.current.paused) {
      liveVideoRef.current.pause();
    }
  };

  const jumpToLive = () => {
    setIsLive(true);
    setSeekPercent(100);
    if (liveVideoRef.current) {
      liveVideoRef.current.play().catch(() => {});
    }
    const rv = replayVideoRef.current;
    if (rv) {
      if (rv.seekable && rv.seekable.length > 0) {
        const bEnd = rv.seekable.end(0);
        rv.currentTime = Math.max(0, bEnd - 0.5);
      }
      rv.playbackRate = 1.0;
      rv.play().catch(() => {});
    }
    setPlaybackRate(1.0);
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

          {/* Nút Xong Phiên / Xóa Sạch RAM (Màu cam hổ phách) */}
          <button
            onClick={handleResetSession}
            title="Xóa sạch bài trên bàn, lịch sử ảnh chụp và giải phóng bộ đệm RAM để test lại từ đầu"
            className="px-3.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-black shadow-md shadow-amber-600/40 flex items-center space-x-1 transition active:scale-95 tracking-wide"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Xong phiên</span>
          </button>
        </div>
      </div>

      {/* 2. HÀNG TRÊN: CHIA ĐÔI 50/50 (TRÁI: MÀN HÌNH LIVE 1080P - PHẢI: SOI RAM CROP 120FPS & LỊCH SỬ KẾT QUẢ) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-stretch">
        {/* CỘT TRÁI (Lg: 6 cột - 50%): MÀN HÌNH LIVE VIDEO + KHUNG NGẮM AI ĐỎ */}
<div className="lg:col-span-6 bg-black rounded-xl border border-slate-700/80 overflow-hidden shadow-2xl relative flex flex-col justify-between">
          {/* Thanh công cụ trên đầu Video: Độ phân giải, FPS, Lật, Xoay & Cỡ Khung */}
          <div className="bg-slate-950/85 backdrop-blur px-3 py-1.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-1.5 z-20 text-[11px]">
            {/* Resolution & FPS Tags */}
            <div className="flex items-center space-x-1.5 font-mono">
              <span className="px-1.5 py-0.5 rounded bg-indigo-600 text-white font-bold text-[10px]">1080p</span>
              <span className="px-1.5 py-0.5 rounded bg-emerald-600/90 text-white font-bold text-[10px]">120 fps</span>
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


              {/* Nút Đặt lại vị trí trung tâm */}
              <button
                type="button"
                onClick={() => {
                  setNormRoi({ normX: 0.50, normY: 0.52, normW: 0.28, normH: 0.35 });
                  setTimeout(() => scanCurrentFrameFromVideo(true), 40);
                }}
                className="px-2 py-0.5 rounded text-[11px] font-bold flex items-center space-x-1 bg-slate-800 text-slate-300 hover:text-white transition"
                title="Đặt lại khung ngắm vào giữa bàn chia bài (50%)"
              >
                <Crosshair className="w-3 h-3 text-red-400" />
                <span>Về Giữa</span>
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

              {/* Nút bật/tắt Soi Crop RAM Server 120fps */}
              <button
                onClick={() => setShowDebugMonitor((p) => !p)}
                className={`px-2 py-0.5 rounded text-[11px] font-bold flex items-center space-x-1 border transition ${
                  showDebugMonitor ? 'bg-amber-500/20 text-amber-300 border-amber-500/50' : 'bg-slate-800 text-slate-400 border-slate-700'
                }`}
                title="Bật/Tắt màn hình soi trực tiếp luồng crop trong RAM Server 120fps"
              >
                <span>📺 Soi RAM {showDebugMonitor ? '(Bật)' : '(Tắt)'}</span>
              </button>
            </div>
          </div>

          {/* GIAO DIỆN CHỈNH KÍCH THƯỚC KHUNG NGẮM (THEO % VIDEO FRAME GỐC) */}
          {showSizeControls && (
            <div className="bg-slate-900/95 border-b border-slate-700/80 px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 z-20 text-xs shadow-md">
              <div className="flex items-center space-x-3">
                {/* Chỉnh Rộng */}
                <div className="flex items-center space-x-1.5 bg-slate-800 px-2 py-0.5 rounded-lg border border-slate-700">
                  <span className="text-slate-400 text-[11px]">Rộng:</span>
                  <button
                    onClick={() => {
                      setNormRoi((s) => ({ ...s, normW: Math.max(0.10, s.normW - 0.03) }));
                      setTimeout(() => scanCurrentFrameFromVideo(true), 40);
                    }}
                    className="w-4 h-4 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center text-xs active:scale-95"
                  >-</button>
                  <span className="w-10 text-center font-bold text-amber-300 font-mono text-[11px]">{Math.round(normRoi.normW * 100)}%</span>
                  <button
                    onClick={() => {
                      setNormRoi((s) => ({ ...s, normW: Math.min(0.85, s.normW + 0.03) }));
                      setTimeout(() => scanCurrentFrameFromVideo(true), 40);
                    }}
                    className="w-4 h-4 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center text-xs active:scale-95"
                  >+</button>
                </div>

                {/* Chỉnh Dài */}
                <div className="flex items-center space-x-1.5 bg-slate-800 px-2 py-0.5 rounded-lg border border-slate-700">
                  <span className="text-slate-400 text-[11px]">Dài:</span>
                  <button
                    onClick={() => {
                      setNormRoi((s) => ({ ...s, normH: Math.max(0.10, s.normH - 0.03) }));
                      setTimeout(() => scanCurrentFrameFromVideo(true), 40);
                    }}
                    className="w-4 h-4 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center text-xs active:scale-95"
                  >-</button>
                  <span className="w-10 text-center font-bold text-amber-300 font-mono text-[11px]">{Math.round(normRoi.normH * 100)}%</span>
                  <button
                    onClick={() => {
                      setNormRoi((s) => ({ ...s, normH: Math.min(0.85, s.normH + 0.03) }));
                      setTimeout(() => scanCurrentFrameFromVideo(true), 40);
                    }}
                    className="w-4 h-4 rounded bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center text-xs active:scale-95"
                  >+</button>
                </div>
              </div>

              {/* Nút Cỡ Mẫu (Presets) */}
              <div className="flex items-center space-x-1 text-[10px]">
                <span className="text-slate-400 mr-1">Cỡ mẫu:</span>
                <button
                  onClick={() => {
                    setNormRoi((s) => ({ ...s, normW: 0.20, normH: 0.25 }));
                    setTimeout(() => scanCurrentFrameFromVideo(true), 40);
                  }}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
                >Nhỏ</button>
                <button
                  onClick={() => {
                    setNormRoi((s) => ({ ...s, normW: 0.28, normH: 0.35 }));
                    setTimeout(() => scanCurrentFrameFromVideo(true), 40);
                  }}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 hover:text-white font-bold transition"
                >Chuẩn</button>
                <button
                  onClick={() => {
                    setNormRoi((s) => ({ ...s, normW: 0.35, normH: 0.42 }));
                    setTimeout(() => scanCurrentFrameFromVideo(true), 40);
                  }}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
                >Lớn</button>
                <button
                  onClick={() => {
                    setNormRoi((s) => ({ ...s, normW: 0.38, normH: 0.26 }));
                    setTimeout(() => scanCurrentFrameFromVideo(true), 40);
                  }}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-indigo-300 hover:text-white transition"
                >Ngang</button>
              </div>
            </div>
          )}

          {/* VÙNG CHỨA VIDEO & KHUNG NGẮM AI ĐỎ (CỐ ĐỊNH THEO TỶ LỆ VIDEO LIVE GỐC) */}
          <div
            ref={videoContainerRef}
            className="relative w-full h-[360px] sm:h-[420px] md:h-[480px] bg-black overflow-hidden select-none group flex items-center justify-center"
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
                const rv = replayVideoRef.current;
                if (rv && rv.seekable && rv.seekable.length > 0) {
                  const s = rv.seekable.start(0);
                  const e = rv.seekable.end(0);
                  const dur = e - s;
                  if (dur > 0) {
                    setDvrWindow({ start: s, end: e, duration: dur });
                    if (!isLive && !isSeekingRef.current && !isDraggingSeekRef.current) {
                      const cur = rv.currentTime;
                      const pct = Math.max(0, Math.min(100, ((cur - s) / dur) * 100));
                      setSeekPercent(pct);
                    }
                  }
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

            {/* KHUNG NGẮM AI MÀU ĐỎ GẮN CỐ ĐỊNH THEO TỶ LỆ KHUNG HÌNH VIDEO (LƯU NHỚ VĨNH VIỄN) */}
            {isReticleActive && (() => {
              const vRect = getRenderedVideoRect();
              const boxW = Math.max(80, Math.round(normRoi.normW * vRect.width));
              const boxH = Math.max(80, Math.round(normRoi.normH * vRect.height));
              const boxX = Math.round(vRect.x + normRoi.normX * vRect.width - boxW / 2);
              const boxY = Math.round(vRect.y + normRoi.normY * vRect.height - boxH / 2);

              return (
                <div
                  style={{
                    position: 'absolute',
                    left: `${boxX}px`,
                    top: `${boxY}px`,
                    width: `${boxW}px`,
                    height: `${boxH}px`,
                    pointerEvents: 'auto'
                  }}
                  className={`z-30 border-2 rounded-lg pointer-events-auto transition-colors ${
                    isAiFlashing
                      ? 'border-emerald-400 bg-emerald-500/15 shadow-[0_0_25px_rgba(52,211,153,0.9)]'
                      : 'border-red-500 bg-red-500/5 shadow-[0_0_15px_rgba(239,68,68,0.7)]'
                  }`}
                >
                  {/* Header nhãn nổi - KÉO VÀO ĐÂY ĐỂ DI CHUYỂN Ô ĐỎ */}
                  <div
                    onMouseDown={handleReticleDragStart}
                    onTouchStart={handleReticleDragStart}
                    className="absolute -top-6 left-0 right-0 flex items-center justify-between text-[10px] font-bold text-white bg-black/90 px-2 py-0.5 rounded-t backdrop-blur border-t border-x border-red-500/50 cursor-move whitespace-nowrap shadow select-none"
                    title="Giữ chuột hoặc chạm kéo thanh này để di chuyển ô đỏ đến đúng vị trí bài"
                  >
                    <span className="flex items-center space-x-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${isAiFlashing ? 'bg-emerald-400' : 'bg-red-500 animate-ping'}`} />
                      <span>✥ KÉO DI CHUYỂN</span>
                    </span>
                    <span className="font-mono text-amber-300 ml-1">
                      {Math.round(normRoi.normW * 100)}%x{Math.round(normRoi.normH * 100)}%
                    </span>
                  </div>

                  {/* Thân ô đỏ - Kéo để di chuyển đến vị trí lá bài */}
                  <div
                    onMouseDown={handleReticleDragStart}
                    onTouchStart={handleReticleDragStart}
                    className="absolute inset-0 cursor-move"
                    title="Kéo ô đỏ đến vị trí chia bài"
                  />

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
                    onMouseDown={handleReticleResize}
                    onTouchStart={handleReticleResize}
                    className="absolute bottom-0 right-0 w-6 h-6 flex items-end justify-end p-0.5 cursor-nwse-resize z-30"
                    title="Kéo góc để chỉnh kích thước Dài/Rộng"
                  >
                    <div className="w-3 h-3 border-r-2 border-b-2 border-red-400 rounded-br-sm bg-red-500/30" />
                  </div>
                </div>
              );
            })()}
            {/* KHUNG HIỂN THỊ ẢNH TRÍCH XUẤT THỰC TẾ CỦA LÁ BÀI RÕ NÉT NHẤT */}
            {capturedFrame && (
              <div className="absolute top-2.5 right-2.5 z-30 bg-slate-950/95 border-2 border-emerald-500 rounded-xl p-1.5 shadow-[0_0_25px_rgba(16,185,129,0.5)] backdrop-blur-md flex flex-col items-center pointer-events-auto transition-all animate-in fade-in zoom-in-95 duration-200">
                <div className="flex items-center justify-between w-full px-1 mb-1 text-[10px] font-bold text-emerald-400">
                  <span className="flex items-center gap-1">📸 Frame bắt được</span>
                  <span className="text-amber-300 font-mono font-black">{capturedFrame.confidence}%</span>
                </div>
                <div 
                  onClick={() => setZoomImage(capturedFrame.image)}
                  className="w-24 h-32 sm:w-28 sm:h-36 rounded-lg overflow-hidden bg-black border border-emerald-500/40 flex items-center justify-center relative shadow-inner cursor-pointer hover:border-emerald-400 transition"
                  title="Nhấp để xem ảnh 1080p gốc 1:1"
                >
                  <img
                    src={capturedFrame.image}
                    alt={capturedFrame.cardName}
                    className="w-full h-full object-contain"
                    style={{ imageRendering: '-webkit-optimize-contrast' }}
                  />
                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black via-black/85 to-transparent p-1 text-center">
                    <span className="text-[11px] font-black text-white">{capturedFrame.cardName}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between w-full px-1 mt-1 text-[9px] text-slate-400 font-mono">
                  <span>{capturedFrame.timestamp}</span>
                  <span className="text-emerald-400 font-bold">1080p@120fps {capturedFrame.sharpness ? `• Nét ${capturedFrame.sharpness}` : ''}</span>
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

            {/* Nút tua bước nhanh (Step DVR) */}
            <div className="flex items-center space-x-1">
              <button
                type="button"
                onClick={() => stepReplay(-3)}
                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px] font-bold border border-slate-700/80 transition"
                title="Tua lùi 3 giây"
              >
                ⏪ -3s
              </button>
              <button
                type="button"
                onClick={() => stepReplay(-0.5)}
                className="px-1.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px] font-bold border border-slate-700/80 transition"
                title="Tua lùi 0.5 giây"
              >
                ◀ -0.5s
              </button>
              <button
                type="button"
                onClick={() => stepReplay(0.5)}
                className="px-1.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px] font-bold border border-slate-700/80 transition"
                title="Tua tiến 0.5 giây"
              >
                ▶ +0.5s
              </button>
              <button
                type="button"
                onClick={() => stepReplay(3)}
                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px] font-bold border border-slate-700/80 transition"
                title="Tua tiến 3 giây"
              >
                ⏩ +3s
              </button>
            </div>

            {/* Thanh Timeline Tua lại (Scrubbing Seekbar) */}
            <div className="flex-1 min-w-[150px] flex items-center space-x-2">
              <span className="text-[10px] text-slate-400 font-mono">Tua:</span>
              <input
                type="range"
                min={0}
                max={100}
                step={0.5}
                value={isLive ? 100 : seekPercent}
                onMouseDown={() => {
                  isDraggingSeekRef.current = true;
                  setIsDraggingSeek(true);
                  if (replayVideoRef.current && !replayVideoRef.current.paused) {
                    replayVideoRef.current.pause();
                  }
                }}
                onTouchStart={() => {
                  isDraggingSeekRef.current = true;
                  setIsDraggingSeek(true);
                  if (replayVideoRef.current && !replayVideoRef.current.paused) {
                    replayVideoRef.current.pause();
                  }
                }}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setSeekPercent(val);
                }}
                onMouseUp={(e) => {
                  isDraggingSeekRef.current = false;
                  setIsDraggingSeek(false);
                  const val = parseFloat((e.target as HTMLInputElement).value);
                  handleSeekChange(val);
                }}
                onTouchEnd={() => {
                  isDraggingSeekRef.current = false;
                  setIsDraggingSeek(false);
                  handleSeekChange(seekPercent);
                }}
                className="flex-1 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-red-500"
              />
              <span className="text-[10px] text-slate-300 font-mono whitespace-nowrap min-w-[65px] text-right">
                {isLive || seekPercent >= 99
                  ? '🔴 LIVE'
                  : `${(-((100 - seekPercent) / 100) * (dvrWindow.duration || 30)).toFixed(1)}s`}
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

        {/* CỘT PHẢI (Lg: 6 cột - 50%): KHUNG SOI LIVE RAM CROP 120FPS + BẢNG LỊCH SỬ KẾT QUẢ */}
        <div className="lg:col-span-6 flex flex-col gap-3">
          {/* MỤC 1: BẢNG ĐIỀU KHIỂN TRÒ CHƠI & XẾP HẠNG TÍNH ĐIỂM THEO CHẾ ĐỘ 1 */}
          <div className="bg-slate-900/90 border border-slate-700/80 rounded-xl p-3 shadow-xl backdrop-blur flex flex-col space-y-3">
            {/* Header: Thể loại chơi (Đầy đủ 10 bộ môn chuẩn App Server 1) */}
            <div className="flex flex-col space-y-2 pb-2 border-b border-slate-800 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold text-slate-200 flex items-center space-x-1.5">
                  <Sliders className="w-4 h-4 text-emerald-400" />
                  <span>Bộ Môn Bài (Chuẩn App Server 1)</span>
                </span>
                {(gameMode === '3cards' || gameMode === 'lieng3') && (
                  <div className="flex items-center space-x-1 bg-slate-950/80 p-0.5 rounded-lg border border-slate-800 text-[10px]">
                    <span className="text-slate-400 px-1">Xét chất:</span>
                    {([
                      { id: 'ro_bonus', label: 'Có Rô ♦' },
                      { id: 'co_ro_tep_bich', label: 'Cơ>Rô>Tép>Bích' },
                      { id: 'bich_ro_co_tep', label: 'Bích>Rô>Cơ>Tép' },
                      { id: 'dong_hang', label: 'Đồng hạng' }
                    ] as { id: SuitRuleType; label: string }[]).map((sr) => (
                      <button
                        key={sr.id}
                        type="button"
                        onClick={() => {
                          setSuitRule(sr.id);
                          localStorage.setItem('mode2_suit_rule', sr.id);
                        }}
                        className={`px-1.5 py-0.5 rounded font-bold transition ${
                          suitRule === sr.id
                            ? 'bg-amber-500 text-slate-950 font-black'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {sr.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1">
                {([
                  { id: '3cards', label: '3 Lá (Bài Cào ♦)' },
                  { id: 'lieng3', label: 'Liêng / 3 Cây' },
                  { id: '2cards', label: '2 Lá (Xì Dách)' },
                  { id: 'texas5', label: 'Poker (2+5 Chung)' },
                  { id: 'binh6', label: 'Binh 6 Lá' },
                  { id: 'binh9', label: 'Binh 9 Lá (Có Liêng)' },
                  { id: 'binh9NoStraight', label: '9 Lá Không Liên' },
                  { id: 'phom9', label: 'Phỏm (9-10 Lá)' },
                  { id: 'samLoc10', label: 'Sâm Lốc (10 Lá)' },
                  { id: 'chan19', label: 'Chắn TQ (19 Lá)' }
                ] as { id: Server1GameMode; label: string }[]).map((gm) => (
                  <button
                    key={gm.id}
                    type="button"
                    onClick={() => {
                      setGameMode(gm.id);
                      localStorage.setItem('mode2_game_mode', gm.id);
                    }}
                    className={`px-2 py-1 rounded text-[11px] font-bold transition ${
                      gameMode === gm.id
                        ? 'bg-emerald-600 text-white shadow-md shadow-emerald-500/20 ring-1 ring-emerald-400'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {gm.label}
                  </button>
                ))}
              </div>

              {/* Thanh 5 Lá Bài Chung (Community Cards) khi chơi Poker Texas Hold'em */}
              {gameMode === 'texas5' && (
                <div className="flex flex-wrap items-center justify-between gap-2 bg-indigo-950/40 border border-indigo-500/40 rounded-lg px-2.5 py-1.5">
                  <span className="font-bold text-indigo-300 text-[11px]">
                    🃏 5 Lá Bài Chung ({communityCards.length}/5):
                  </span>
                  <div className="flex items-center space-x-1.5">
                    {Array.from({ length: 5 }, (_, cIdx) => {
                      const cItem = communityCards[cIdx];
                      const f = cItem ? formatCardItem(cItem.code) : null;
                      const isNextComm = nextTarget?.isCommunity && nextTarget?.slot === cIdx;
                      return (
                        <div
                          key={cIdx}
                          onClick={() => {
                            setPickerTarget({
                              mode: cItem ? 'edit' : 'add',
                              groupNum: 0,
                              slotIndex: cIdx,
                              currentValue: cItem?.code || ''
                            });
                            setPickerOpen(true);
                          }}
                          className={`px-2 py-1 rounded border text-xs font-mono font-black cursor-pointer transition ${
                            isNextComm
                              ? 'border-emerald-400 bg-emerald-500/20 text-emerald-300 animate-pulse'
                              : f
                              ? f.isRed
                                ? 'bg-rose-950 border-rose-500 text-rose-300'
                                : 'bg-slate-800 border-slate-500 text-white'
                              : 'border-dashed border-slate-600 bg-slate-900/60 text-slate-500'
                          }`}
                          title="Nhấn để chọn/sửa lá bài chung"
                        >
                          {f ? `${f.rank}${f.symbol}` : `Chung ${cIdx + 1}`}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Chọn Số Cửa & Chế độ chia bài */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center space-x-1.5">
                <span className="text-slate-400 font-medium">Số Cửa:</span>
                {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <button
                    key={n}
                    onClick={() => {
                      setPlayerCount(n);
                      localStorage.setItem('mode2_player_count', n.toString());
                    }}
                    className={`w-7 h-7 rounded font-bold transition text-xs ${
                      playerCount === n
                        ? 'bg-amber-500 text-slate-950 font-black shadow'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>

              <div className="flex items-center space-x-1 bg-slate-950/70 p-1 rounded-lg border border-slate-800">
                <button
                  onClick={() => setDealStrategy('roundRobin')}
                  className={`px-2 py-0.5 rounded text-[11px] font-bold transition ${
                    dealStrategy === 'roundRobin'
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-slate-400 hover:text-white'
                  }`}
                  title="Chia lần lượt mỗi cửa 1 lá xoay vòng"
                >
                  Vòng Tròn
                </button>
                <button
                  onClick={() => setDealStrategy('sequential')}
                  className={`px-2 py-0.5 rounded text-[11px] font-bold transition ${
                    dealStrategy === 'sequential'
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-slate-400 hover:text-white'
                  }`}
                  title="Chia xong từng cửa rồi sang cửa kế"
                >
                  Từng Cửa
                </button>
              </div>
            </div>

            {/* BẢNG XẾP HẠNG & TÍNH ĐIỂM THẮNG THUA (NHƯ CHẾ ĐỘ 1) */}
            <div className="bg-slate-950/80 p-2.5 rounded-xl border border-slate-800 flex flex-col space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
                <span className="font-bold text-slate-300 flex items-center space-x-1.5">
                  <Award className="w-3.5 h-3.5 text-amber-400" />
                  <span>Xếp Hạng & Điểm Số Các Cửa:</span>
                </span>
                <div className="flex items-center space-x-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const next = !isTtsEnabled;
                      setIsTtsEnabled(next);
                      localStorage.setItem('mode2_tts_enabled', next.toString());
                      if (!next && 'speechSynthesis' in window) window.speechSynthesis.cancel();
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold transition flex items-center space-x-1 ${
                      isTtsEnabled
                        ? 'bg-indigo-600/80 text-white border border-indigo-400/50 shadow'
                        : 'bg-slate-800 text-slate-400 border border-slate-700'
                    }`}
                    title={isTtsEnabled ? 'Tắt giọng nói đọc kết quả' : 'Bật giọng nói đọc kết quả'}
                  >
                    {isTtsEnabled ? <Volume2 className="w-3 h-3 text-indigo-300" /> : <VolumeX className="w-3 h-3 text-slate-500" />}
                    <span>{isTtsEnabled ? 'Giọng đọc: BẬT' : 'Giọng đọc: TẮT'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => speakRoundResult(true)}
                    className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-[10px] font-bold flex items-center space-x-1 transition"
                    title="Đọc kết quả Nhất & Nhì (lặp lại 2 lần)"
                  >
                    <Volume2 className="w-3 h-3 text-amber-400" />
                    <span>Đọc lại (2 lần)</span>
                  </button>
                  {isAllDoorsComplete && winnerDoor > 0 && (
                    <span className="text-[11px] font-black text-amber-300 bg-amber-950/80 px-2 py-0.5 rounded border border-amber-600/50 shadow">
                      👑 Cửa {winnerDoor} Thắng Nhất
                    </span>
                  )}
                </div>
              </div>

              {/* Lưới Điểm Từng Cửa: Hiện con bài quy đổi -> Điểm số -> Xếp hạng */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2 text-center text-xs">
                {groupAnswersResult.answers.map((ans) => {
                  const isWin = ans.groupNum === winnerDoor;
                  const cList = doorCards[ans.groupNum] || [];
                  const formula = getConversionFormula(cList, gameMode);
                  return (
                    <div
                      key={ans.groupNum}
                      className={`p-2 rounded-xl border flex flex-col items-center justify-between transition min-h-[110px] ${
                        isWin
                          ? 'bg-amber-950/50 border-amber-400 text-amber-300 shadow-md shadow-amber-500/20 ring-1 ring-amber-400'
                          : 'bg-slate-900/90 border-slate-800 text-slate-300'
                      }`}
                    >
                      {/* Tiêu đề Cửa */}
                      <div className="w-full flex items-center justify-between font-bold text-[11px] border-b border-white/5 pb-1">
                        <span>Cửa {ans.groupNum}</span>
                        {isWin && <span className="text-amber-400">👑 Nhất</span>}
                      </div>

                      {/* Các con bài đã bóc tách & icon chất */}
                      <div className="my-1 flex flex-col items-center justify-center">
                        {cList.length > 0 ? (
                          <>
                            <div className="flex items-center justify-center flex-wrap gap-1">
                              {cList.map((c, i) => {
                                const f = formatCardItem(c.code);
                                return (
                                  <span
                                    key={i}
                                    className={`px-1.5 py-0.5 rounded text-[11px] font-black border font-mono ${
                                      f.isRed
                                        ? 'bg-rose-950/80 border-rose-500/70 text-rose-300'
                                        : 'bg-slate-800 border-slate-600 text-slate-100'
                                    }`}
                                  >
                                    {f.rank}{f.symbol}
                                  </span>
                                );
                              })}
                            </div>
                            {formula && (
                              <div className="text-[10px] text-amber-300 font-mono font-medium tracking-tight mt-1 bg-slate-950/70 px-1 py-0.5 rounded border border-white/5">
                                {formula}
                              </div>
                            )}
                            {ans.chiTitles && ans.chiTitles.length > 0 ? (
                              <div className="w-full mt-1 space-y-0.5 text-[9px] text-left bg-slate-950/80 p-1 rounded border border-white/5 font-mono text-emerald-300">
                                {ans.chiTitles.map((ct, cIdx) => (
                                  <div key={cIdx} className="truncate">{ct}</div>
                                ))}
                              </div>
                            ) : ans.subTitle ? (
                              <div className="text-[9px] text-slate-300 font-mono mt-0.5 truncate max-w-full px-1">
                                {ans.subTitle}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-[10px] text-slate-500 italic py-1">Chưa có bài</span>
                        )}
                      </div>

                      {/* Điểm số */}
                      <span className={`text-[10px] px-2 py-0.5 rounded-md font-black w-full text-center ${ans.highlightClass || 'bg-slate-800 text-slate-400'}`}>
                        {ans.label || 'Chờ bài'}
                      </span>

                      {/* Xếp hạng */}
                      {ans.rank && (
                        <div className="mt-1 w-full flex justify-center">
                          {isAllDoorsComplete ? (
                            <span
                              className={`text-[9px] px-1.5 py-0.2 rounded-full font-black ${
                                ans.rank === 1
                                  ? 'bg-amber-500 text-slate-950 ring-1 ring-amber-300 shadow shadow-amber-500/40'
                                  : ans.rank === 2
                                  ? 'bg-slate-300 text-slate-950 font-bold'
                                  : ans.rank === 3
                                  ? 'bg-amber-800 text-amber-100 font-bold'
                                  : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              {ans.rank === 1 ? '👑 Hạng 1' : ans.rank === 2 ? '🥈 Hạng 2' : ans.rank === 3 ? '🥉 Hạng 3' : `#${ans.rank}`}
                            </span>
                          ) : (
                            <span className="text-[9px] px-1.5 py-0.2 rounded-full font-bold bg-slate-800 text-amber-300 border border-amber-500/30">
                              Tạm #{ans.rank}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {groupAnswersResult.leaderboardText && (
                <div className="text-[11px] font-mono text-emerald-400/90 bg-emerald-950/30 px-2 py-1 rounded border border-emerald-900/40">
                  {groupAnswersResult.leaderboardText}
                </div>
              )}
            </div>

            {/* Các nút thao tác ván */}
            <div className="flex items-center justify-between pt-1 border-t border-slate-800/80">
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleNewRound}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center space-x-1 shadow-md shadow-emerald-600/30"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Ván Mới</span>
                </button>
                <button
                  onClick={handleUndo}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs flex items-center space-x-1"
                >
                  <Undo2 className="w-3.5 h-3.5 text-amber-400" />
                  <span>Hoàn Tác</span>
                </button>
                <button
                  onClick={() => {
                    doorCardsRef.current = {};
                    communityCardsRef.current = [];
                    setDoorCards({});
                    setCommunityCards([]);
                    setCapturedFrame(null);
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-red-900/60 text-slate-200 hover:text-red-300 font-bold text-xs flex items-center space-x-1"
                >
                  <Trash2 className="w-3.5 h-3.5 text-red-400" />
                  <span>Xóa Ván</span>
                </button>
              </div>

              {nextTarget && (
                <div className="text-xs text-slate-300 font-medium flex items-center space-x-1">
                  <span className="text-slate-400">Lá tiếp theo:</span>
                  <span className="font-bold text-emerald-400 bg-emerald-950/80 px-2 py-0.5 rounded border border-emerald-800">
                    {nextTarget.isCommunity
                      ? `Bài Chung (Lá ${nextTarget.slot + 1})`
                      : `Cửa ${nextTarget.door} (Lá ${nextTarget.slot + 1})`}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* MỤC 2: BẢNG LỊCH SỬ KẾT QUẢ CÁC VÁN */}
          <div className="flex-1 bg-slate-900/90 border border-slate-700/80 rounded-xl p-2.5 flex flex-col justify-between shadow-lg">
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
                <span>
                  {nextTarget.isCommunity
                    ? `Bài Chung (Lá ${nextTarget.slot + 1})`
                    : `Cửa ${nextTarget.door} (Lá ${nextTarget.slot + 1})`}
                </span>
              </span>
            ) : (
              <span className="font-bold text-amber-400">Đã đủ bài tất cả cửa!</span>
            )}
          </div>
        </div>

        </div>
      </div>

      {/* KHAY SOI FRAME BÀI NÉT NHẤT (1080p @ 120fps Frame Inspector) - HỖ TRỢ LỌC THEO CỬA */}
      <div className="bg-slate-900/90 border border-slate-700/80 rounded-xl p-3 shadow-xl backdrop-blur">
        <div className="flex flex-wrap items-center justify-between pb-2 mb-2 border-b border-slate-800 text-xs gap-2">
          <span className="font-bold text-slate-200 flex items-center space-x-1.5">
            <Crosshair className="w-4 h-4 text-emerald-400" />
            <span>Khay Soi Frame Quân Bài Nét Nhất (1080p @ 120fps Native Frame)</span>
          </span>
          <span className="text-[10px] text-slate-400 font-mono">
            {capturedHistory.length > 0 ? `Đã lưu ${capturedHistory.length} frame gần nhất` : 'Đang chờ phát hiện bài...'}
          </span>
        </div>

        {/* Thanh lọc xem bài theo Cửa */}
        <div className="flex flex-wrap items-center gap-1.5 pb-2.5 mb-2.5 border-b border-slate-800 text-xs">
          <span className="text-slate-400 font-medium mr-1 flex items-center space-x-1">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <span>Xem ảnh theo Cửa:</span>
          </span>
          <button
            onClick={() => setSelectedDoorFilter('all')}
            className={`px-2.5 py-1 rounded text-xs font-bold transition ${
              selectedDoorFilter === 'all'
                ? 'bg-emerald-600 text-white shadow'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            Tất cả ({doorCardImages.length})
          </button>
          {Array.from({ length: playerCount }, (_, i) => i + 1).map((d) => {
            const count = (doorCards[d] || []).length;
            return (
              <button
                key={d}
                onClick={() => setSelectedDoorFilter(d)}
                className={`px-2.5 py-1 rounded text-xs font-bold transition flex items-center space-x-1 ${
                  selectedDoorFilter === d
                    ? 'bg-amber-500 text-slate-950 font-black shadow'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                <span>Cửa {d}</span>
                {count > 0 && (
                  <span
                    className={`text-[10px] px-1 py-0.2 rounded font-mono ${
                      selectedDoorFilter === d ? 'bg-slate-900 text-amber-300' : 'bg-slate-700 text-slate-300'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Nội dung Khay Soi khi lọc theo 1 Cửa cụ thể */}
        {selectedDoorFilter !== 'all' ? (
          <div>
            <div className="text-xs font-bold text-amber-400 mb-2 flex items-center space-x-1.5">
              <span>Hình ảnh 1080p các lá bài thuộc Cửa {selectedDoorFilter}:</span>
            </div>
            {doorCardImages.length === 0 ? (
              <div className="py-6 text-center text-slate-500 text-xs italic">
                Cửa {selectedDoorFilter} chưa được chia lá bài nào.
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {doorCardImages.map(({ doorNum, slotIdx, item }, idx) => {
                  const cardInfo = formatCardItem(item.code);
                  return (
                    <div
                      key={idx}
                      className="bg-slate-950 p-2 rounded-xl border border-amber-500/50 shadow-md flex flex-col space-y-1.5"
                    >
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-bold text-amber-300">Cửa {doorNum} • Lá {slotIdx + 1}</span>
                        <span className="text-slate-400 font-mono text-[10px]">{item.timestamp}</span>
                      </div>
                      <div
                        onClick={() => item.image && setZoomImage(item.image)}
                        className="w-full h-32 bg-black rounded-lg overflow-hidden border border-slate-700 relative flex items-center justify-center cursor-pointer hover:border-amber-400 transition"
                        title="Bấm để phóng to ảnh 1080p gốc"
                      >
                        {item.image ? (
                          <img
                            src={item.image}
                            alt={item.code}
                            className="w-full h-full object-contain"
                            style={{ imageRendering: '-webkit-optimize-contrast' }}
                          />
                        ) : (
                          <div className="text-slate-500 text-xs italic">Không có ảnh</div>
                        )}
                        <div className="absolute top-1 left-1 bg-black/80 px-1.5 py-0.5 rounded text-xs font-black flex items-center space-x-0.5">
                          <span className={cardInfo.isRed ? 'text-red-400' : 'text-slate-100'}>{cardInfo.rank}</span>
                          <span className={cardInfo.isRed ? 'text-red-400' : 'text-slate-100'}>{cardInfo.symbol}</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[10px] font-mono">
                        <span className="text-white font-bold">{item.code}</span>
                        {item.sharpness ? (
                          <span className="bg-amber-950 text-amber-300 px-1 py-0.2 rounded border border-amber-800">
                            Nét: {item.sharpness}
                          </span>
                        ) : item.confidence ? (
                          <span className="bg-emerald-950 text-emerald-300 px-1 py-0.2 rounded border border-emerald-800">
                            {item.confidence}%
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          /* Khi chọn 'Tất cả': Hiển thị cả Frame nét nhất vừa bắt + Danh sách bài đã chia theo Cửa */
          <div className="flex flex-col space-y-3">
            {capturedFrame ? (
              <div className="flex flex-wrap items-center gap-3 pb-3 border-b border-slate-800/80">
                {/* Ảnh frame hiện tại to rõ nét nhất */}
                <div className="flex items-center space-x-3 bg-slate-950 p-2 rounded-xl border border-emerald-500/60 shadow-[0_0_20px_rgba(16,185,129,0.3)]">
                  <div
                    onClick={() => setZoomImage(capturedFrame.image)}
                    className="w-20 h-28 sm:w-24 sm:h-32 bg-black rounded-lg overflow-hidden border border-emerald-500/40 relative flex items-center justify-center cursor-pointer hover:border-emerald-400 transition"
                    title="Nhấp để xem ảnh 1080p gốc 1:1"
                  >
                    <img
                      src={capturedFrame.image}
                      alt={capturedFrame.cardName}
                      className="w-full h-full object-contain"
                      style={{ imageRendering: '-webkit-optimize-contrast' }}
                    />
                  </div>
                  <div className="flex flex-col justify-center space-y-1">
                    <span className="text-[10px] uppercase font-bold text-emerald-400 tracking-wider">⚡ Frame Nét Nhất Bắt Dính</span>
                    <span className="text-xl sm:text-2xl font-black text-white tracking-wide">{capturedFrame.cardName}</span>
                    <div className="flex items-center space-x-2 text-[11px] font-mono">
                      <span className="bg-emerald-950 text-emerald-300 px-2 py-0.5 rounded font-bold border border-emerald-800">
                        {capturedFrame.confidence}% Tin cậy
                      </span>
                      {capturedFrame.sharpness ? (
                        <span className="bg-amber-950/80 text-amber-300 px-2 py-0.5 rounded font-bold border border-amber-700/60">
                          Nét: {capturedFrame.sharpness}
                        </span>
                      ) : null}
                      <span className="text-slate-400">{capturedFrame.timestamp}</span>
                    </div>
                    <span className="text-[10px] text-emerald-400/90 font-mono">Chuẩn 1080p @ 120fps Native Pixel</span>
                  </div>
                </div>

                {/* Dải lịch sử các frame vừa bắt */}
                {capturedHistory.length > 1 && (
                  <div className="flex-1 min-w-[200px] flex items-center space-x-2 overflow-x-auto py-1">
                    <span className="text-[11px] text-slate-400 font-bold whitespace-nowrap mr-1">Vừa bắt:</span>
                    {capturedHistory.slice(1, 6).map((item, idx) => (
                      <div key={idx} className="flex flex-col items-center bg-slate-950/80 p-1.5 rounded-lg border border-slate-800 flex-shrink-0">
                        <div
                          onClick={() => setZoomImage(item.image)}
                          className="w-12 h-16 rounded overflow-hidden bg-black border border-slate-700 cursor-pointer hover:border-emerald-400 transition"
                        >
                          <img src={item.image} alt={item.cardName} className="w-full h-full object-contain" />
                        </div>
                        <span className="text-[10px] font-bold text-white mt-0.5">{item.cardName}</span>
                        <span className="text-[9px] text-slate-400 font-mono">{item.confidence}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {/* Dải ảnh bài của tất cả các Cửa */}
            <div>
              <div className="text-xs font-bold text-slate-300 mb-1.5 flex items-center justify-between">
                <span>Hình ảnh bài các Cửa ({doorCardImages.length} lá đã chia):</span>
              </div>
              {doorCardImages.length === 0 ? (
                <div className="py-4 text-center text-slate-500 text-xs italic">
                  Chưa có quân bài nào trong các cửa. Hãy đưa lá bài vào khung đỏ trên màn hình Live để AI chia bài vào cửa!
                </div>
              ) : (
                <div className="flex items-center space-x-2 overflow-x-auto py-1 no-scrollbar">
                  {doorCardImages.map(({ doorNum, slotIdx, item }, idx) => {
                    const cardInfo = formatCardItem(item.code);
                    return (
                      <div
                        key={idx}
                        className="flex flex-col items-center bg-slate-950 p-1.5 rounded-lg border border-slate-800 flex-shrink-0"
                      >
                        <span className="text-[9px] font-bold text-amber-400 mb-0.5">
                          C{doorNum}-L{slotIdx + 1}
                        </span>
                        <div
                          onClick={() => item.image && setZoomImage(item.image)}
                          className="w-14 h-20 rounded overflow-hidden bg-black border border-slate-700 cursor-pointer hover:border-amber-400 transition"
                          title="Bấm để phóng to"
                        >
                          {item.image ? (
                            <img src={item.image} alt={item.code} className="w-full h-full object-contain bg-slate-950" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-[10px] font-bold text-slate-400">
                              {item.code}
                            </div>
                          )}
                        </div>
                        <span className={`text-[10px] font-bold mt-0.5 ${cardInfo.isRed ? 'text-red-400' : 'text-slate-100'}`}>
                          {cardInfo.rank}{cardInfo.symbol}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 3. HÀNG DƯỚI: BÀN CƯỢC CÁC CỬA CHƠI KÈM HÌNH ẢNH QUÂN BÀI TRỰC QUAN */}
      <div className="bg-slate-900/90 border border-slate-700/80 rounded-xl p-3 shadow-xl backdrop-blur">
        <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-800 text-xs">
          <span className="font-bold text-slate-200 flex items-center space-x-1.5">
            <Layers className="w-4 h-4 text-amber-400" />
            <span>Bàn Cược {playerCount} Cửa Chơi ({cardsPerPlayer} lá/cửa)</span>
          </span>
          {isAllDoorsComplete && winnerDoor > 0 && (
            <span className="px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-bold border border-amber-500/40 flex items-center space-x-1 animate-pulse">
              <Award className="w-3.5 h-3.5 text-amber-400" />
              <span>Cửa {winnerDoor} Thắng Lớn!</span>
            </span>
          )}
        </div>

        {/* Lưới các Cửa (Grid N Columns) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 lg:grid-cols-8 gap-2.5 sm:gap-3">
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

                {/* CÁC Ô CHỨA LÁ BÀI KÈM HÌNH ẢNH 1080P THEO CỬA */}
                <div className="space-y-1.5">
                  {Array.from({ length: gameMode === 'phom9' && doorNum === 1 ? 10 : cardsPerPlayer }, (_, slotIdx) => {
                    const cardItem = cards[slotIdx];
                    const cardInfo = cardItem ? formatCardItem(cardItem.code) : null;
                    const isActiveSlot = !nextTarget?.isCommunity && nextTarget?.door === doorNum && nextTarget?.slot === slotIdx;

                    return (
                      <div
                        key={slotIdx}
                        onClick={() => {
                          setPickerTarget({
                            mode: cardItem ? 'edit' : 'add',
                            groupNum: doorNum,
                            slotIndex: slotIdx,
                            currentValue: cardItem?.code || ''
                          });
                          setPickerOpen(true);
                        }}
                        className={`h-16 sm:h-20 rounded-lg flex items-center justify-center cursor-pointer transition-all border-2 relative overflow-hidden group ${
                          isActiveSlot
                            ? 'border-emerald-400 bg-emerald-500/10 ring-2 ring-emerald-400 animate-pulse'
                            : cardInfo
                            ? 'border-yellow-400 bg-yellow-950/20 shadow-md shadow-yellow-500/10 hover:border-yellow-300'
                            : 'border-yellow-500/60 bg-slate-900/60 hover:border-yellow-400/80 border-dashed'
                        }`}
                        title={cardItem ? `Lá ${slotIdx + 1}: ${cardItem.code} (Nhấn để sửa)` : `Lá ${slotIdx + 1}: Chờ bài`}
                      >
                        {cardItem?.image ? (
                          <>
                            <img
                              src={cardItem.image}
                              alt={cardItem.code}
                              className="w-full h-full object-contain bg-slate-950/80 group-hover:scale-105 transition duration-200"
                              style={{ imageRendering: '-webkit-optimize-contrast' }}
                            />
                            {/* Huy hiệu Góc trái: Tên lá bài & chất */}
                            <div className="absolute top-1 left-1 bg-black/85 px-1.5 py-0.5 rounded text-[11px] font-black flex items-center space-x-0.5 border border-white/10 shadow">
                              <span className={cardInfo?.isRed ? 'text-red-400' : 'text-slate-100'}>{cardInfo?.rank}</span>
                              <span className={cardInfo?.isRed ? 'text-red-400' : 'text-slate-100'}>{cardInfo?.symbol}</span>
                            </div>
                            {/* Huy hiệu Góc phải: Độ nét / Conf */}
                            {cardItem.sharpness ? (
                              <div className="absolute bottom-1 right-1 bg-amber-950/90 text-amber-300 px-1 py-0.2 rounded text-[9px] font-mono border border-amber-600/50 shadow">
                                Nét: {cardItem.sharpness}
                              </div>
                            ) : cardItem.confidence ? (
                              <div className="absolute bottom-1 right-1 bg-emerald-950/90 text-emerald-300 px-1 py-0.2 rounded text-[9px] font-mono border border-emerald-600/50 shadow">
                                {cardItem.confidence}%
                              </div>
                            ) : null}
                          </>
                        ) : cardInfo ? (
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
                  {evalResult?.subText || `0/${cardsPerPlayer} lá`}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* POPUP XEM ẢNH TRÍCH XUẤT 1080P GỐC 1:1 KHÔNG BỊ NHÒE */}
      {zoomImage && (
        <div 
          className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4 backdrop-blur-sm cursor-pointer"
          onClick={() => setZoomImage(null)}
        >
          <div className="relative max-w-4xl max-h-[85vh] bg-slate-950 border-2 border-emerald-500 rounded-2xl overflow-hidden shadow-[0_0_50px_rgba(16,185,129,0.4)] p-2">
            <div className="flex items-center justify-between pb-2 px-2 text-xs font-bold text-emerald-400 border-b border-slate-800">
              <span>🎯 Ảnh Cắt Trong Khung Đỏ (1080p Native Pixel-Perfect)</span>
              <button 
                onClick={() => setZoomImage(null)}
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-white font-mono"
              >✕ Đóng</button>
            </div>
            <div className="p-2 flex items-center justify-center overflow-auto max-h-[75vh]">
              <img 
                src={zoomImage} 
                alt="Zoom Native" 
                className="max-w-full max-h-[70vh] object-contain rounded-lg border border-slate-800" 
                style={{ imageRendering: '-webkit-optimize-contrast' }}
              />
            </div>
          </div>
        </div>
      )}

      {/* POPUP CHỌN BÀI THỦ CÔNG (KHI CLICK VÀO Ô ĐỂ SỬA) */}
      <CardPickerPopup
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        target={pickerTarget}
        numGroups={playerCount}
        onSelectCard={(val, targetGroup) => {
          const newCardItem: Mode2CardItem = {
            code: val,
            timestamp: new Date().toLocaleTimeString('vi-VN')
          };
          if (targetGroup === 0) {
            setCommunityCards((prev) => {
              const current = [...prev];
              if (pickerTarget.mode === 'edit' && pickerTarget.slotIndex !== undefined) {
                current[pickerTarget.slotIndex] = {
                  ...(current[pickerTarget.slotIndex] || newCardItem),
                  code: val
                };
              } else if (current.length < 5) {
                current.push(newCardItem);
              }
              communityCardsRef.current = current;
              return current;
            });
          } else {
            setDoorCards((prev) => {
              const current = [...(prev[targetGroup] || [])];
              if (pickerTarget.mode === 'edit' && pickerTarget.slotIndex !== undefined) {
                current[pickerTarget.slotIndex] = {
                  ...(current[pickerTarget.slotIndex] || newCardItem),
                  code: val
                };
              } else {
                current.push(newCardItem);
              }
              const nextMap = { ...prev, [targetGroup]: current };
              doorCardsRef.current = nextMap;
              return nextMap;
            });
          }
          setPickerOpen(false);
        }}
      />
    </div>
  );
};
