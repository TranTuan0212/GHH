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

  // Khi mở bảng, phục hồi chuẩn xác vị trí người dùng đã đặt từ localStorage
  useEffect(() => {
    if (isOpen) {
      try {
        const saved = localStorage.getItem('live_keypad_pos');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            const screenW = window?.innerWidth || 1000;
            const screenH = window?.innerHeight || 800;
            const safeX = Math.max(0, Math.min(parsed.x, screenW - 80));
            const safeY = Math.max(0, Math.min(parsed.y, screenH - 80));
            setPosition({ x: safeX, y: safeY });
            return;
          }
        }
      } catch {}
    }
  }, [isOpen]);

  const [size, setSize] = useState<{ width: number; height: number }>(() => {
    try {
      const saved = localStorage.getItem('live_keypad_size');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
          return {
            width: Math.max(220, Math.min(parsed.width, 420)),
            height: Math.max(220, Math.min(parsed.height, 360))
          };
        }
      }
    } catch {}
    return { width: 310, height: 295 };
  });

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ clientX: number; clientY: number; posX: number; posY: number } | null>(null);

  const isResizingRef = useRef(false);
  const resizeStartRef = useRef<{ clientX: number; clientY: number; w: number; h: number } | null>(null);

  const pinchStartRef = useRef<{ dist: number; w: number; h: number } | null>(null);
  const displayScrollRef = useRef<HTMLDivElement>(null);

  // Auto scroll right when new card is pressed
  useEffect(() => {
    if (displayScrollRef.current) {
      displayScrollRef.current.scrollLeft = displayScrollRef.current.scrollWidth;
    }
  }, [pressedCards]);

  // 1. CẢM ỨNG CHẠM TOUCH (Kéo 1 ngón & Pinch 2 ngón trực tiếp)
  const handleKeypadTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    if (e.touches.length === 2) {
      // 2 ngón tay: Kích hoạt Pinch Zoom
      isDraggingRef.current = false;
      isResizingRef.current = false;
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      pinchStartRef.current = {
        dist: Math.max(10, dist),
        w: size.width,
        h: size.height
      };
      return;
    }

    if (e.touches.length === 1) {
      const target = e.target as HTMLElement;
      // Bấm vào nút thì không kéo
      if (target.closest('button')) {
        return;
      }
      // Chạm góc kéo resize
      if (target.closest('[data-resize-handle="true"]')) {
        isResizingRef.current = true;
        resizeStartRef.current = {
          clientX: e.touches[0].clientX,
          clientY: e.touches[0].clientY,
          w: size.width,
          h: size.height
        };
        return;
      }
      // Chạm thanh tiêu đề hoặc nền để KÉO BẢNG ĐI
      isDraggingRef.current = true;
      dragStartRef.current = {
        clientX: e.touches[0].clientX,
        clientY: e.touches[0].clientY,
        posX: position.x,
        posY: position.y
      };
    }
  };

  const handleKeypadTouchMove = (e: React.TouchEvent) => {
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();

    // 2 ngón tay: Co giãn kích thước bảng
    if (e.touches.length === 2 && pinchStartRef.current) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const ratio = dist / pinchStartRef.current.dist;
      const maxW = Math.max(340, (window?.innerWidth || 1000) - 20);
      const maxH = Math.max(490, (window?.innerHeight || 800) - 30);
      const newW = Math.round(Math.max(220, Math.min(maxW, pinchStartRef.current.w * ratio)));
      const newH = Math.round(Math.max(220, Math.min(maxH, pinchStartRef.current.h * ratio)));
      const nextSize = { width: newW, height: newH };
      setSize(nextSize);
      try { localStorage.setItem('live_keypad_size', JSON.stringify(nextSize)); } catch {}
      return;
    }

    // 1 ngón tay: Kéo di chuyển bảng
    if (e.touches.length === 1) {
      const t = e.touches[0];
      if (isDraggingRef.current && dragStartRef.current) {
        const dx = t.clientX - dragStartRef.current.clientX;
        const dy = t.clientY - dragStartRef.current.clientY;
        const maxX = Math.max(0, (window?.innerWidth || 1000) - size.width);
        const maxY = Math.max(0, (window?.innerHeight || 800) - 80);
        const nextX = Math.round(Math.max(0, Math.min(dragStartRef.current.posX + dx, maxX)));
        const nextY = Math.round(Math.max(0, Math.min(dragStartRef.current.posY + dy, maxY)));
        setPosition({ x: nextX, y: nextY });
        try { localStorage.setItem('live_keypad_pos', JSON.stringify({ x: nextX, y: nextY })); } catch {}
        return;
      }

      // 1 ngón tay kéo góc resize
      if (isResizingRef.current && resizeStartRef.current) {
        const deltaX = t.clientX - resizeStartRef.current.clientX;
        const deltaY = t.clientY - resizeStartRef.current.clientY;
        const maxW = Math.max(340, (window?.innerWidth || 1000) - position.x);
        const maxH = Math.max(490, (window?.innerHeight || 800) - position.y);
        const newW = Math.round(Math.max(240, Math.min(maxW, resizeStartRef.current.w + deltaX)));
        const newH = Math.round(Math.max(360, Math.min(maxH, resizeStartRef.current.h + deltaY)));
        const nextSize = { width: newW, height: newH };
        setSize(nextSize);
        try { localStorage.setItem('live_keypad_size', JSON.stringify(nextSize)); } catch {}
      }
    }
  };

  const handleKeypadTouchEnd = (e: React.TouchEvent) => {
    e.stopPropagation();
    if (e.touches.length === 0) {
      isDraggingRef.current = false;
      isResizingRef.current = false;
      dragStartRef.current = null;
      resizeStartRef.current = null;
      pinchStartRef.current = null;
    }
  };

  // 2. CHUỘT MOUSE (kéo trên máy tính PC/Laptop)
  const handleDragMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      posX: position.x,
      posY: position.y
    };
  };

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingRef.current = true;
    resizeStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      w: size.width,
      h: size.height
    };
  };

  useEffect(() => {
    const handleWindowMouseMove = (e: MouseEvent) => {
      if (isDraggingRef.current && dragStartRef.current) {
        const dx = e.clientX - dragStartRef.current.clientX;
        const dy = e.clientY - dragStartRef.current.clientY;
        const maxX = Math.max(0, (window?.innerWidth || 1000) - size.width);
        const maxY = Math.max(0, (window?.innerHeight || 800) - 80);
        const nextX = Math.round(Math.max(0, Math.min(dragStartRef.current.posX + dx, maxX)));
        const nextY = Math.round(Math.max(0, Math.min(dragStartRef.current.posY + dy, maxY)));
        setPosition({ x: nextX, y: nextY });
        try { localStorage.setItem('live_keypad_pos', JSON.stringify({ x: nextX, y: nextY })); } catch {}
      } else if (isResizingRef.current && resizeStartRef.current) {
        const deltaX = e.clientX - resizeStartRef.current.clientX;
        const deltaY = e.clientY - resizeStartRef.current.clientY;
        const maxW = Math.max(340, (window?.innerWidth || 1000) - position.x);
        const maxH = Math.max(490, (window?.innerHeight || 800) - position.y);
        const newW = Math.round(Math.max(220, Math.min(maxW, resizeStartRef.current.w + deltaX)));
        const newH = Math.round(Math.max(220, Math.min(maxH, resizeStartRef.current.h + deltaY)));
        const nextSize = { width: newW, height: newH };
        setSize(nextSize);
        try { localStorage.setItem('live_keypad_size', JSON.stringify(nextSize)); } catch {}
      }
    };

    const handleWindowMouseUp = () => {
      isDraggingRef.current = false;
      isResizingRef.current = false;
      dragStartRef.current = null;
      resizeStartRef.current = null;
    };

    window.addEventListener('mousemove', handleWindowMouseMove, { capture: true });
    window.addEventListener('mouseup', handleWindowMouseUp, { capture: true });
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove, { capture: true });
      window.removeEventListener('mouseup', handleWindowMouseUp, { capture: true });
    };
  }, [position, size]);

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

  const handleContainerMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('[data-resize-handle="true"]')) {
      return;
    }
    handleDragMouseDown(e);
  };

  if (!isOpen) return null;

  const content = (
    <div
      data-live-keypad="true"
      onTouchStart={handleKeypadTouchStart}
      onTouchMove={handleKeypadTouchMove}
      onTouchEnd={handleKeypadTouchEnd}
      onMouseDown={handleContainerMouseDown}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${size.width}px`,
        height: `${size.height}px`,
        zIndex: 99999999,
        touchAction: 'none'
      }}
      className="backdrop-blur-md bg-black/80 border border-white/30 rounded-2xl shadow-2xl flex flex-col select-none overflow-hidden transition-all duration-75 cursor-move active:cursor-grabbing p-2 gap-1.5"
    >
      {/* 1. Màn hình hiển thị số + Tên user + Nút đóng (1 hàng duy nhất) */}
      <div className="flex items-center gap-1.5 flex-shrink-0 cursor-move">
        <div
          ref={displayScrollRef}
          className="flex-1 h-8 px-1.5 py-0.5 rounded-lg bg-black/60 border border-white/20 flex items-center gap-1 overflow-x-auto no-scrollbar shadow-inner"
        >
          {pressedCards.length === 0 ? (
            <span className="text-slate-400 text-[11px] font-medium px-1 italic select-none">
              Chưa bấm số nào
            </span>
          ) : (
            pressedCards.map((card, idx) => (
              <div
                key={idx}
                className="w-6.5 h-6.5 flex-shrink-0 rounded-md bg-slate-800/90 border border-white/30 text-white font-black text-xs flex items-center justify-center shadow-md animate-fadeIn"
              >
                {card}
              </div>
            ))
          )}
        </div>

        {roomName && (
          <span className="text-[10px] px-1.5 py-1 rounded-md bg-amber-400/20 text-amber-300 font-mono font-bold border border-amber-400/30 flex-shrink-0" title="Tài khoản nhận số">
            {roomName}
          </span>
        )}

        <button
          type="button"
          onClick={onClose}
          className="w-7 h-7 rounded-md bg-slate-800/80 hover:bg-red-600 text-slate-300 hover:text-white border border-white/10 transition-colors flex items-center justify-center flex-shrink-0 cursor-pointer"
          title="Đóng bảng nhập"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 2. Hàng chức năng 4 cột: 0 (Xanh), 13 (Xám), Xóa (Cam) và Reset (Đỏ) */}
      <div className="grid grid-cols-4 gap-1.5 flex-shrink-0">
        {/* Nút 0 */}
        <button
          type="button"
          onClick={() => handleCardClick('0')}
          className="h-8.5 rounded-lg bg-blue-900/80 hover:bg-blue-800 active:scale-95 border border-blue-400/60 text-blue-200 hover:text-white font-black text-base flex items-center justify-center shadow-md transition-all cursor-pointer"
          title="Bấm số 0 (Lá bài ẩn)"
        >
          0
        </button>

        {/* Nút 13 */}
        <button
          type="button"
          onClick={() => handleCardClick('13')}
          className="h-8.5 rounded-lg bg-slate-800/90 hover:bg-slate-700 active:scale-95 border border-white/25 hover:border-amber-400 text-white font-black text-base flex items-center justify-center shadow-md transition-all cursor-pointer"
          title="Bấm số 13"
        >
          13
        </button>

        {/* Nút Xóa */}
        <button
          type="button"
          onClick={handleDeleteClick}
          className="h-8.5 rounded-lg bg-amber-950/80 hover:bg-amber-900 active:scale-95 border border-amber-500/60 text-amber-200 hover:text-white font-bold text-xs flex items-center justify-center space-x-1 shadow-md transition-all cursor-pointer"
          title="Xóa lùi 1 số vừa nhập (Hoàn tác)"
        >
          <Delete className="w-3.5 h-3.5 text-amber-300" />
          <span>Xóa</span>
        </button>

        {/* Nút Reset đỏ */}
        <button
          type="button"
          onClick={handleResetRound}
          className="h-8.5 rounded-lg bg-red-600/90 hover:bg-red-500 active:scale-95 border border-red-400 text-white font-bold text-xs flex items-center justify-center space-x-1 shadow-md transition-all cursor-pointer"
          title="Reset toàn bộ số đã bấm và reset ván bài trên App"
        >
          <RotateCcw className="w-3.5 h-3.5 text-white" />
          <span>Reset</span>
        </button>
      </div>

      {/* 3. Lưới 4 cột: 1 -> 12 (3 hàng x 4 cột) */}
      <div className="grid grid-cols-4 gap-1.5 flex-1 min-h-0">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((num) => (
          <button
            key={num}
            type="button"
            onClick={() => handleCardClick(String(num))}
            className="rounded-lg bg-slate-900/80 hover:bg-slate-800/95 active:scale-95 border border-white/25 hover:border-amber-400 text-white font-bold text-base flex items-center justify-center shadow-md transition-all cursor-pointer"
            title={`Bấm số ${num}`}
          >
            {num}
          </button>
        ))}
      </div>

      {/* Resize Handle ở góc dưới bên phải */}
      <div
        data-resize-handle="true"
        onMouseDown={handleResizeMouseDown}
        className="absolute bottom-1 right-1 w-6 h-6 flex items-center justify-center cursor-se-resize text-slate-400 hover:text-amber-400 transition-colors"
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
