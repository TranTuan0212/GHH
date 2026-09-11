import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Move,
  Minus,
  Maximize2,
  HelpCircle,
  RotateCcw,
  Sparkles,
  Trash2,
  EyeOff,
  Crosshair
} from 'lucide-react';

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
  onSelectCard: (cardValue: string, targetGroup: number, editCardId?: string) => void;
  onDeleteCard?: (cardId: string) => void;
  onChangeTargetGroup?: (groupNum: number) => void;
}

const CARDS = [
  { rank: 'A', label: 'A', sub: 'Át', color: 'text-red-400', border: 'border-red-500/40 hover:border-red-400', bg: 'bg-gradient-to-b from-red-950/60 to-slate-900' },
  { rank: '2', label: '2', sub: '', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '3', label: '3', sub: '', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '4', label: '4', sub: '', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '5', label: '5', sub: '', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '6', label: '6', sub: '', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '7', label: '7', sub: '', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '8', label: '8', sub: '', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '9', label: '9', sub: '', color: 'text-slate-100', border: 'border-white/15 hover:border-white/40', bg: 'bg-gradient-to-b from-slate-800/80 to-slate-900' },
  { rank: '10', label: '10', sub: '', color: 'text-amber-300', border: 'border-amber-500/30 hover:border-amber-400', bg: 'bg-gradient-to-b from-amber-950/40 to-slate-900' },
  { rank: 'J', label: 'J', sub: 'Bồi', color: 'text-yellow-400', border: 'border-yellow-500/40 hover:border-yellow-300', bg: 'bg-gradient-to-b from-yellow-950/50 to-slate-900' },
  { rank: 'Q', label: 'Q', sub: 'Đầm', color: 'text-yellow-400', border: 'border-yellow-500/40 hover:border-yellow-300', bg: 'bg-gradient-to-b from-yellow-950/50 to-slate-900' },
  { rank: 'K', label: 'K', sub: 'Già', color: 'text-yellow-400', border: 'border-yellow-500/40 hover:border-yellow-300', bg: 'bg-gradient-to-b from-yellow-950/50 to-slate-900' },
];

export const CardPickerPopup: React.FC<CardPickerPopupProps> = ({
  isOpen,
  onClose,
  target,
  numGroups,
  groupNames = {},
  onSelectCard,
  onDeleteCard,
  onChangeTargetGroup
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
    // Chỉ kéo khi bấm vào header, không phải vào button
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

  // Khi bấm chọn 1 lá bài
  const handleCardClick = (cardVal: string) => {
    onSelectCard(cardVal, target.groupNum, target.cardId);
  };

  // Khi bấm chọn "Không thấy"
  const handleUnknownClick = () => {
    onSelectCard('Không thấy', target.groupNum, target.cardId);
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
        title="Giữ chuột để kéo thả vị trí bảng bài tùy thích"
      >
        <div className="flex items-center space-x-2 min-w-0 pointer-events-none">
          <Move className="w-4 h-4 text-amber-400 flex-shrink-0 animate-bounce" />
          <div className="flex items-center space-x-1.5 truncate">
            <span className="text-xs font-black tracking-wide text-amber-300 uppercase">
              {target.mode === 'edit' ? 'Đổi Lá Bài' : 'Bảng Chọn Bài (A ➔ K)'}
            </span>
            <span className="text-slate-400 text-xs">•</span>
            <span className="text-xs font-bold text-white truncate">
              {currentGroupName} {target.slotIndex !== undefined ? `(Lá ${target.slotIndex + 1})` : ''}
            </span>
            {target.mode === 'edit' && target.currentValue && (
              <span className="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 text-[10px] font-mono font-bold border border-amber-500/40">
                Cũ: {target.currentValue}
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
            title="Đóng bảng chọn bài"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 2. Body: Khi không bị thu nhỏ */}
      {!isMinimized && (
        <div className="p-2.5 sm:p-3 space-y-2.5 max-h-[82vh] overflow-y-auto no-scrollbar">
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
                    onClick={() => onChangeTargetGroup && onChangeTargetGroup(gNum)}
                    className={`px-2 py-0.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
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

          {/* Quick Action: Nút "KHÔNG THẤY" & Xóa lá */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {/* Nút KHÔNG THẤY to nổi bật */}
            <button
              type="button"
              onClick={handleUnknownClick}
              className="w-full py-2 px-3 rounded-xl bg-gradient-to-r from-amber-600 via-amber-500 to-yellow-500 hover:from-amber-500 hover:to-yellow-400 text-slate-950 font-black text-xs sm:text-sm flex items-center justify-center space-x-2 shadow-lg shadow-amber-500/30 transition-all active:scale-95 border border-amber-300"
              title="Gán trạng thái [Không thấy] vào nhóm khi camera bị che khuất hoặc không rõ lá bài"
            >
              <EyeOff className="w-4 h-4 text-slate-950" />
              <span>👁️‍🗨️ KHÔNG THẤY LÁ BÀI</span>
            </button>

            {/* Nếu đang sửa: hiển thị nút Xóa lá này */}
            {target.mode === 'edit' && target.cardId && onDeleteCard ? (
              <button
                type="button"
                onClick={() => {
                  if (target.cardId) onDeleteCard(target.cardId);
                  onClose();
                }}
                className="w-full py-2 px-3 rounded-xl bg-red-600/30 hover:bg-red-600 text-red-200 hover:text-white font-bold text-xs flex items-center justify-center space-x-1.5 border border-red-500/40 transition-all active:scale-95"
                title="Xóa bỏ lá bài này khỏi nhóm"
              >
                <Trash2 className="w-4 h-4" />
                <span>Xóa lá bài này</span>
              </button>
            ) : (
              <div className="hidden sm:flex items-center justify-center text-[11px] text-slate-400 italic px-2 bg-slate-950/40 rounded-xl border border-white/5">
                Bấm vào 1 lá bên dưới để gán ngay
              </div>
            )}
          </div>

          {/* Bảng Các Lá Bài Từ A -> K: Khung to, rõ ràng, cực kỳ dễ nhìn và dễ bấm */}
          <div className="bg-slate-950/80 p-2 sm:p-2.5 rounded-xl border border-white/10 shadow-inner">
            <div className="grid grid-cols-7 sm:grid-cols-13 gap-1.5 sm:gap-1">
              {CARDS.map((card) => {
                const isCurrent = target.mode === 'edit' && target.currentValue === card.rank;
                return (
                  <button
                    key={card.rank}
                    type="button"
                    onClick={() => handleCardClick(card.rank)}
                    className={`h-14 sm:h-16 rounded-xl flex flex-col items-center justify-center font-black transition-all active:scale-95 border shadow-md relative group overflow-hidden ${
                      card.bg
                    } ${card.border} ${
                      isCurrent
                        ? 'ring-2 ring-amber-400 border-amber-400 scale-105 z-10 shadow-amber-500/30'
                        : 'hover:scale-105 hover:border-amber-400/60'
                    }`}
                    title={`Chọn lá ${card.rank} ${card.sub ? `(${card.sub})` : ''}`}
                  >
                    {/* Chữ to rõ ràng */}
                    <span className={`text-xl sm:text-2xl leading-none font-black tracking-tighter ${card.color} drop-shadow-md`}>
                      {card.rank}
                    </span>

                    {/* Nhãn phụ nếu có (Át, Bồi, Đầm, Già) */}
                    {card.sub ? (
                      <span className="text-[9px] font-bold text-amber-400/80 leading-none mt-1">
                        {card.sub}
                      </span>
                    ) : (
                      <span className="text-[8px] text-slate-500 leading-none mt-1 font-mono">
                        •
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
