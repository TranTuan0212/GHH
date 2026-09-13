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
  Sparkles,
  RotateCcw
} from 'lucide-react';
import { DataEntry } from '../types';
import { GameMode, computeAllGroupAnswers } from './DataGroupingUI';

export interface CardPickerTarget {
  mode: 'add' | 'edit';
  groupNum: number;
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
  onSelectCard: (cardValue: string, targetGroup: number, editCardId?: string) => void;
  onDeleteCard?: (cardId: string) => void;
  onChangeTargetGroup?: (groupNum: number) => void;
  onFinishRound?: () => void;
  onSetTarget?: (target: CardPickerTarget) => void;
  onChangeGameMode?: (mode: GameMode) => void;
  onChangeNumGroups?: (num: number) => void;
  onClearCards?: () => void;
}

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

  // Tính toán toạ độ an toàn trong viewport
  const getDefaultPosition = () => {
    if (typeof window === 'undefined') return { x: 20, y: 70 };
    const winW = window.innerWidth;
    if (winW < 640) {
      return { x: 4, y: 50 };
    }
    return { x: Math.max(16, winW - 620), y: 70 };
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

  // Kích thước popup có thể kéo dãn
  const getDefaultWidth = () => {
    if (typeof window === 'undefined') return 600;
    return window.innerWidth < 640 ? Math.min(window.innerWidth - 8, 600) : 600;
  };

  const [popupWidth, setPopupWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('card_picker_size');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.w === 'number' && parsed.w >= 420 && parsed.w <= 1000) return parsed.w;
      }
    } catch {}
    return getDefaultWidth();
  });

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; startX: number; startY: number }>({
    mouseX: 0,
    mouseY: 0,
    startX: 0,
    startY: 0
  });

  // Resize ref
  const isResizingRef = useRef(false);
  const resizeStartRef = useRef<{ mouseX: number; startW: number }>({ mouseX: 0, startW: 600 });

  // Lưu vị trí khi di chuyển
  useEffect(() => {
    try {
      localStorage.setItem('card_picker_position', JSON.stringify(position));
    } catch {}
  }, [position]);

  // Lưu kích thước khi resize
  useEffect(() => {
    try {
      localStorage.setItem('card_picker_size', JSON.stringify({ w: popupWidth }));
    } catch {}
  }, [popupWidth]);

  const handleResetPosition = () => {
    const def = getDefaultPosition();
    setPosition(def);
    setPopupWidth(getDefaultWidth());
    try {
      localStorage.removeItem('card_picker_position');
      localStorage.removeItem('card_picker_size');
    } catch {}
  };

  if (!isOpen) return null;

  const currentGroupName = groupNames[target.groupNum] || `Nhóm ${target.groupNum}`;

  // Bắt đầu kéo thả bằng chuột
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
      const newX = Math.max(10, Math.min(window.innerWidth - 300, dragStartRef.current.startX + deltaX));
      const newY = Math.max(10, Math.min(window.innerHeight - 100, dragStartRef.current.startY + deltaY));
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

  // Bắt đầu kéo thả bằng cảm ứng touch
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
      const newX = Math.max(10, Math.min(window.innerWidth - 300, dragStartRef.current.startX + deltaX));
      const newY = Math.max(10, Math.min(window.innerHeight - 100, dragStartRef.current.startY + deltaY));
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

  // Khi bấm chọn 1 lá bài từ bàn phím
  const handleCardClick = (cardVal: string) => {
    onSelectCard(cardVal, target.groupNum, target.cardId);
  };

  // Khi bấm chọn "0 Không thấy"
  const handleUnknownClick = () => {
    onSelectCard('0', target.groupNum, target.cardId);
  };

  // Kéo dãn kích thước popup (góc phải dưới)
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingRef.current = true;
    resizeStartRef.current = { mouseX: e.clientX, startW: popupWidth };

    const onMouseMove = (mv: MouseEvent) => {
      if (!isResizingRef.current) return;
      const delta = mv.clientX - resizeStartRef.current.mouseX;
      const newW = Math.max(420, Math.min(window.innerWidth - 16, resizeStartRef.current.startW + delta));
      setPopupWidth(newW);
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
    resizeStartRef.current = { mouseX: e.touches[0].clientX, startW: popupWidth };

    const onTouchMove = (tv: TouchEvent) => {
      if (!isResizingRef.current || !tv.touches[0]) return;
      const delta = tv.touches[0].clientX - resizeStartRef.current.mouseX;
      const newW = Math.max(420, Math.min(window.innerWidth - 16, resizeStartRef.current.startW + delta));
      setPopupWidth(newW);
    };
    const onTouchEnd = () => {
      isResizingRef.current = false;
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('touchend', onTouchEnd);
  };

  // Tính toán đáp án và thứ hạng của các nhóm trong phiên
  const { answers: groupAnswers, leaderboardText, completeGroupsCount } = computeAllGroupAnswers(
    entries,
    numGroups,
    gameMode,
    groupNames,
    danGroups
  );

  const popupContent = (
    <div
      style={{
        position: 'fixed',
        left: `${position.x}px`,
        top: `${position.y}px`,
        zIndex: 999999,
        width: `${popupWidth}px`,
        maxWidth: `calc(100vw - ${position.x + 8}px)`
      }}
      className="bg-slate-900/98 backdrop-blur-xl border-2 border-amber-400/70 rounded-2xl shadow-2xl shadow-black/90 overflow-hidden flex flex-col select-none animate-scaleIn ring-2 ring-indigo-500/50"
    >
      {/* 1. Header Bar: Cầm nắm kéo thả tự do */}
      <div
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        className="px-3 py-2 bg-gradient-to-r from-slate-950 via-slate-900 to-indigo-950 border-b border-amber-500/30 flex items-center justify-between cursor-move text-white"
        title="Giữ chuột để kéo thả vị trí bảng mã"
      >
        <div className="flex items-center space-x-2 min-w-0 pointer-events-none">
          <Move className="w-4 h-4 text-amber-400 flex-shrink-0 animate-bounce" />
          <div className="flex items-center space-x-1.5 truncate">
            <span className="text-xs font-black tracking-wide text-amber-300 uppercase">
              {target.mode === 'edit' ? 'Sửa Mã Số' : 'Bảng Số (1 ➔ 13 | 0: Không thấy)'}
            </span>
            <span className="text-slate-400 text-xs">•</span>
            <span className="text-xs font-bold text-white truncate">
              {currentGroupName} {target.slotIndex !== undefined ? `(Mục ${target.slotIndex + 1})` : ''}
            </span>
            {target.mode === 'edit' && target.currentValue && (
              <span className="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 text-[10px] font-mono font-bold border border-amber-500/40">
                Đang sửa: {target.currentValue}
              </span>
            )}
          </div>
        </div>

        {/* Nút Đặt lại vị trí, Thu nhỏ & Đóng */}
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
            title="Đóng bảng mã"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 2. Body: Khi không bị thu nhỏ */}
      {!isMinimized && (
        <div className="p-2.5 sm:p-3 space-y-2.5 max-h-[82vh] overflow-y-auto no-scrollbar">
          {/* BỘ CHỌN CHẾ ĐỘ (3 HOẶC 2) & SỐ NHÓM (2 - 8) NGAY TRONG POPUP */}
          <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-950/90 p-2 rounded-xl border border-white/10 shadow-inner">
            {/* Chọn Chế Độ: 3 hoặc 2 */}
            <div className="flex items-center space-x-1">
              <span className="text-[11px] font-bold text-slate-400 pl-1 pr-0.5">Chế độ:</span>
              <button
                type="button"
                onClick={() => onChangeGameMode && onChangeGameMode('3cards')}
                className={`px-2.5 py-1 rounded-lg text-xs font-black transition-all cursor-pointer ${
                  gameMode === '3cards'
                    ? 'bg-indigo-600 text-white shadow-sm border border-indigo-400 ring-1 ring-indigo-400'
                    : 'bg-slate-800/90 text-slate-400 hover:text-white hover:bg-slate-750'
                }`}
                title="Chế độ 3 Lá (M3)"
              >
                3 Lá
              </button>
              <button
                type="button"
                onClick={() => onChangeGameMode && onChangeGameMode('2cards')}
                className={`px-2.5 py-1 rounded-lg text-xs font-black transition-all cursor-pointer ${
                  gameMode === '2cards'
                    ? 'bg-amber-500 text-slate-950 shadow-sm border border-amber-300 ring-1 ring-amber-400'
                    : 'bg-slate-800/90 text-slate-400 hover:text-white hover:bg-slate-750'
                }`}
                title="Chế độ 2 Lá (M2)"
              >
                2 Lá
              </button>
            </div>

            {/* Chọn Số Nhóm: 2, 3, 4, 5, 6, 7, 8 */}
            <div className="flex items-center space-x-1">
              <span className="text-[11px] font-bold text-slate-400 pr-1">Số nhóm:</span>
              {[2, 3, 4, 5, 6, 7, 8].map((cnt) => (
                <button
                  key={cnt}
                  type="button"
                  onClick={() => onChangeNumGroups && onChangeNumGroups(cnt)}
                  className={`w-6 h-6 rounded-lg text-xs font-bold flex items-center justify-center transition-all cursor-pointer ${
                    numGroups === cnt
                      ? 'bg-indigo-600 text-white border border-indigo-400 shadow-sm font-black ring-1 ring-indigo-400'
                      : 'bg-slate-800/90 text-slate-400 hover:text-white hover:bg-slate-750'
                  }`}
                  title={`Chọn ${cnt} nhóm`}
                >
                  {cnt}
                </button>
              ))}
            </div>
          </div>

          {/* KẾT QUẢ SAU CÙNG (KHÔNG CẦN BẢNG ĐỐI CHIẾU, CHỈ CẦN KẾT QUẢ) */}
          <div className="bg-slate-950/90 p-2 sm:p-2.5 rounded-xl border border-amber-500/40 shadow-lg space-y-2 ring-1 ring-amber-500/20">
            <div className="flex items-center justify-between pb-1.5 border-b border-white/10 gap-1.5 flex-wrap">
              <div className="flex items-center space-x-1.5 min-w-0">
                <Award className="w-4 h-4 text-amber-400 flex-shrink-0" />
                <span className="text-[11px] sm:text-xs font-black text-amber-300 uppercase tracking-wide">
                  KẾT QUẢ PHIÊN NÀY ({gameMode === '3cards' ? '3 Lá' : '2 Lá'})
                </span>
              </div>

              <div className="flex items-center space-x-1.5 flex-shrink-0">
                {/* Nút Xóa Hết để điền lại */}
                {onClearCards && (
                  <button
                    type="button"
                    onClick={onClearCards}
                    className="px-2.5 py-1 rounded-lg bg-rose-600/30 hover:bg-rose-600 text-rose-200 hover:text-white font-bold text-[10px] sm:text-[11px] flex items-center space-x-1 border border-rose-500/40 shadow-sm transition-all active:scale-95 cursor-pointer"
                    title="Xóa toàn bộ các số đã nhập để điền lại từ đầu"
                  >
                    <RotateCcw className="w-3.5 h-3.5 text-rose-300" />
                    <span>Xóa Hết (Điền Lại)</span>
                  </button>
                )}

                {/* Nút Xong Phiên ngay trên Popup */}
                {onFinishRound && (
                  <button
                    type="button"
                    onClick={onFinishRound}
                    className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-black text-[10px] sm:text-[11px] flex items-center space-x-1 shadow-md shadow-emerald-600/30 transition-all active:scale-95 border border-emerald-400 cursor-pointer"
                    title="Xong phiên: Xóa sạch toàn bộ để bắt đầu phiên mới, không lưu lại gì"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Xong Phiên</span>
                  </button>
                )}
              </div>
            </div>

            {/* Grid hiển thị các nhóm: Tên nhóm, Danh sách số (BẤM ĐƯỢC ĐỂ SỬA TRỰC TIẾP), và Điểm/Đáp án */}
            <div className={`grid gap-1.5 ${numGroups <= 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3 sm:grid-cols-5'}`}>
              {groupAnswers.map((ans) => {
                const isSelectedGroup = target.groupNum === ans.groupNum && target.mode === 'add';
                return (
                  <div
                    key={ans.groupNum}
                    onClick={() => {
                      if (onSetTarget) {
                        onSetTarget({ mode: 'add', groupNum: ans.groupNum });
                      } else if (onChangeTargetGroup) {
                        onChangeTargetGroup(ans.groupNum);
                      }
                    }}
                    className={`p-1.5 rounded-xl border flex flex-col justify-between cursor-pointer transition-all ${
                      isSelectedGroup
                        ? 'bg-amber-950/60 border-amber-400 ring-2 ring-amber-400 shadow-lg shadow-amber-500/30'
                        : ans.isWinner
                        ? 'bg-amber-500/20 border-amber-400 shadow-md shadow-amber-500/20'
                        : 'bg-slate-900/90 border-white/10 hover:border-white/25'
                    }`}
                    title={`Bấm vào nhóm để gán thêm số cho ${ans.name}`}
                  >
                    {/* Header nhóm: Tên & Huy hiệu Thắng/Khóa/Đang điền */}
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <div className="flex items-center space-x-1 min-w-0">
                        <span className="text-[10px] sm:text-[11px] font-bold text-slate-200 truncate">
                          {ans.name}
                        </span>
                        {isSelectedGroup && (
                          <span className="px-1 py-0.2 rounded bg-amber-400 text-slate-950 font-black text-[8px] flex items-center shadow-sm animate-pulse">
                            🎯 Điền
                          </span>
                        )}
                      </div>
                      {ans.rankBadgeText ? (
                        <span className={`px-1 py-0.2 rounded font-black text-[9px] flex items-center gap-0.5 shadow-sm whitespace-nowrap ${ans.rankBadgeClass}`}>
                          {ans.rankBadgeText}
                        </span>
                      ) : ans.isStoodPat ? (
                        <span className="px-1 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-bold text-[9px] border border-emerald-500/30">
                          Khóa
                        </span>
                      ) : null}
                    </div>

                    {/* DANH SÁCH CÁC LÁ BÀI: BẤM TRỰC TIẾP VÀO SỐ ĐỂ SỬA */}
                    <div className="flex items-center space-x-1 overflow-x-auto no-scrollbar py-1 min-h-[28px]">
                      {ans.items.length === 0 ? (
                        <span className="text-[10px] text-slate-600 italic">Trống</span>
                      ) : (
                        ans.items.map((it, sIdx) => {
                          const isThisCardEditing = target.mode === 'edit' && target.cardId === it.id;
                          return (
                            <button
                              key={it.id || sIdx}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (onSetTarget) {
                                  onSetTarget({
                                    mode: 'edit',
                                    groupNum: ans.groupNum,
                                    cardId: it.id,
                                    currentValue: it.cardValue,
                                    slotIndex: sIdx
                                  });
                                }
                              }}
                              className={`px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-lg font-mono font-black text-xs sm:text-sm transition-all cursor-pointer border ${
                                isThisCardEditing
                                  ? 'bg-amber-400 text-slate-950 border-amber-300 ring-2 ring-amber-400 ring-offset-1 ring-offset-slate-900 scale-110 shadow-lg shadow-amber-400/50 animate-pulse z-10'
                                  : it.cardValue === '0'
                                  ? 'bg-amber-500/25 text-amber-300 border-amber-500/40 hover:border-amber-300 hover:scale-105'
                                  : 'bg-slate-800 text-white border-white/20 hover:border-amber-400 hover:text-amber-300 hover:scale-105'
                              }`}
                              title={`Bấm vào để chọn lại số này (Hiện tại: ${it.cardValue})`}
                            >
                              {it.cardValue}
                            </button>
                          );
                        })
                      )}
                    </div>

                    {/* Badge Đáp án / Điểm số sau cùng */}
                    <div className={`mt-1 py-0.5 px-1 rounded text-[10px] sm:text-[11px] font-mono font-bold text-center truncate border ${ans.highlightClass}`}>
                      {ans.label}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* KẾT QUẢ SAU CÙNG: Dòng thứ tự xếp hạng duy nhất */}
            {completeGroupsCount > 1 && leaderboardText && (
              <div className="mt-1 px-2.5 py-1.5 rounded-xl bg-indigo-950/70 border border-indigo-500/30 text-[11px] font-mono text-indigo-200 flex items-center space-x-2 overflow-x-auto no-scrollbar shadow-inner">
                <span className="font-black text-amber-300 whitespace-nowrap">👑 Kết Quả:</span>
                <span className="whitespace-nowrap font-bold text-white">{leaderboardText}</span>
              </div>
            )}
          </div>

          {/* Group Switcher Bar: Cho phép bấm đổi nhóm nhanh ngay trên popup */}
          <div className="flex items-center justify-between gap-1.5 bg-slate-950/80 p-1.5 rounded-xl border border-white/10">
            <span className="text-[11px] font-bold text-slate-400 whitespace-nowrap pl-1">
              Gán vào:
            </span>
            <div className="flex items-center space-x-1 overflow-x-auto no-scrollbar flex-1 justify-end">
              {Array.from({ length: numGroups }).map((_, idx) => {
                const gNum = idx + 1;
                const gName = groupNames[gNum] || `N${gNum}`;
                const isSelected = target.groupNum === gNum;
                return (
                  <button
                    key={gNum}
                    type="button"
                    onClick={() => {
                      if (onSetTarget) {
                        onSetTarget({ mode: 'add', groupNum: gNum });
                      } else if (onChangeTargetGroup) {
                        onChangeTargetGroup(gNum);
                      }
                    }}
                    className={`px-2 py-0.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-600 text-white shadow-sm border border-indigo-400 ring-1 ring-indigo-400'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
                    }`}
                  >
                    {gName}
                  </button>
                );
              })}
            </div>
          </div>

          {/* THÔNG BÁO TRẠNG THÁI: KHI ĐANG SỬA SỐ HAY ĐANG NHẬP THÊM */}
          {target.mode === 'edit' ? (
            <div className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-amber-500/20 border border-amber-400/60 text-amber-300 text-xs font-bold animate-fadeIn">
              <div className="flex items-center space-x-1.5 truncate">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping flex-shrink-0" />
                <span className="truncate">
                  Đang sửa số <strong>"{target.currentValue}"</strong> của <strong>{groupNames[target.groupNum] || `Nhóm ${target.groupNum}`}</strong> ➔ Bấm số bên dưới để đổi ngay
                </span>
              </div>
              <button
                type="button"
                onClick={() => onSetTarget?.({ mode: 'add', groupNum: target.groupNum })}
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-[11px] font-normal border border-white/10 flex-shrink-0 ml-2"
                title="Hủy sửa và chuyển về thêm số tiếp theo"
              >
                Hủy sửa
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between px-2.5 py-1 text-[11px] text-slate-400 bg-slate-950/40 rounded-xl border border-white/5">
              <span>Đang nhập cho: <strong className="text-white">{groupNames[target.groupNum] || `Nhóm ${target.groupNum}`}</strong></span>
              <span className="italic text-amber-400/80 font-medium">👉 Bấm vào số bất kỳ ở trên để chọn lại</span>
            </div>
          )}

          {/* Quick Action: Nút "0 • KHÔNG THẤY (N/A)" & Xóa mục */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {/* Nút KHÔNG RÕ MÃ to nổi bật */}
            <button
              type="button"
              onClick={handleUnknownClick}
              className="w-full py-2 px-3 rounded-xl bg-gradient-to-r from-amber-600 via-amber-500 to-yellow-500 hover:from-amber-500 hover:to-yellow-400 text-slate-950 font-black text-xs sm:text-sm flex items-center justify-center space-x-2 shadow-lg shadow-amber-500/30 transition-all active:scale-95 border border-amber-300 cursor-pointer"
              title="Gán trạng thái [0 • Không thấy / Bỏ qua] vào nhóm"
            >
              <EyeOff className="w-4 h-4 text-slate-950" />
              <span>⚠️ 0 • KHÔNG THẤY (N/A)</span>
            </button>

            {/* Nếu đang sửa: hiển thị nút Xóa mục này */}
            {target.mode === 'edit' && target.cardId && onDeleteCard ? (
              <button
                type="button"
                onClick={() => {
                  if (target.cardId) onDeleteCard(target.cardId);
                  onSetTarget?.({ mode: 'add', groupNum: target.groupNum });
                }}
                className="w-full py-2 px-3 rounded-xl bg-red-600/30 hover:bg-red-600 text-red-200 hover:text-white font-bold text-xs flex items-center justify-center space-x-1.5 border border-red-500/40 transition-all active:scale-95 cursor-pointer"
                title="Xóa bỏ mục này khỏi nhóm"
              >
                <Trash2 className="w-4 h-4" />
                <span>Xóa mục này</span>
              </button>
            ) : (
              <div className="hidden sm:flex items-center justify-center text-[11px] text-slate-400 italic px-2 bg-slate-950/40 rounded-xl border border-white/5">
                Bấm số 1-13 hoặc 0 bên dưới để gán ngay
              </div>
            )}
          </div>

          {/* Bảng Số từ 1 -> 13 và 0 không thấy: 7 cột x 2 hàng, khung to, rõ ràng, cực kỳ dễ nhìn và dễ bấm */}
          <div className="bg-slate-950/80 p-2 sm:p-2.5 rounded-xl border border-white/10 shadow-inner">
            <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
              {CARDS.map((card) => {
                const isCurrent = target.mode === 'edit' && target.currentValue === card.rank;
                return (
                  <button
                    key={card.rank}
                    type="button"
                    onClick={() => handleCardClick(card.rank)}
                    className={`h-14 sm:h-16 rounded-xl flex flex-col items-center justify-center font-black transition-all active:scale-95 border shadow-md relative group overflow-hidden cursor-pointer ${
                      card.bg
                    } ${card.border} ${
                      isCurrent
                        ? 'ring-2 ring-amber-400 border-amber-400 scale-105 z-10 shadow-amber-500/30'
                        : 'hover:scale-105 hover:border-amber-400/60'
                    }`}
                    title={card.rank === '0' ? 'Mã 0: Không thấy' : `Chọn số ${card.rank}`}
                  >
                    {/* Số to rõ ràng */}
                    <span className={`text-xl sm:text-2xl leading-none font-black tracking-tighter ${card.color} drop-shadow-md`}>
                      {card.rank}
                    </span>

                    {/* Sublabel nếu có (ví dụ 'Không thấy' cho số 0) */}
                    {card.sublabel && (
                      <span className="text-[9px] sm:text-[10px] text-orange-300 font-bold leading-none mt-1">
                        {card.sublabel}
                      </span>
                    )}

                    {/* Hiệu ứng ánh sáng khi hover */}
                    <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Footer + Resize handle */}
          <div className="relative flex items-center justify-between text-[10px] text-slate-500 px-1 pt-1 pb-4 border-t border-white/5">
            <span>Kéo header di chuyển · Kéo góc ↘ để thay đổi kích thước</span>
            <span className="text-amber-400 font-medium">1 Click = Gán ngay</span>
            {/* Resize handle ở góc dưới bên phải */}
            <div
              onMouseDown={handleResizeMouseDown}
              onTouchStart={handleResizeTouchStart}
              className="absolute bottom-1 right-1 w-5 h-5 flex items-center justify-center cursor-se-resize text-slate-500 hover:text-amber-400 transition-colors"
              title="Kéo để thay đổi kích thước popup"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                <path d="M10 0L10 10L0 10Z" opacity="0.5"/>
                <circle cx="8.5" cy="8.5" r="1.2"/>
                <circle cx="5.5" cy="8.5" r="1.2"/>
                <circle cx="8.5" cy="5.5" r="1.2"/>
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
