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

const SUITS = [
  { name: 'Cơ', symbol: '♥', color: 'text-red-500', bg: 'bg-red-500/10 border-red-500/30 hover:bg-red-500/20' },
  { name: 'Rô', symbol: '♦', color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/30 hover:bg-orange-500/20' },
  { name: 'Chuồn', symbol: '♣', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20' },
  { name: 'Bích', symbol: '♠', color: 'text-indigo-300', bg: 'bg-indigo-500/10 border-indigo-500/30 hover:bg-indigo-500/20' }
];

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

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
      return { x: 8, y: 50 };
    }
    // Góc trên bên phải màn hình
    return { x: Math.max(16, winW - 570), y: 70 };
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

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; startX: number; startY: number }>({
    mouseX: 0,
    mouseY: 0,
    startX: 0,
    startY: 0
  });

  // Lưu vị trí khi di chuyển
  useEffect(() => {
    try {
      localStorage.setItem('card_picker_position', JSON.stringify(position));
    } catch {}
  }, [position]);

  const handleResetPosition = () => {
    const def = getDefaultPosition();
    setPosition(def);
    try {
      localStorage.removeItem('card_picker_position');
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

  const popupContent = (
    <div
      style={{
        position: 'fixed',
        left: `${position.x}px`,
        top: `${position.y}px`,
        zIndex: 999999
      }}
      className="w-[96vw] sm:w-[540px] max-w-[560px] bg-slate-900/98 backdrop-blur-xl border-2 border-amber-400/70 rounded-2xl shadow-2xl shadow-black/90 overflow-hidden flex flex-col select-none animate-scaleIn ring-2 ring-indigo-500/50"
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
              {target.mode === 'edit' ? 'Đổi Lá Bài' : 'Bảng 52 Lá Bài'}
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

          {/* Bảng 52 Lá Bài: 4 hàng tương ứng 4 chất */}
          <div className="space-y-1.5 bg-slate-950/70 p-2 rounded-xl border border-white/10">
            {SUITS.map((suit) => (
              <div key={suit.name} className="space-y-0.5">
                <div className="flex items-center space-x-1 px-1">
                  <span className={`text-sm font-black ${suit.color}`}>{suit.symbol}</span>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    {suit.name} ({suit.symbol})
                  </span>
                </div>

                <div className="grid grid-cols-13 gap-1">
                  {RANKS.map((rank) => {
                    const fullCardCode = `${rank}${suit.symbol}`;
                    const isCurrent = target.mode === 'edit' && target.currentValue === fullCardCode;
                    return (
                      <button
                        key={fullCardCode}
                        type="button"
                        onClick={() => handleCardClick(fullCardCode)}
                        className={`h-9 sm:h-10 rounded-lg flex flex-col items-center justify-center font-black transition-all active:scale-90 border ${
                          suit.bg
                        } ${
                          isCurrent
                            ? 'ring-2 ring-amber-400 bg-amber-500/30 border-amber-400 shadow-md'
                            : 'shadow-sm'
                        }`}
                        title={`Chọn lá ${rank} ${suit.name}`}
                      >
                        <span className={`text-xs sm:text-sm leading-none ${suit.color}`}>
                          {rank}
                        </span>
                        <span className={`text-[10px] sm:text-xs leading-none ${suit.color}`}>
                          {suit.symbol}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Footer hướng dẫn */}
          <div className="flex items-center justify-between text-[10px] text-slate-500 px-1 pt-1 border-t border-white/5">
            <span>Kéo thanh tiêu đề để di chuyển vị trí tùy ý</span>
            <span className="text-amber-400 font-medium">1 Click = Gán bài ngay</span>
          </div>
        </div>
      )}
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(popupContent, document.body);
};
