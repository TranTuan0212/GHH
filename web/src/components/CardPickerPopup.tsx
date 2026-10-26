import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Move,
  Minus,
  Maximize2,
  Crosshair,
  Award,
  CheckCircle2,
  EyeOff,
  Trash2,
  RotateCcw
} from 'lucide-react';
import { DataEntry } from '../types';
import { GameMode, computeAllGroupAnswers } from './DataGroupingUI';

export interface CardPickerTarget {
  mode: 'add' | 'edit';
  groupNum: number; // 0 = Bài Chung (Poker), 1..N = Tụ 1..N
  slotIndex?: number;
  cardId?: string;
  currentValue?: string;
  groupName?: string;
}

interface CardPickerPopupProps {
  isOpen: boolean;
  onClose: () => void;
  target: CardPickerTarget;
  numGroups: number;
  groupNames?: { [groupIndex: number]: string };
  entries?: DataEntry[];
  gameMode?: GameMode;
  danGroups?: { [groupIndex: number]: boolean };
  isRoundRobin?: boolean;
  onResetToRoundRobin?: () => void;
  onSelectCard: (cardValue: string, targetGroup: number, editCardId?: string) => void;
  onDeleteCard?: (cardId: string) => void;
  onChangeTargetGroup?: (groupNum: number) => void;
  onFinishRound?: () => void;
  onSetTarget?: (target: CardPickerTarget) => void;
  onChangeGameMode?: (mode: GameMode) => void;
  onChangeNumGroups?: (num: number) => void;
  onClearCards?: () => void;
}

// 13 Ranks chuẩn của Poker
const POKER_RANKS = [
  { num: 'A', label: 'A' },
  { num: '2', label: '2' },
  { num: '3', label: '3' },
  { num: '4', label: '4' },
  { num: '5', label: '5' },
  { num: '6', label: '6' },
  { num: '7', label: '7' },
  { num: '8', label: '8' },
  { num: '9', label: '9' },
  { num: '10', label: '10' },
  { num: 'J', label: 'J' },
  { num: 'Q', label: 'Q' },
  { num: 'K', label: 'K' },
];

// 4 Chất Poker chuẩn
const POKER_SUITS = [
  {
    key: 'hearts',
    symbol: '♥',
    name: 'CƠ',
    color: 'text-red-400',
    border: 'border-red-500/50 hover:border-red-300',
    bg: 'bg-gradient-to-b from-red-950/70 to-slate-900',
    hoverBg: 'hover:bg-red-800 hover:text-white',
    activeBg: 'bg-red-600 text-white shadow-red-500/50'
  },
  {
    key: 'diamonds',
    symbol: '♦',
    name: 'RÔ',
    color: 'text-rose-400',
    border: 'border-rose-500/50 hover:border-rose-300',
    bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900',
    hoverBg: 'hover:bg-rose-800 hover:text-white',
    activeBg: 'bg-rose-600 text-white shadow-rose-500/50'
  },
  {
    key: 'clubs',
    symbol: '♣',
    name: 'CHUỒN',
    color: 'text-emerald-400',
    border: 'border-emerald-500/50 hover:border-emerald-300',
    bg: 'bg-gradient-to-b from-emerald-950/70 to-slate-900',
    hoverBg: 'hover:bg-emerald-800 hover:text-white',
    activeBg: 'bg-emerald-600 text-white shadow-emerald-500/50'
  },
  {
    key: 'spades',
    symbol: '♠',
    name: 'BÍCH',
    color: 'text-sky-300',
    border: 'border-sky-500/50 hover:border-sky-300',
    bg: 'bg-gradient-to-b from-sky-950/70 to-slate-900',
    hoverBg: 'hover:bg-sky-800 hover:text-white',
    activeBg: 'bg-sky-600 text-white shadow-sky-500/50'
  }
];

// Dãy Rô cho chế độ 3 lá / 2 lá
const RO_CARDS = [
  { rank: '1♦', num: '1', label: '1♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
  { rank: '2♦', num: '2', label: '2♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
  { rank: '3♦', num: '3', label: '3♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
  { rank: '4♦', num: '4', label: '4♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
  { rank: '5♦', num: '5', label: '5♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
  { rank: '6♦', num: '6', label: '6♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
  { rank: '7♦', num: '7', label: '7♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
  { rank: '8♦', num: '8', label: '8♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
  { rank: '9♦', num: '9', label: '9♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
  { rank: '10♦', num: '10', label: '10♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
  { rank: '11♦', num: '11', label: '11♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
  { rank: '12♦', num: '12', label: '12♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
  { rank: '13♦', num: '13', label: '13♦', color: 'text-rose-400', border: 'border-rose-500/50 hover:border-rose-300', bg: 'bg-gradient-to-b from-rose-950/70 to-slate-900' },
];

// Dãy bài thường
const CARDS = [
  { rank: '1', label: '1', color: 'text-sky-300', border: 'border-sky-500/40 hover:border-sky-300', bg: 'bg-gradient-to-b from-sky-950/60 to-slate-900' },
  { rank: '2', label: '2', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '3', label: '3', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '4', label: '4', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '5', label: '5', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '6', label: '6', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '7', label: '7', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '8', label: '8', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '9', label: '9', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '10', label: '10', color: 'text-amber-300', border: 'border-amber-500/30 hover:border-amber-400', bg: 'bg-gradient-to-b from-amber-950/40 to-slate-900' },
  { rank: '11', label: '11', color: 'text-amber-300', border: 'border-amber-500/40 hover:border-amber-300', bg: 'bg-gradient-to-b from-amber-950/50 to-slate-900' },
  { rank: '12', label: '12', color: 'text-amber-300', border: 'border-amber-500/40 hover:border-amber-300', bg: 'bg-gradient-to-b from-amber-950/50 to-slate-900' },
  { rank: '13', label: '13', color: 'text-amber-300', border: 'border-amber-500/40 hover:border-amber-300', bg: 'bg-gradient-to-b from-amber-950/50 to-slate-900' },
  { rank: '0', label: '0', sublabel: 'Không thấy', color: 'text-orange-400', border: 'border-orange-500/40 hover:border-orange-300', bg: 'bg-gradient-to-b from-orange-950/60 to-slate-900' },
];

export const CardPickerPopup: React.FC<CardPickerPopupProps> = ({
  isOpen,
  onClose,
  target,
  numGroups,
  groupNames = {},
  entries = [],
  gameMode = '2cards',
  danGroups = {},
  isRoundRobin = true,
  onResetToRoundRobin,
  onSelectCard,
  onDeleteCard,
  onChangeTargetGroup,
  onFinishRound,
  onSetTarget,
  onChangeGameMode,
  onChangeNumGroups,
  onClearCards
}) => {
  const [isMinimized, setIsMinimized] = useState(false);

  // Theo dõi kích thước màn hình để tự động co giãn không bao giờ cuộn
  const [windowHeight, setWindowHeight] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerHeight : 900
  );
  const [windowWidth, setWindowWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1200
  );

  useEffect(() => {
    const handleResize = () => {
      setWindowHeight(window.innerHeight);
      setWindowWidth(window.innerWidth);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Tính chiều rộng mặc định: Poker dàn ngang cần ~800px, chế độ khác cần ~600px
  const getDefaultWidth = () => {
    if (typeof window === 'undefined') return 600;
    if (window.innerWidth < 640) return window.innerWidth - 8;
    return gameMode === 'poker' ? Math.min(window.innerWidth - 20, 820) : Math.min(window.innerWidth - 20, 600);
  };

  const getDefaultPosition = () => {
    if (typeof window === 'undefined') return { x: 20, y: 40 };
    const winW = window.innerWidth;
    const w = getDefaultWidth();
    return { x: Math.max(10, Math.floor((winW - w) / 2)), y: 40 };
  };

  const [position, setPosition] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = localStorage.getItem('card_picker_position');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
          const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
          if (parsed.x >= 0 && parsed.x < winW - 100 && parsed.y >= 0 && parsed.y < winH - 80) {
            return parsed;
          }
        }
      }
    } catch {}
    return getDefaultPosition();
  });

  const popupRef = useRef<HTMLDivElement>(null);

  const [popupWidth, setPopupWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('card_picker_size');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.w === 'number' && parsed.w >= 400 && parsed.w <= 2400) return parsed.w;
      }
    } catch {}
    return getDefaultWidth();
  });

  const [popupHeight, setPopupHeight] = useState<number | null>(() => {
    try {
      const saved = localStorage.getItem('card_picker_size');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.h === 'number' && parsed.h >= 250 && parsed.h <= 2000) return parsed.h;
      }
    } catch {}
    return null;
  });

  // Tự động mở rộng bề ngang khi chuyển sang Poker hoặc 3 Lá Xì để dàn 13 cột phím to rõ
  useEffect(() => {
    if ((gameMode === 'poker' || gameMode === '2cards') && popupWidth < 760 && windowWidth >= 800) {
      setPopupWidth(Math.min(windowWidth - 20, 840));
    }
  }, [gameMode, windowWidth]);

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; startX: number; startY: number }>({
    mouseX: 0,
    mouseY: 0,
    startX: 0,
    startY: 0
  });

  const isResizingRef = useRef(false);
  const resizeStartRef = useRef<{ mouseX: number; mouseY: number; startW: number; startH: number }>({
    mouseX: 0,
    mouseY: 0,
    startW: 600,
    startH: 450
  });

  useEffect(() => {
    try {
      localStorage.setItem('card_picker_position', JSON.stringify(position));
    } catch {}
  }, [position]);

  useEffect(() => {
    try {
      localStorage.setItem('card_picker_size', JSON.stringify({ w: popupWidth, h: popupHeight }));
    } catch {}
  }, [popupWidth, popupHeight]);

  const handleResetPosition = () => {
    const def = getDefaultPosition();
    setPosition(def);
    setPopupWidth(getDefaultWidth());
    setPopupHeight(null);
    try {
      localStorage.removeItem('card_picker_position');
      localStorage.removeItem('card_picker_size');
    } catch {}
  };

  if (!isOpen) return null;

  // Lấy danh sách Bài Chung (groupIndex = 0)
  const communityEntries = entries.filter((e) => Number(e.groupIndex) === 0);

  // Tên mục tiêu đang nhập: 0 = BÀI CHUNG, 1..N = Tụ 1..N
  const currentTargetName =
    target.groupNum === 0
      ? 'BÀI CHUNG (5 LÁ)'
      : groupNames[target.groupNum] || `Tụ ${target.groupNum}`;

  // Kéo thả chuột
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: position.x,
      startY: position.y
    };

    const onMouseMove = (mv: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const deltaX = mv.clientX - dragStartRef.current.mouseX;
      const deltaY = mv.clientY - dragStartRef.current.mouseY;
      const newX = Math.max(8, Math.min(window.innerWidth - 300, dragStartRef.current.startX + deltaX));
      const newY = Math.max(8, Math.min(window.innerHeight - 80, dragStartRef.current.startY + deltaY));
      setPosition({ x: newX, y: newY });
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Kéo thả cảm ứng Touch
  const handleTouchStart = (e: React.TouchEvent) => {
    if ((e.target as HTMLElement).closest('button') || !e.touches[0]) return;
    isDraggingRef.current = true;
    dragStartRef.current = {
      mouseX: e.touches[0].clientX,
      mouseY: e.touches[0].clientY,
      startX: position.x,
      startY: position.y
    };

    const onTouchMove = (tv: TouchEvent) => {
      if (!isDraggingRef.current || !tv.touches[0]) return;
      const deltaX = tv.touches[0].clientX - dragStartRef.current.mouseX;
      const deltaY = tv.touches[0].clientY - dragStartRef.current.mouseY;
      const newX = Math.max(8, Math.min(window.innerWidth - 300, dragStartRef.current.startX + deltaX));
      const newY = Math.max(8, Math.min(window.innerHeight - 80, dragStartRef.current.startY + deltaY));
      setPosition({ x: newX, y: newY });
    };

    const onTouchEnd = () => {
      isDraggingRef.current = false;
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };

    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('touchend', onTouchEnd);
  };

  // Bấm chọn lá bài
  const handleCardClick = (cardVal: string) => {
    onSelectCard(cardVal, target.groupNum, target.cardId);
  };

  // Bấm chọn 0
  const handleUnknownClick = () => {
    onSelectCard('0', target.groupNum, target.cardId);
  };

  // Kéo dãn kích thước popup (Cả chiều ngang và chiều cao tự do)
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingRef.current = true;
    const currentH = popupRef.current ? popupRef.current.offsetHeight : (popupHeight || 450);
    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startW: popupWidth,
      startH: currentH
    };

    const onMouseMove = (mv: MouseEvent) => {
      if (!isResizingRef.current) return;
      const deltaX = mv.clientX - resizeStartRef.current.mouseX;
      const deltaY = mv.clientY - resizeStartRef.current.mouseY;

      const maxW = Math.max(420, window.innerWidth - position.x - 10);
      const maxH = Math.max(250, window.innerHeight - position.y - 10);

      const newW = Math.max(420, Math.min(maxW, resizeStartRef.current.startW + deltaX));
      const newH = Math.max(250, Math.min(maxH, resizeStartRef.current.startH + deltaY));

      setPopupWidth(newW);
      setPopupHeight(newH);
    };
    const onMouseUp = () => {
      isResizingRef.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleResizeTouchStart = (e: React.TouchEvent) => {
    if (!e.touches[0]) return;
    e.stopPropagation();
    isResizingRef.current = true;
    const currentH = popupRef.current ? popupRef.current.offsetHeight : (popupHeight || 450);
    resizeStartRef.current = {
      mouseX: e.touches[0].clientX,
      mouseY: e.touches[0].clientY,
      startW: popupWidth,
      startH: currentH
    };

    const onTouchMove = (tv: TouchEvent) => {
      if (!isResizingRef.current || !tv.touches[0]) return;
      const deltaX = tv.touches[0].clientX - resizeStartRef.current.mouseX;
      const deltaY = tv.touches[0].clientY - resizeStartRef.current.mouseY;

      const maxW = Math.max(420, window.innerWidth - position.x - 10);
      const maxH = Math.max(250, window.innerHeight - position.y - 10);

      const newW = Math.max(420, Math.min(maxW, resizeStartRef.current.startW + deltaX));
      const newH = Math.max(250, Math.min(maxH, resizeStartRef.current.startH + deltaY));

      setPopupWidth(newW);
      setPopupHeight(newH);
    };
    const onTouchEnd = () => {
      isResizingRef.current = false;
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('touchend', onTouchEnd);
  };

  // Tính đáp án và bảng xếp hạng
  const { answers: groupAnswers, leaderboardText, completeGroupsCount } = computeAllGroupAnswers(
    entries,
    numGroups,
    gameMode,
    groupNames,
    danGroups
  );

  const getCardBadgeStyle = (cardVal: string) => {
    if (cardVal === '0' || cardVal.includes('Không thấy') || cardVal === '?') {
      return 'bg-red-950/90 text-red-300 border-red-500/70 shadow-sm animate-pulse';
    }
    if (cardVal.includes('♥')) {
      return 'bg-red-950/80 text-red-300 border-red-500/50 hover:border-red-300';
    }
    if (cardVal.includes('♦') || cardVal.toUpperCase().endsWith('R')) {
      return 'bg-rose-950/80 text-rose-300 border-rose-500/50 hover:border-rose-300';
    }
    if (cardVal.includes('♣')) {
      return 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50 hover:border-emerald-300';
    }
    if (cardVal.includes('♠')) {
      return 'bg-sky-950/80 text-sky-300 border-sky-500/50 hover:border-sky-300';
    }
    return 'bg-slate-800 text-white border-white/20 hover:border-amber-400';
  };

  const isTargetCommunity = target.groupNum === 0;

  const popupContent = (
    <div
      ref={popupRef}
      style={{
        position: 'fixed',
        left: `${position.x}px`,
        top: `${position.y}px`,
        zIndex: 999999,
        width: `${popupWidth}px`,
        height: popupHeight ? `${popupHeight}px` : undefined,
        maxWidth: `calc(100vw - ${Math.max(8, position.x + 8)}px)`,
        maxHeight: `calc(100vh - ${Math.max(8, position.y + 8)}px)`
      }}
      className="bg-slate-900/98 backdrop-blur-xl border-2 border-amber-400/70 rounded-2xl shadow-2xl shadow-black/90 overflow-hidden flex flex-col select-none animate-scaleIn ring-2 ring-indigo-500/50"
    >
      {/* 1. Header Bar: Kéo thả vị trí */}
      <div
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        className="px-3 py-1.5 bg-gradient-to-r from-slate-950 via-slate-900 to-indigo-950 border-b border-amber-500/30 flex items-center justify-between cursor-move text-white"
        title="Giữ chuột để kéo thả vị trí bảng nhập"
      >
        <div className="flex items-center space-x-2 min-w-0 pointer-events-none">
          <Move className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 animate-bounce" />
          <div className="flex items-center space-x-1.5 truncate">
            <span className="text-xs font-black tracking-wide text-amber-300 uppercase">
              {target.mode === 'edit'
                ? 'Sửa Lá Bài'
                : gameMode === 'poker'
                ? 'Bảng Poker (4 Chất ♥ ♦ ♣ ♠)'
                : gameMode === '2cards'
                ? 'Bảng 3 Lá Xì (4 Chất ♥ ♦ ♣ ♠)'
                : 'Bảng Số (1 ➔ 13 | 0: Không thấy)'}
            </span>
            <span className="text-slate-400 text-xs">•</span>
            <span className="text-xs font-black text-white truncate">
              {currentTargetName} {target.slotIndex !== undefined ? `(Mục ${target.slotIndex + 1})` : ''}
            </span>
            {target.mode === 'edit' && target.currentValue && (
              <span className="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 text-[10px] font-mono font-bold border border-amber-500/40">
                Đang sửa: {target.currentValue}
              </span>
            )}
          </div>
        </div>

        {/* Nút thao tác nhanh */}
        <div className="flex items-center space-x-1 flex-shrink-0">
          <button
            type="button"
            onClick={handleResetPosition}
            className="p-1 rounded-lg text-slate-400 hover:text-amber-300 hover:bg-slate-800 transition-colors"
            title="Đặt lại vị trí mặc định"
          >
            <Crosshair className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setIsMinimized(!isMinimized)}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            title={isMinimized ? 'Mở rộng' : 'Thu nhỏ'}
          >
            {isMinimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-800 transition-colors"
            title="Đóng bảng"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 2. Body: Toàn bộ dàn hàng ngang, tuyệt đối không cuộn */}
      {!isMinimized && (
        <div className="p-2 sm:p-2.5 space-y-1.5 flex flex-col overflow-y-auto no-scrollbar">
          {/* Thanh chuyển chế độ & số tụ */}
          <div className="flex flex-wrap items-center justify-between gap-1.5 bg-slate-950/90 p-1 rounded-xl border border-white/10 shadow-inner">
            <div className="flex items-center space-x-1">
              <span className="text-[10px] font-bold text-slate-400 pl-1 pr-0.5">Chế độ:</span>
              <button
                type="button"
                onClick={() => onChangeGameMode && onChangeGameMode('3cards')}
                className={`px-2 py-0.5 rounded-lg text-xs font-black transition-all cursor-pointer ${
                  gameMode === '3cards'
                    ? 'bg-indigo-600 text-white shadow-sm border border-indigo-400 ring-1 ring-indigo-400'
                    : 'bg-slate-800/90 text-slate-400 hover:text-white'
                }`}
              >
                3 Lá
              </button>
              <button
                type="button"
                onClick={() => onChangeGameMode && onChangeGameMode('2cards')}
                className={`px-2 py-0.5 rounded-lg text-xs font-black transition-all cursor-pointer flex items-center space-x-1 ${
                  gameMode === '2cards'
                    ? 'bg-amber-500 text-slate-950 shadow-sm border border-amber-300 font-black'
                    : 'bg-slate-800/90 text-slate-400 hover:text-white'
                }`}
              >
                <span>🃏</span>
                <span>3 Lá Xì (4 Chất)</span>
              </button>
              <button
                type="button"
                onClick={() => onChangeGameMode && onChangeGameMode('poker')}
                className={`px-2 py-0.5 rounded-lg text-xs font-black transition-all cursor-pointer flex items-center space-x-1 ${
                  gameMode === 'poker'
                    ? 'bg-gradient-to-r from-red-600 to-rose-700 text-white shadow-sm border border-rose-400 ring-1 ring-rose-400 font-black'
                    : 'bg-slate-800/90 text-slate-400 hover:text-white'
                }`}
              >
                <span>♠</span>
                <span>Poker (Hold'em)</span>
              </button>
            </div>

            <div className="flex items-center space-x-1">
              <span className="text-[10px] font-bold text-slate-400 pr-1">Số tụ:</span>
              {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((cnt) => (
                <button
                  key={cnt}
                  type="button"
                  onClick={() => onChangeNumGroups && onChangeNumGroups(cnt)}
                  className={`w-5 h-5 rounded-md text-[11px] font-bold flex items-center justify-center transition-all cursor-pointer ${
                    numGroups === cnt
                      ? 'bg-indigo-600 text-white border border-indigo-400 font-black ring-1 ring-indigo-400'
                      : 'bg-slate-800/90 text-slate-400 hover:text-white'
                  }`}
                >
                  {cnt}
                </button>
              ))}
            </div>
          </div>

          {/* =========================================================================
              KHU VỰC BÀI CHUNG (POKER) & KẾT QUẢ CÁC TỤ: DÀN NẰM NGANG
              ========================================================================= */}
          <div className="bg-slate-950/90 p-1.5 rounded-xl border border-amber-500/40 shadow-md space-y-1.5 ring-1 ring-amber-500/20">
            {/* Nếu đang ở chế độ Poker: Hiển thị Khung BÀI CHUNG 5 lá ngay hàng trên cùng */}
            {gameMode === 'poker' && (
              <div
                onClick={() => {
                  onSetTarget ? onSetTarget({ mode: 'add', groupNum: 0 }) : onChangeTargetGroup?.(0);
                }}
                className={`p-1.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-2 ${
                  isTargetCommunity
                    ? 'bg-amber-950/60 border-amber-400 ring-2 ring-amber-400 shadow-md shadow-amber-500/20'
                    : 'bg-slate-900/90 border-amber-500/30 hover:border-amber-400'
                }`}
              >
                <div className="flex items-center space-x-1.5 flex-shrink-0">
                  <span className="text-amber-400 text-xs font-black">👑</span>
                  <span className="text-[11px] font-black text-amber-300 uppercase whitespace-nowrap">
                    BÀI CHUNG:
                  </span>
                  {isTargetCommunity && (
                    <span className="px-1.5 py-0.2 rounded bg-amber-400 text-slate-950 font-black text-[8px] animate-pulse whitespace-nowrap">
                      🎯 ĐANG CHỌN
                    </span>
                  )}
                  <span className="text-[10px] font-mono font-bold text-amber-300 bg-amber-950/80 px-1 py-0.2 rounded border border-amber-500/30">
                    {communityEntries.length}/5 lá
                  </span>
                </div>

                {/* 5 Ô bài chung dàn ngang */}
                <div className="grid grid-cols-5 gap-1.5 flex-1 max-w-[460px]">
                  {[0, 1, 2, 3, 4].map((slotIdx) => {
                    const cardItem = communityEntries[slotIdx];
                    const slotLabel = slotIdx < 3 ? `Flop ${slotIdx + 1}` : slotIdx === 3 ? 'Turn' : 'River';
                    const isEditingThisCard = target.mode === 'edit' && target.cardId === cardItem?.id;
                    return (
                      <div
                        key={slotIdx}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (cardItem) {
                            onSetTarget?.({
                              mode: 'edit',
                              groupNum: 0,
                              cardId: cardItem.id,
                              currentValue: cardItem.cardValue,
                              slotIndex: slotIdx
                            });
                          } else {
                            onSetTarget ? onSetTarget({ mode: 'add', groupNum: 0 }) : onChangeTargetGroup?.(0);
                          }
                        }}
                        className={`h-7 sm:h-8 rounded-lg border flex items-center justify-center font-mono font-black text-xs transition-all cursor-pointer ${
                          isEditingThisCard
                            ? 'bg-amber-400 text-slate-950 border-amber-300 ring-2 ring-amber-400 scale-105 z-10 shadow-md'
                            : cardItem
                            ? getCardBadgeStyle(cardItem.cardValue) + ' hover:scale-105'
                            : 'border-dashed border-amber-500/40 bg-amber-950/30 text-amber-400/50 hover:border-amber-400'
                        }`}
                        title={cardItem ? `Sửa lá ${cardItem.cardValue}` : `Gán vào ${slotLabel}`}
                      >
                        {cardItem ? cardItem.cardValue : <span className="text-[9px] uppercase font-bold">{slotLabel}</span>}
                      </div>
                    );
                  })}
                </div>

                {/* Nút Xóa Hết & Xong Phiên */}
                <div className="flex items-center space-x-1 flex-shrink-0">
                  {onClearCards && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onClearCards();
                      }}
                      className="px-1.5 py-0.5 rounded bg-rose-600/30 hover:bg-rose-600 text-rose-200 hover:text-white font-bold text-[9px] flex items-center space-x-0.5 border border-rose-500/40 cursor-pointer"
                      title="Xóa toàn bộ bài để điền lại"
                    >
                      <RotateCcw className="w-2.5 h-2.5" />
                      <span>Xóa</span>
                    </button>
                  )}
                  {onFinishRound && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onFinishRound();
                      }}
                      className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-black text-[9px] flex items-center space-x-0.5 border border-emerald-400 cursor-pointer"
                      title="Xong phiên"
                    >
                      <CheckCircle2 className="w-2.5 h-2.5" />
                      <span>Xong</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Grid hiển thị các Tụ: Tụ 1, Tụ 2... */}
            <div className={`grid gap-1 ${numGroups <= 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3 sm:grid-cols-5'}`}>
              {groupAnswers.map((ans) => {
                const isSelectedGroup = target.groupNum === ans.groupNum && target.mode === 'add';
                return (
                  <div
                    key={ans.groupNum}
                    onClick={() => {
                      onSetTarget ? onSetTarget({ mode: 'add', groupNum: ans.groupNum }) : onChangeTargetGroup?.(ans.groupNum);
                    }}
                    className={`p-1 rounded-lg border flex flex-col justify-between cursor-pointer transition-all ${
                      isSelectedGroup
                        ? 'bg-amber-950/60 border-amber-400 ring-2 ring-amber-400 shadow-sm shadow-amber-500/30'
                        : ans.isComplete && ans.rankCardClass
                        ? ans.rankCardClass
                        : 'bg-slate-900/90 border-white/10 hover:border-white/25'
                    }`}
                  >
                    {/* Header tụ: Tên & Huy hiệu */}
                    <div className="flex items-center justify-between gap-1 mb-0.5">
                      <div className="flex items-center space-x-1 min-w-0">
                        <span className="text-[10px] font-bold text-slate-200 truncate">
                          {ans.name}
                        </span>
                        {isSelectedGroup && (
                          <span className="px-1 py-0.2 rounded bg-amber-400 text-slate-950 font-black text-[8px] animate-pulse">
                            🎯
                          </span>
                        )}
                      </div>
                      {gameMode !== '2cards' && ans.rankBadgeText ? (
                        <span className={`px-1 py-0.2 rounded font-black text-[8px] flex items-center gap-0.5 shadow-sm whitespace-nowrap ${ans.rankBadgeClass}`}>
                          {ans.rankBadgeText}
                        </span>
                      ) : null}
                    </div>

                    {/* Danh sách 2 lá bài tẩy của tụ */}
                    <div className="flex items-center space-x-1 py-0.5 min-h-[22px]">
                      {ans.items.length === 0 ? (
                        <span className="text-[9px] text-slate-600 italic">Trống</span>
                      ) : (
                        ans.items.map((it, sIdx) => {
                          const isThisCardEditing = target.mode === 'edit' && target.cardId === it.id;
                          return (
                            <button
                              key={it.id || sIdx}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onSetTarget?.({
                                  mode: 'edit',
                                  groupNum: ans.groupNum,
                                  cardId: it.id,
                                  currentValue: it.cardValue,
                                  slotIndex: sIdx
                                });
                              }}
                              className={`px-1.5 py-0.2 rounded font-mono font-black text-[11px] transition-all cursor-pointer border ${
                                isThisCardEditing
                                  ? 'bg-amber-400 text-slate-950 border-amber-300 ring-2 ring-amber-400 scale-110 shadow-md z-10'
                                  : getCardBadgeStyle(it.cardValue)
                              }`}
                            >
                              {it.cardValue}
                            </button>
                          );
                        })
                      )}
                    </div>

                    {/* Badge Điểm số sau cùng (Ẩn ở chế độ 3 Lá Xì) */}
                    {gameMode !== '2cards' && (
                      <div className={`mt-0.5 py-0.2 px-1 rounded text-[9px] font-mono font-bold text-center truncate border ${ans.highlightClass}`}>
                        {ans.label}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Dòng kết quả xếp hạng duy nhất (Ẩn ở 3 Lá Xì) */}
            {gameMode !== '2cards' && completeGroupsCount > 1 && leaderboardText && (
              <div className="mt-0.5 px-2 py-0.5 rounded-lg bg-indigo-950/70 border border-indigo-500/30 text-[10px] font-mono text-indigo-200 flex items-center space-x-2 overflow-x-auto no-scrollbar shadow-inner">
                <span className="font-black text-amber-300 whitespace-nowrap">👑 BXH:</span>
                <span className="whitespace-nowrap font-bold text-white">{leaderboardText}</span>
              </div>
            )}
          </div>

          {/* Thanh Gán Vào Nhanh (Group Switcher) */}
          <div className="flex items-center justify-between gap-1 bg-slate-950/80 p-1 rounded-xl border border-white/10">
            <span className="text-[10px] font-bold text-slate-400 whitespace-nowrap pl-1">
              Gán vào:
            </span>
            <div className="flex items-center space-x-1 overflow-x-auto no-scrollbar flex-1 justify-end">
              {/* Nút Chế độ Tự Động Chia Vòng theo chuẩn App */}
              <button
                type="button"
                onClick={() => {
                  if (onResetToRoundRobin) {
                    onResetToRoundRobin();
                  }
                }}
                className={`px-2 py-0.5 rounded-md text-[11px] font-black transition-all whitespace-nowrap cursor-pointer flex items-center space-x-1 ${
                  isRoundRobin
                    ? 'bg-emerald-600 text-white shadow-sm border border-emerald-400 ring-1 ring-emerald-400'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-white/10'
                }`}
                title="Bấm để quay về chế độ Tự Động Chia Vòng lần lượt như trên App"
              >
                <span>🔄 Chia Vòng</span>
              </button>

              {/* Nút Bài Chung nếu ở Poker */}
              {gameMode === 'poker' && (
                <button
                  type="button"
                  onClick={() => {
                    onSetTarget ? onSetTarget({ mode: 'add', groupNum: 0 }) : onChangeTargetGroup?.(0);
                  }}
                  className={`px-2 py-0.5 rounded-md text-[11px] font-black transition-all whitespace-nowrap cursor-pointer flex items-center space-x-1 ${
                    target.groupNum === 0
                      ? 'bg-amber-400 text-slate-950 shadow-md border border-amber-300 ring-2 ring-amber-400'
                      : 'bg-amber-950/70 text-amber-300 border border-amber-500/40 hover:bg-amber-900'
                  }`}
                >
                  <span>👑 Bài Chung</span>
                  <span className="text-[9px]">({communityEntries.length}/5)</span>
                </button>
              )}

              {/* Các Tụ 1 ➔ N */}
              {Array.from({ length: numGroups }).map((_, idx) => {
                const gNum = idx + 1;
                const gName = groupNames[gNum] || `Tụ ${gNum}`;
                const isSelected = target.groupNum === gNum;
                const itemsCount = (entries.filter((e) => Number(e.groupIndex) === gNum)).length;
                return (
                  <button
                    key={gNum}
                    type="button"
                    onClick={() => {
                      onSetTarget ? onSetTarget({ mode: 'add', groupNum: gNum }) : onChangeTargetGroup?.(gNum);
                    }}
                    className={`px-2 py-0.5 rounded-md text-[11px] font-bold transition-all whitespace-nowrap cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-600 text-white shadow-sm border border-indigo-400 ring-1 ring-indigo-400'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
                    }`}
                  >
                    {gName} ({itemsCount})
                  </button>
                );
              })}
            </div>
          </div>

          {/* Quick status & Nút 0 Không thấy */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 items-center">
            {target.mode === 'edit' ? (
              <div className="flex items-center justify-between px-2 py-0.5 rounded-lg bg-amber-500/20 border border-amber-400/60 text-amber-300 text-[11px] font-bold">
                <span className="truncate">
                  Đang sửa <strong>"{target.currentValue}"</strong> của <strong>{currentTargetName}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => onSetTarget?.({ mode: 'add', groupNum: target.groupNum })}
                  className="px-1.5 py-0.2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] border border-white/10 ml-1.5"
                >
                  Hủy
                </button>
              </div>
            ) : (
              <div className={`flex items-center justify-between px-2 py-0.5 text-[11px] rounded-lg border ${
                target.groupNum === 0
                  ? 'bg-amber-950/60 text-amber-300 border-amber-500/60 shadow-sm'
                  : 'text-slate-400 bg-slate-950/40 border-white/5'
              }`}>
                <div className="flex items-center space-x-1 truncate">
                  <span>Đang nhập: </span>
                  <strong className={target.groupNum === 0 ? 'text-amber-300 font-black' : 'text-white'}>
                    {target.groupNum === 0
                      ? `👑 BÀI CHUNG (Lá ${communityEntries.length + 1}/5)`
                      : `${currentTargetName} (Lá ${(entries.filter(e => Number(e.groupIndex) === target.groupNum)).length + 1}/${gameMode === 'poker' ? 2 : (gameMode === '3cards' ? 3 : 2)})`}
                  </strong>
                </div>
                <div className="flex items-center space-x-1 flex-shrink-0 ml-1">
                  {isRoundRobin && (
                    <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-bold text-[9px] border border-emerald-500/40 flex items-center space-x-0.5">
                      <span>🔄</span>
                      <span>Chia Vòng</span>
                    </span>
                  )}
                  <span className="text-amber-400/90 font-medium text-[10px]">1 Click = Gán</span>
                </div>
              </div>
            )}

            {/* Nút 0 • KHÔNG THẤY */}
            {target.mode === 'edit' && target.cardId && onDeleteCard ? (
              <button
                type="button"
                onClick={() => {
                  if (target.cardId) onDeleteCard(target.cardId);
                  onSetTarget?.({ mode: 'add', groupNum: target.groupNum });
                }}
                className="w-full py-0.5 px-2.5 rounded-lg bg-red-600/30 hover:bg-red-600 text-red-200 hover:text-white font-bold text-[11px] flex items-center justify-center space-x-1 border border-red-500/40 cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
                <span>Xóa mục này</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleUnknownClick}
                className="w-full py-0.5 px-2.5 rounded-lg bg-gradient-to-r from-red-700 to-amber-600 hover:from-red-600 hover:to-amber-500 text-white font-black text-[11px] flex items-center justify-center space-x-1 shadow-sm transition-all active:scale-95 border border-red-400 cursor-pointer"
                title="Gán trạng thái [0 • Không thấy]"
              >
                <EyeOff className="w-3 h-3 text-white" />
                <span>0 • KHÔNG THẤY (???)</span>
              </button>
            )}
          </div>

          {/* =========================================================================
              BÀN PHÍM POKER HÀNG NGANG: 4 CHẤT X 13 PHÍM A ➔ K TRẢI RỘNG KHÔNG CUỘN
              ========================================================================= */}
          {gameMode === 'poker' || gameMode === '2cards' ? (
            <div className="bg-slate-950/95 p-1 rounded-xl border border-red-500/40 shadow-inner space-y-0.5">
              {POKER_SUITS.map((suit) => (
                <div
                  key={suit.key}
                  className="flex items-center gap-1 bg-slate-900/70 px-1 py-0.5 rounded-lg border border-white/5"
                >
                  {/* Nhãn chất bên trái */}
                  <span
                    className={`w-12 sm:w-14 text-[10px] font-black ${suit.color} flex items-center gap-0.5 flex-shrink-0 select-none pl-0.5`}
                  >
                    <span className="text-xs">{suit.symbol}</span>
                    <span>{suit.name}</span>
                  </span>

                  {/* 13 Phím số A ➔ K trải ngang */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(13, minmax(0, 1fr))',
                      gap: '2px'
                    }}
                    className="flex-1"
                  >
                    {POKER_RANKS.map((r) => {
                      const cardVal = `${r.num}${suit.symbol}`;
                      const isCurrent = target.mode === 'edit' && target.currentValue === cardVal;
                      return (
                        <button
                          key={cardVal}
                          type="button"
                          onClick={() => handleCardClick(cardVal)}
                          className={`h-7 sm:h-7.5 rounded-md flex items-center justify-center font-black transition-all active:scale-95 border cursor-pointer ${
                            isCurrent
                              ? 'ring-2 ring-amber-400 border-amber-400 scale-105 z-10 bg-amber-500 text-slate-950 font-black'
                              : `${suit.bg} ${suit.border} ${suit.color} ${suit.hoverBg}`
                          }`}
                          title={`Chọn ${cardVal}`}
                        >
                          <span className="text-xs sm:text-[13px] leading-none font-bold">
                            {r.num}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* CHẾ ĐỘ 3 LÁ & 2 LÁ */
            <div className="space-y-1">
              {/* DÃY CHẤT RÔ ♦ */}
              <div className="bg-slate-950/90 p-1 rounded-xl border border-rose-500/40 shadow-inner space-y-0.5">
                <div className="flex items-center justify-between px-1">
                  <span className="text-[10px] font-black text-rose-400 flex items-center space-x-1">
                    <span className="text-xs">♦</span>
                    <span>DÃY CHẤT RÔ (ĐỎ) • CÙNG ĐIỂM LUÔN LỚN HƠN</span>
                  </span>
                  <span className="text-[9px] text-rose-300 font-mono font-bold bg-rose-950/80 px-1 py-0.2 rounded border border-rose-500/30">1♦ ➔ 13♦</span>
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {RO_CARDS.map((card) => {
                    const isCurrent = target.mode === 'edit' && target.currentValue === card.rank;
                    return (
                      <button
                        key={card.rank}
                        type="button"
                        onClick={() => handleCardClick(card.rank)}
                        className={`h-7 sm:h-8 rounded-lg flex items-center justify-center font-black transition-all active:scale-95 border shadow-sm cursor-pointer ${
                          card.bg
                        } ${card.border} ${
                          isCurrent
                            ? 'ring-2 ring-rose-400 border-rose-400 scale-105 z-10 shadow-rose-500/40'
                            : 'hover:scale-105 hover:border-rose-400'
                        }`}
                      >
                        <span className={`text-xs leading-none font-black ${card.color} flex items-center gap-0.5`}>
                          <span>{card.num}</span>
                          <span className="text-[10px] text-rose-500">♦</span>
                        </span>
                      </button>
                    );
                  })}
                  <div className="h-7 sm:h-8 rounded-lg border border-rose-500/30 bg-rose-950/40 flex flex-col items-center justify-center text-center p-0.5 select-none">
                    <span className="text-[9px] font-black text-rose-300 leading-tight">Ưu Tiên</span>
                    <span className="text-[8px] text-rose-400 font-bold leading-tight">Chất Rô ♦</span>
                  </div>
                </div>
              </div>

              {/* DÃY SỐ THƯỜNG */}
              <div className="bg-slate-950/80 p-1 rounded-xl border border-white/10 shadow-inner space-y-0.5">
                <div className="flex items-center justify-between px-1">
                  <span className="text-[10px] font-bold text-slate-300">
                    DÃY SỐ THƯỜNG (1 ➔ 13)
                  </span>
                  <span className="text-[9px] text-slate-400 font-mono">1 ➔ 13</span>
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {CARDS.map((card) => {
                    const isCurrent = target.mode === 'edit' && target.currentValue === card.rank;
                    return (
                      <button
                        key={card.rank}
                        type="button"
                        onClick={() => handleCardClick(card.rank)}
                        className={`h-7 sm:h-8 rounded-lg flex flex-col items-center justify-center font-black transition-all active:scale-95 border shadow-sm cursor-pointer ${
                          card.bg
                        } ${card.border} ${
                          isCurrent
                            ? 'ring-2 ring-amber-400 border-amber-400 scale-105 z-10 shadow-amber-500/30'
                            : 'hover:scale-105 hover:border-amber-400/60'
                        }`}
                      >
                        <span className={`text-xs leading-none font-black ${card.color}`}>
                          {card.rank}
                        </span>
                        {card.sublabel && (
                          <span className="text-[7px] text-orange-300 font-bold leading-none mt-0.5">
                            {card.sublabel}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Footer + Resize Handle */}
          <div className="relative flex items-center justify-between text-[9px] text-slate-500 px-1 pt-0.5 pb-1 border-t border-white/5">
            <span>Kéo header để di chuyển · Kéo góc ↘ đổi kích thước</span>
            <span className="text-amber-400/90 font-medium">Bố Cục Hàng Ngang Không Cuộn</span>
            <div
              onMouseDown={handleResizeMouseDown}
              onTouchStart={handleResizeTouchStart}
              className="absolute bottom-0 right-0 w-6 h-6 flex items-center justify-center cursor-se-resize text-amber-400/70 hover:text-amber-300 hover:scale-125 transition-all p-0.5 z-20"
              title="Kéo góc này để kéo dài và mở rộng kích thước bảng nhập"
            >
              <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor">
                <path d="M10 0L10 10L0 10Z" opacity="0.7" />
                <circle cx="8.5" cy="8.5" r="1.2" />
                <circle cx="5" cy="8.5" r="1.0" />
                <circle cx="8.5" cy="5" r="1.0" />
              </svg>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(popupContent, document.body);
};
