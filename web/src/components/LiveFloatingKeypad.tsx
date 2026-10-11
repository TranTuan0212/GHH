import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Socket } from 'socket.io-client';
import { Delete, X, Move, RotateCcw, Check, Sparkles } from 'lucide-react';

interface LiveFloatingKeypadProps {
  isOpen: boolean;
  onClose: () => void;
  socket: Socket | null;
  currentRoomId: string;
  roomName?: string;
  container?: HTMLElement | null;
}

export const LiveFloatingKeypad: React.FC<LiveFloatingKeypadProps> = ({
  isOpen,
  onClose,
  socket,
  currentRoomId,
  roomName,
  container
}) => {
  const [pressedCards, setPressedCards] = useState<string[]>([]);
  const [position, setPosition] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = localStorage.getItem('live_keypad_pos');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          return parsed;
        }
      }
    } catch {}
    return { x: 24, y: 70 };
  });

  // Khi mở bảng, đảm bảo tọa độ không bị trôi ra ngoài màn hình
  useEffect(() => {
    if (isOpen) {
      setPosition(prev => {
        const maxX = Math.max(0, (window?.innerWidth || 1000) - 300);
        const maxY = Math.max(0, (window?.innerHeight || 800) - 300);
        if (prev.x > maxX || prev.y > maxY || prev.x < 0 || prev.y < 0) {
          return { x: 24, y: 70 };
        }
        return prev;
      });
    }
  }, [isOpen]);

  const [size, setSize] = useState<{ width: number; height: number }>(() => {
    try {
      const saved = localStorage.getItem('live_keypad_size');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
          return parsed;
        }
      }
    } catch {}
    return { width: 340, height: 490 };
  });

  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isResizing, setIsResizing] = useState(false);
  const [resizeStart, setResizeStart] = useState<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: 340, h: 490 });
  const displayScrollRef = useRef<HTMLDivElement>(null);

  // Auto scroll right when new card is pressed
  useEffect(() => {
    if (displayScrollRef.current) {
      displayScrollRef.current.scrollLeft = displayScrollRef.current.scrollWidth;
    }
  }, [pressedCards]);

  // Dragging logic
  const handleDragMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y
    });
  };

  const handleDragTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      setIsDragging(true);
      setDragOffset({
        x: e.touches[0].clientX - position.x,
        y: e.touches[0].clientY - position.y
      });
    }
  };

  // Resizing logic
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    setResizeStart({
      x: e.clientX,
      y: e.clientY,
      w: size.width,
      h: size.height
    });
  };

  const handleResizeTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    if (e.touches.length === 1) {
      setIsResizing(true);
      setResizeStart({
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        w: size.width,
        h: size.height
      });
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const maxX = Math.max(0, window.innerWidth - size.width);
        const maxY = Math.max(0, window.innerHeight - 100);
        const newX = Math.max(0, Math.min(e.clientX - dragOffset.x, maxX));
        const newY = Math.max(0, Math.min(e.clientY - dragOffset.y, maxY));
        const nextPos = { x: newX, y: newY };
        setPosition(nextPos);
        try { localStorage.setItem('live_keypad_pos', JSON.stringify(nextPos)); } catch {}
      } else if (isResizing) {
        const deltaX = e.clientX - resizeStart.x;
        const deltaY = e.clientY - resizeStart.y;
        const newW = Math.max(260, Math.min(resizeStart.w + deltaX, window.innerWidth - position.x));
        const newH = Math.max(380, Math.min(resizeStart.h + deltaY, window.innerHeight - position.y));
        const nextSize = { width: newW, height: newH };
        setSize(nextSize);
        try { localStorage.setItem('live_keypad_size', JSON.stringify(nextSize)); } catch {}
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      if (isDragging) {
        const t = e.touches[0];
        const maxX = Math.max(0, window.innerWidth - size.width);
        const maxY = Math.max(0, window.innerHeight - 100);
        const newX = Math.max(0, Math.min(t.clientX - dragOffset.x, maxX));
        const newY = Math.max(0, Math.min(t.clientY - dragOffset.y, maxY));
        const nextPos = { x: newX, y: newY };
        setPosition(nextPos);
        try { localStorage.setItem('live_keypad_pos', JSON.stringify(nextPos)); } catch {}
      } else if (isResizing) {
        const t = e.touches[0];
        const deltaX = t.clientX - resizeStart.x;
        const deltaY = t.clientY - resizeStart.y;
        const newW = Math.max(260, Math.min(resizeStart.w + deltaX, window.innerWidth - position.x));
        const newH = Math.max(380, Math.min(resizeStart.h + deltaY, window.innerHeight - position.y));
        const nextSize = { width: newW, height: newH };
        setSize(nextSize);
        try { localStorage.setItem('live_keypad_size', JSON.stringify(nextSize)); } catch {}
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setIsResizing(false);
    };

    if (isDragging || isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('touchmove', handleTouchMove, { passive: false });
      window.addEventListener('touchend', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleMouseUp);
    };
  }, [isDragging, isResizing, dragOffset, resizeStart, position, size]);

  // Press a number (0..13)
  const handleCardClick = (val: string) => {
    setPressedCards(prev => [...prev, val]);
    if (socket) {
      socket.emit('live_remote_card', {
        cardValue: val === '0' ? '__hidden__' : val,
        action: 'ADD',
        roomId: currentRoomId
      });
    }
  };

  // Delete last pressed card (Undo)
  const handleDeleteClick = () => {
    if (pressedCards.length === 0) return;
    setPressedCards(prev => prev.slice(0, -1));
    if (socket) {
      socket.emit('live_remote_card', {
        action: 'DELETE',
        roomId: currentRoomId
      });
    }
  };

  // Reset entire round
  const handleResetRound = () => {
    setPressedCards([]);
    if (socket) {
      socket.emit('live_remote_card', {
        action: 'CLEAR',
        roomId: currentRoomId
      });
    }
  };

  if (!isOpen) return null;

  const content = (
    <div
      style={{
        position: 'absolute',
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${size.width}px`,
        height: `${size.height}px`,
        zIndex: 99999999
      }}
      className="backdrop-blur-md bg-black/75 border border-white/30 rounded-2xl shadow-2xl flex flex-col select-none overflow-hidden transition-all duration-75"
    >
      {/* Header kéo di chuyển & Nút đóng/reset */}
      <div
        onMouseDown={handleDragMouseDown}
        onTouchStart={handleDragTouchStart}
        className="flex items-center justify-between px-3 py-2 bg-white/10 border-b border-white/15 cursor-move active:cursor-grabbing"
      >
        <div className="flex items-center space-x-2 text-white/90">
          <Move className="w-3.5 h-3.5 text-amber-300" />
          <span className="text-xs font-black tracking-wide uppercase text-slate-200">
            Bảng Nhập Live
          </span>
          {roomName && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300 font-mono font-bold" title="Tài khoản nhận số">
              {roomName}
            </span>
          )}
        </div>
        <div className="flex items-center space-x-1.5">
          <button
            type="button"
            onClick={handleResetRound}
            className="p-1 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-amber-300 border border-white/10 transition-colors"
            title="Làm mới ván bài (Xóa hết)"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg bg-slate-800/80 hover:bg-red-600 text-slate-300 hover:text-white border border-white/10 transition-colors"
            title="Đóng bảng nhập"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Container */}
      <div className="flex-1 p-2.5 flex flex-col gap-2 overflow-hidden">
        {/* 1. Màn hình hiển thị số: Các số được bọc trong từng ô hình vuông sắc nét */}
        <div
          ref={displayScrollRef}
          className="h-14 p-1.5 rounded-xl bg-black/50 border border-white/20 flex items-center gap-1.5 overflow-x-auto no-scrollbar shadow-inner flex-shrink-0"
        >
          {pressedCards.length === 0 ? (
            <span className="text-slate-400 text-xs sm:text-sm font-medium px-2 italic select-none">
              Chưa bấm số nào
            </span>
          ) : (
            pressedCards.map((card, idx) => (
              <div
                key={idx}
                className="w-10 h-10 flex-shrink-0 rounded-lg bg-slate-800/90 border border-white/30 text-white font-black text-base flex items-center justify-center shadow-md animate-fadeIn"
              >
                {card}
              </div>
            ))
          )}
        </div>

        {/* 2. Hàng trên: Nút 0 (Xanh) và Nút Xóa (Đỏ) */}
        <div className="grid grid-cols-2 gap-2 flex-shrink-0">
          {/* Nút 0 */}
          <button
            type="button"
            onClick={() => handleCardClick('0')}
            className="h-12 rounded-xl bg-blue-900/70 hover:bg-blue-800/90 active:scale-95 border border-blue-400/60 text-blue-200 hover:text-white font-black text-xl flex items-center justify-center shadow-lg transition-all cursor-pointer"
            title="Bấm số 0 (Lá bài ẩn)"
          >
            0
          </button>

          {/* Nút Xóa */}
          <button
            type="button"
            onClick={handleDeleteClick}
            className="h-12 rounded-xl bg-red-950/70 hover:bg-red-900/90 active:scale-95 border border-red-500/60 text-red-200 hover:text-white font-bold text-sm sm:text-base flex items-center justify-center space-x-1.5 shadow-lg transition-all cursor-pointer"
            title="Xóa lùi 1 số vừa nhập"
          >
            <Delete className="w-5 h-5 text-red-300" />
            <span>Xóa</span>
          </button>
        </div>

        {/* 3. Lưới 4 cột: 1 -> 12 */}
        <div className="grid grid-cols-4 gap-2 flex-1 min-h-0">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((num) => (
            <button
              key={num}
              type="button"
              onClick={() => handleCardClick(String(num))}
              className="rounded-xl bg-slate-900/80 hover:bg-slate-800/95 active:scale-95 border border-white/25 hover:border-amber-400 text-white font-bold text-lg sm:text-xl flex items-center justify-center shadow-md transition-all cursor-pointer"
              title={`Bấm số ${num}`}
            >
              {num}
            </button>
          ))}
        </div>

        {/* 4. Hàng cuối: Nút 13 to bản trải rộng */}
        <button
          type="button"
          onClick={() => handleCardClick('13')}
          className="h-12 rounded-xl bg-slate-900/80 hover:bg-slate-800/95 active:scale-95 border border-white/25 hover:border-amber-400 text-white font-bold text-xl flex items-center justify-center shadow-md transition-all cursor-pointer flex-shrink-0"
          title="Bấm số 13"
        >
          13
        </button>
      </div>

      {/* Resize Handle ở góc dưới bên phải */}
      <div
        onMouseDown={handleResizeMouseDown}
        onTouchStart={handleResizeTouchStart}
        className="absolute bottom-1 right-1 w-5 h-5 flex items-center justify-center cursor-se-resize text-slate-400 hover:text-amber-400 transition-colors"
        title="Kéo góc để phóng to/thu nhỏ kích thước bảng phím"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <path d="M10 0L10 10L0 10Z" opacity="0.5" />
          <circle cx="8.5" cy="8.5" r="1.2" />
          <circle cx="5.5" cy="8.5" r="1.2" />
          <circle cx="8.5" cy="5.5" r="1.2" />
        </svg>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  const target = container || (document.fullscreenElement as HTMLElement) || document.body;
  return createPortal(content, target);
};
