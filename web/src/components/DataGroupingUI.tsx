import React, { useState, useRef } from 'react';
import { DataEntry } from '../types';
import {
  Trash2,
  Sparkles,
  Hash,
  CheckCircle2,
  Database,
  Layers,
  Undo2,
  Edit2,
  Check,
  X,
  Plus,
  ShieldCheck,
  Flame,
  Award,
  AlertTriangle
} from 'lucide-react';

export type GameMode = '3cards' | '2cards';

interface DataGroupingUIProps {
  entries: DataEntry[];
  roomId?: string;
  roomName?: string;
  groupNames?: { [groupIndex: number]: string };
  onAddCard: (cardValue: string, groupCount: number, targetGroup?: number) => void;
  onClearCards: () => void;
  onUndoCard?: () => void;
  onFinishRound?: () => void;
  onEditCard?: (cardId: string, newCardValue: string) => void;
  onDeleteCard?: (cardId: string) => void;
  onSetGroupNames?: (names: { [groupIndex: number]: string }) => void;
}

// Chuẩn hóa và bóc tách rank và điểm cơ bản
export function parseCard(raw: string): { rank: string; value: number } {
  if (!raw) return { rank: '', value: 0 };
  const s = raw.trim().toUpperCase();

  // Át / Ace
  if (s === 'A' || s === 'ÁT' || s === 'AT' || s === 'ACE' || s.endsWith('A') || s.includes('ACE')) {
    return { rank: 'A', value: 1 };
  }
  // Tây / Hình người
  if (s === 'J' || s === 'BỒI' || s === 'JACK' || s.endsWith('J')) {
    return { rank: 'J', value: 10 };
  }
  if (s === 'Q' || s === 'ĐẦM' || s === 'QUEEN' || s.endsWith('Q')) {
    return { rank: 'Q', value: 10 };
  }
  if (s === 'K' || s === 'GIÀ' || s === 'KING' || s.endsWith('K')) {
    return { rank: 'K', value: 10 };
  }
  if (s === '10' || s.endsWith('10')) {
    return { rank: '10', value: 10 };
  }

  // Số từ 2..9
  const match = s.match(/\d+/);
  if (match) {
    const n = parseInt(match[0], 10);
    if (n >= 2 && n <= 9) return { rank: n.toString(), value: n };
    if (n === 10) return { rank: '10', value: 10 };
    if (n === 1) return { rank: 'A', value: 1 };
  }

  return { rank: s, value: 0 };
}

// Kiểm tra tính hợp lệ của lá bài nhập vào (A, 2..10, J, Q, K)
export function isValidCardValue(raw: string): { isValid: boolean; normalizedRank: string; value: number; error?: string } {
  if (!raw || !raw.trim()) {
    return { isValid: false, normalizedRank: '', value: 0, error: 'Vui lòng nhập giá trị lá bài!' };
  }

  const s = raw.trim().toUpperCase();

  // Át / Ace
  if (s === 'A' || s === 'ÁT' || s === 'AT' || s === 'ACE' || s.endsWith('A') || s.includes('ACE')) {
    return { isValid: true, normalizedRank: 'A', value: 1 };
  }
  // Tây / Hình người
  if (s === 'J' || s === 'BỒI' || s === 'BOI' || s === 'JACK' || s.endsWith('J') || s.includes('BỒI')) {
    return { isValid: true, normalizedRank: 'J', value: 10 };
  }
  if (s === 'Q' || s === 'ĐẦM' || s === 'DAM' || s === 'QUEEN' || s.endsWith('Q') || s.includes('ĐẦM')) {
    return { isValid: true, normalizedRank: 'Q', value: 10 };
  }
  if (s === 'K' || s === 'GIÀ' || s === 'GIA' || s === 'KING' || s.endsWith('K') || s.includes('GIÀ')) {
    return { isValid: true, normalizedRank: 'K', value: 10 };
  }
  if (s === '10' || s.endsWith('10')) {
    return { isValid: true, normalizedRank: '10', value: 10 };
  }

  // Số từ 2..9 (hoặc 1 tính là A)
  const match = s.match(/\d+/);
  if (match) {
    const n = parseInt(match[0], 10);
    if (n >= 2 && n <= 9) {
      return { isValid: true, normalizedRank: n.toString(), value: n };
    }
    if (n === 10) {
      return { isValid: true, normalizedRank: '10', value: 10 };
    }
    if (n === 1) {
      return { isValid: true, normalizedRank: 'A', value: 1 };
    }
    return {
      isValid: false,
      normalizedRank: '',
      value: 0,
      error: `Số "${n}" không hợp lệ! Lá bài chỉ có giá trị từ 2 đến 10, hoặc A, J, Q, K.`
    };
  }

  return {
    isValid: false,
    normalizedRank: '',
    value: 0,
    error: `"${raw}" không phải lá bài hợp lệ! Vui lòng chỉ nhập: A, 2..10, J, Q, K.`
  };
}

// Tính kết quả Chế độ 3 Lá (Liêng / Sáp)
export function evaluate3Cards(cards: DataEntry[]): {
  type: 'empty' | 'partial' | 'sap' | 'lieng' | '3tay' | 'points';
  label: string;
  score: number;
  highlightClass: string;
} {
  if (cards.length === 0) {
    return { type: 'empty', label: 'Chờ chia (0 lá)', score: 0, highlightClass: 'text-slate-500 bg-slate-900/60 border-white/5' };
  }
  if (cards.length < 3) {
    const sum = cards.reduce((acc, c) => acc + parseCard(c.cardValue).value, 0);
    return {
      type: 'partial',
      label: `Chờ chia (${cards.length}/3 lá)`,
      score: sum % 10,
      highlightClass: 'text-slate-400 bg-slate-900/80 border-slate-700/60'
    };
  }

  // Xét 3 lá gần nhất
  const last3 = cards.slice(-3);
  const parsed = last3.map((c) => parseCard(c.cardValue));
  const ranks = parsed.map((p) => p.rank);

  // 1. Kiểm tra Sáp (3 con giống hệt rank)
  if (ranks[0] === ranks[1] && ranks[1] === ranks[2]) {
    const sapRank = ranks[0] === 'A' ? 'Át' : ranks[0];
    return {
      type: 'sap',
      label: `Sáp ${sapRank} 👑`,
      score: 100,
      highlightClass: 'bg-gradient-to-r from-amber-500 to-yellow-400 text-slate-950 font-black shadow-lg shadow-amber-500/30 border-amber-300'
    };
  }

  // 2. Kiểm tra Liêng (3 con liên tiếp)
  const rankOrderMap: { [k: string]: number } = {
    A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13
  };
  const orderNums = ranks.map((r) => rankOrderMap[r] || 0).sort((a, b) => a - b);

  let isLieng = false;
  let liengLabel = '';

  if (orderNums[0] > 0 && orderNums[1] > 0 && orderNums[2] > 0) {
    // Sảnh liên tiếp thông thường (ví dụ: 4-5-6, 9-10-J, 10-J-Q, J-Q-K)
    if (orderNums[0] + 1 === orderNums[1] && orderNums[1] + 1 === orderNums[2]) {
      isLieng = true;
      liengLabel = `Liêng (${ranks.join('-')})`;
    }
    // Sảnh A-2-3 (order: 1, 2, 3)
    else if (orderNums[0] === 1 && orderNums[1] === 2 && orderNums[2] === 3) {
      isLieng = true;
      liengLabel = 'Liêng (A-2-3)';
    }
    // Sảnh Q-K-A (order: 1, 12, 13)
    else if (orderNums[0] === 1 && orderNums[1] === 12 && orderNums[2] === 13) {
      isLieng = true;
      liengLabel = 'Liêng (Q-K-A) ⭐';
    }
  }

  if (isLieng) {
    return {
      type: 'lieng',
      label: liengLabel,
      score: 80,
      highlightClass: 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-black shadow-md shadow-indigo-500/30 border-indigo-400'
    };
  }

  // 3. Kiểm tra 3 Tây (cả 3 lá đều là J, Q, K)
  const is3Tay = ranks.every((r) => r === 'J' || r === 'Q' || r === 'K');
  if (is3Tay) {
    return {
      type: '3tay',
      label: '3 Tây (Ảnh) ✨',
      score: 70,
      highlightClass: 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 font-bold'
    };
  }

  // 4. Tính điểm thường: tổng điểm mod 10
  const sum = parsed.reduce((acc, p) => acc + p.value, 0);
  const mod10 = sum % 10;
  return {
    type: 'points',
    label: mod10 === 0 ? '0 Điểm (Bù)' : `${mod10} Điểm`,
    score: mod10,
    highlightClass:
      mod10 >= 8
        ? 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 font-bold'
        : mod10 >= 5
        ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 font-bold'
        : 'bg-slate-800/80 text-slate-400 border border-white/10'
  };
}

// Tính kết quả Chế độ 2 Lá (Xì Lát / Xì Dách Việt Nam)
export function evaluate2Cards(cards: DataEntry[], isDan?: boolean): {
  status: 'empty' | 'partial' | 'xibang' | 'xilat' | 'ngulinh' | 'quac' | 'points' | 'non';
  label: string;
  total: number;
  highlightClass: string;
} {
  if (cards.length === 0) {
    return { status: 'empty', label: 'Chờ chia (0 lá)', total: 0, highlightClass: 'text-slate-500 bg-slate-900/60 border-white/5' };
  }
  if (cards.length === 1) {
    const p = parseCard(cards[0].cardValue);
    return {
      status: 'partial',
      label: `Chờ chia (1/2 lá)`,
      total: p.value,
      highlightClass: 'text-slate-400 bg-slate-900/80 border-slate-700/60'
    };
  }

  const parsed = cards.map((c) => parseCard(c.cardValue));
  const count = cards.length;
  const danSuffix = isDan ? ' • Đã Dằn' : '';

  // TRƯỜNG HỢP 1: Đúng 2 lá ban đầu
  if (count === 2) {
    const aceCount = parsed.filter((p) => p.rank === 'A').length;

    // 2 cây A: Xì Bàng (Cao nhất)
    if (aceCount === 2) {
      return {
        status: 'xibang',
        label: `Xì Bàng 👑${danSuffix}`,
        total: 21,
        highlightClass: 'bg-gradient-to-r from-amber-500 via-yellow-400 to-amber-600 text-slate-950 font-black shadow-lg shadow-amber-500/40 border-amber-300'
      };
    }

    // 1 cây A + 1 cây 10/J/Q/K: Xì Lát / Xì Dách (Cao nhì)
    const hasFaceOrTen = parsed.some((p) => p.rank === '10' || p.rank === 'J' || p.rank === 'Q' || p.rank === 'K');
    if (aceCount === 1 && hasFaceOrTen) {
      return {
        status: 'xilat',
        label: `Xì Lát 🔥 (21đ)${danSuffix}`,
        total: 21,
        highlightClass: 'bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950 font-black shadow-lg shadow-emerald-500/40 border-emerald-300'
      };
    }

    // 1 cây A + 1 cây số (2..9): A tính linh hoạt 11, 10 hoặc 1
    if (aceCount === 1) {
      const other = parsed.find((p) => p.rank !== 'A')?.value || 0;
      let best = 11 + other;
      if (best > 21) best = 10 + other;
      if (best > 21) best = 1 + other;

      if (best >= 16 && best <= 21) {
        return {
          status: 'points',
          label: `${best} Điểm${danSuffix}`,
          total: best,
          highlightClass: 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 font-bold'
        };
      } else {
        return {
          status: 'non',
          label: `${best} Điểm (Chưa đủ tuổi)${danSuffix}`,
          total: best,
          highlightClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold'
        };
      }
    }

    // 0 cây A: Tổng 2 cây thường
    const total = parsed[0].value + parsed[1].value;
    if (total >= 16 && total <= 21) {
      return {
        status: 'points',
        label: `${total} Điểm${danSuffix}`,
        total,
        highlightClass: 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 font-bold'
      };
    } else {
      return {
        status: 'non',
        label: `${total} Điểm (Chưa đủ tuổi)${danSuffix}`,
        total,
        highlightClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold'
      };
    }
  }

  // TRƯỜNG HỢP 2: TỪ 3 LÁ TRỞ LÊN (3, 4, hoặc 5 lá - đã bọt)
  // QUY TẮC CỐ ĐỊNH XÌ LÁT VIỆT NAM: CÂY A CHỈ TÍNH LÀ 1 ĐIỂM!
  const total = parsed.reduce((acc, p) => {
    if (p.rank === 'A') return acc + 1;
    return acc + p.value;
  }, 0);

  // Ngũ Linh (5 cây mà tổng <= 21)
  if (count === 5 && total <= 21) {
    return {
      status: 'ngulinh',
      label: `Ngũ Linh 🌟 (${total}đ)${danSuffix}`,
      total,
      highlightClass: 'bg-gradient-to-r from-purple-600 to-indigo-500 text-white font-black shadow-lg shadow-purple-500/40 border-purple-400'
    };
  }

  // Quắc (Tổng > 21)
  if (total > 21) {
    return {
      status: 'quac',
      label: `Quắc (${total}đ)`,
      total,
      highlightClass: 'bg-red-600/30 text-red-300 border border-red-500/50 font-bold'
    };
  }

  // Đủ điểm (16 <= total <= 21)
  if (total >= 16) {
    return {
      status: 'points',
      label: `${total} Điểm${danSuffix}`,
      total,
      highlightClass: 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 font-bold'
    };
  }

  // Chưa đủ tuổi (total < 16)
  return {
    status: 'non',
    label: `${total} Điểm (Chưa đủ tuổi)${danSuffix}`,
    total,
    highlightClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold'
  };
}

export const DataGroupingUI: React.FC<DataGroupingUIProps> = ({
  entries,
  roomId: _roomId,
  roomName,
  groupNames = {},
  onAddCard,
  onClearCards,
  onUndoCard,
  onFinishRound,
  onEditCard,
  onDeleteCard,
  onSetGroupNames
}) => {
  // Game Mode: 3 Lá (Liêng / Sáp) vs 2 Lá (Xì Lát / Xì Dách)
  const [gameMode, setGameMode] = useState<GameMode>('2cards');
  // Số nhóm: hỗ trợ từ 2 đến 8 nhóm
  const [numGroups, setNumGroups] = useState<number>(5);
  // Ô nhập nhanh chia vòng ở thanh trên cùng
  const [manualInput, setManualInput] = useState<string>('');
  // Filter tab trên điện thoại màn hình nhỏ
  const [mobileActiveFilter, setMobileActiveFilter] = useState<number | 'all'>('all');

  // Input điền bài riêng từng nhóm (Cho thao tác Bọt nhanh)
  const [groupBotInputs, setGroupBotInputs] = useState<{ [groupIndex: number]: string }>({});
  // Trạng thái Đã Dằn từng nhóm
  const [danGroups, setDanGroups] = useState<{ [groupIndex: number]: boolean }>({});

  // Inline Đổi tên nhóm
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [tempGroupName, setTempGroupName] = useState<string>('');

  // Modal / Popover Sửa / Xóa lá bài
  const [selectedCardForEdit, setSelectedCardForEdit] = useState<DataEntry | null>(null);
  const [editCardValue, setEditCardValue] = useState<string>('');

  // Custom App Confirmation Modal (Thay thế hoàn toàn window.confirm)
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText: string;
    confirmColor: 'red' | 'emerald';
    onConfirm: () => void;
  } | null>(null);

  // In-App Toast Notification (Thay thế alert local)
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<any>(null);

  const showToast = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 2500);
  };

  // Gom toàn bộ entries theo groupIndex
  const groupedItems: { [key: number]: DataEntry[] } = {};
  for (let i = 1; i <= numGroups; i++) {
    groupedItems[i] = [];
  }

  entries.forEach((entry) => {
    const idx = entry.groupIndex;
    if (!groupedItems[idx]) {
      groupedItems[idx] = [];
    }
    groupedItems[idx].push(entry);
  });

  // Nhóm đang được chọn / đang focus để nhập bài
  const [activeGroupId, setActiveGroupId] = useState<number | null>(null);

  // Tính toán thông minh nhóm tiếp theo cần chia bài (không bao giờ trỏ vào nhóm đã xong/đã đủ 5 lá/đã dằn/quắc)
  const computedNextGroup = (() => {
    const maxInitial = gameMode === '3cards' ? 3 : 2;

    // 1. Chia vòng ban đầu (Lá 1 cho N1..N, sau đó Lá 2 cho N1..N,...)
    for (let round = 0; round < maxInitial; round++) {
      for (let g = 1; g <= numGroups; g++) {
        const count = (groupedItems[g] || []).length;
        if (count === round) {
          return g;
        }
      }
    }

    // 2. Giai đoạn Bọt (Sau khi mọi người đã có >= 2 lá trong Xì Lát):
    // Tìm nhóm tiếp theo còn có thể rút bài (chưa đủ 5 lá, chưa Quắc, chưa Ngũ Linh, chưa Dằn)
    for (let g = 1; g <= numGroups; g++) {
      const count = (groupedItems[g] || []).length;
      const isStoodPat = danGroups[g] || false;
      if (count < 5 && !isStoodPat) {
        if (gameMode === '2cards') {
          const ev = evaluate2Cards(groupedItems[g] || [], isStoodPat);
          // Nếu đã Xì Bàng, Xì Lát, Quắc, Ngũ Linh thì nhóm này đã chốt, bỏ qua
          if (ev.status !== 'xibang' && ev.status !== 'xilat' && ev.status !== 'quac' && ev.status !== 'ngulinh') {
            return g;
          }
        } else {
          return g;
        }
      }
    }

    return 1;
  })();

  // Nhóm mục tiêu thực tế (Viền xanh đi theo chỗ nhập/focus của user, nếu không thì theo thứ tự chia bài thông minh)
  const currentTargetGroup = activeGroupId !== null ? activeGroupId : computedNextGroup;
  const targetGroupAll = groupedItems[currentTargetGroup] || [];
  const maxInitialCards = gameMode === '3cards' ? 3 : 2;

  // Validation Popup Modal khi nhập sai
  const [validationError, setValidationError] = useState<string | null>(null);

  // Chia bài từ thanh input trên cùng
  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = manualInput.trim();
    if (!raw) {
      setValidationError('Vui lòng nhập giá trị lá bài trước khi chia!');
      return;
    }
    const check = isValidCardValue(raw);
    if (!check.isValid) {
      setValidationError(check.error || 'Giá trị lá bài không hợp lệ!');
      return;
    }
    const target = currentTargetGroup;
    onAddCard(check.normalizedRank, numGroups, target);
    const gName = groupNames[target] || `Nhóm ${target}`;
    showToast(`✨ Đã chia lá "${check.normalizedRank}" vào ${gName}`);
    setManualInput('');
    setActiveGroupId(null);
  };

  // Thao tác Bọt riêng cho từng nhóm
  const handleBotSubmit = (groupNum: number) => {
    const raw = (groupBotInputs[groupNum] || '').trim() || manualInput.trim();
    const gName = groupNames[groupNum] || `Nhóm ${groupNum}`;
    if (!raw) {
      setValidationError(`Vui lòng nhập giá trị lá bài để bọt vào ${gName}!`);
      return;
    }
    const check = isValidCardValue(raw);
    if (!check.isValid) {
      setValidationError(check.error || 'Giá trị lá bài không hợp lệ!');
      return;
    }
    onAddCard(check.normalizedRank, numGroups, groupNum);
    showToast(`+ Đã bọt lá "${check.normalizedRank}" vào ${gName}`);
    setGroupBotInputs((prev) => ({ ...prev, [groupNum]: '' }));
    if (raw === manualInput.trim()) {
      setManualInput('');
    }
    setActiveGroupId(null);
  };

  // Toggle trạng thái Dằn bài của nhóm
  const toggleDanGroup = (groupNum: number) => {
    const nextState = !danGroups[groupNum];
    setDanGroups((prev) => ({ ...prev, [groupNum]: nextState }));
    const gName = groupNames[groupNum] || `Nhóm ${groupNum}`;
    showToast(nextState ? `🛡️ ${gName} đã DẰN bài` : `🔓 ${gName} hủy dằn bài`);
  };

  // Bắt đầu sửa tên nhóm
  const startEditGroupName = (groupNum: number) => {
    setEditingGroupId(groupNum);
    setTempGroupName(groupNames[groupNum] || `Nhóm ${groupNum}`);
  };

  // Lưu tên nhóm
  const saveGroupName = (groupNum: number) => {
    if (onSetGroupNames && tempGroupName.trim()) {
      onSetGroupNames({ ...groupNames, [groupNum]: tempGroupName.trim() });
      showToast(`✏️ Đã đổi tên thành "${tempGroupName.trim()}"`);
    }
    setEditingGroupId(null);
  };

  // Mở modal sửa lá bài
  const openEditCardModal = (card: DataEntry) => {
    setSelectedCardForEdit(card);
    setEditCardValue(card.cardValue);
  };

  // Lưu sửa lá bài
  const handleSaveEditCard = () => {
    if (!selectedCardForEdit || !onEditCard) return;
    const raw = editCardValue.trim();
    if (!raw) {
      setValidationError('Vui lòng nhập giá trị mới cho lá bài!');
      return;
    }
    const check = isValidCardValue(raw);
    if (!check.isValid) {
      setValidationError(check.error || 'Giá trị lá bài không hợp lệ!');
      return;
    }
    onEditCard(selectedCardForEdit.id, check.normalizedRank);
    showToast(`🃏 Đã sửa lá bài thành "${check.normalizedRank}"`);
    setSelectedCardForEdit(null);
  };

  // Xóa lá bài
  const handleDeleteCurrentCard = () => {
    if (selectedCardForEdit && onDeleteCard) {
      onDeleteCard(selectedCardForEdit.id);
      showToast(`🗑️ Đã xóa lá bài`);
      setSelectedCardForEdit(null);
    }
  };

  // Mở popup xác nhận xóa tất cả bài
  const handleRequestClearCards = () => {
    setConfirmModal({
      isOpen: true,
      title: 'Xóa Toàn Bộ Bài?',
      message: 'Bạn có chắc chắn muốn xóa toàn bộ các lá bài hiện tại của phiên này không?',
      confirmText: 'Xác Nhận Xóa',
      confirmColor: 'red',
      onConfirm: () => {
        onClearCards();
        showToast('🗑️ Đã xóa sạch toàn bộ bài');
        setConfirmModal(null);
      }
    });
  };

  // Mở popup xác nhận kết thúc phiên
  const handleRequestFinishRound = () => {
    setConfirmModal({
      isOpen: true,
      title: 'Kết Thúc Phiên Chơi?',
      message: 'Hệ thống sẽ làm mới bộ nhớ DVR video và xóa bài để sẵn sàng cho phiên mới.',
      confirmText: 'Xác Nhận Xong',
      confirmColor: 'emerald',
      onConfirm: () => {
        if (onFinishRound) onFinishRound();
        showToast('🎉 Đã hoàn tất phiên chơi');
        setConfirmModal(null);
      }
    });
  };

  return (
    <div className="glass-panel rounded-2xl p-2.5 sm:p-3.5 border border-indigo-500/20 space-y-2.5 flex flex-col justify-between relative">
      {/* Toast Notification Floating Popup */}
      {toastMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] px-4 py-2 rounded-2xl bg-slate-900/95 border border-amber-500/50 text-amber-300 text-xs sm:text-sm font-bold shadow-2xl backdrop-blur-md flex items-center space-x-2 animate-fadeIn pointer-events-none">
          <span>{toastMessage}</span>
        </div>
      )}

      {/* 1. Header & Quick Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2">
        <div className="flex items-center space-x-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center flex-shrink-0">
            <Database className="w-3.5 h-3.5" />
          </div>
          <div className="flex items-center space-x-1.5 truncate">
            <h2 className="text-xs sm:text-sm font-bold text-slate-100 whitespace-nowrap">
              {roomName ? `Room: ${roomName}` : 'Phân Loại Dữ Liệu'}
            </h2>
            <span
              className={`text-[9px] px-2 py-0.5 rounded-full font-mono font-bold border flex-shrink-0 ${
                gameMode === '2cards'
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  : 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
              }`}
            >
              {gameMode === '2cards' ? '2 Lá (Xì Lát)' : '3 Lá (Liêng/Sáp)'}
            </span>
          </div>
        </div>

        {/* Action Buttons: Undo, Clear, Finish */}
        <div className="flex items-center space-x-1.5 flex-shrink-0">
          {/* Undo Button */}
          {onUndoCard && entries.length > 0 && (
            <button
              onClick={() => {
                onUndoCard();
                showToast('↩️ Đã hoàn tác lá bài vừa chia');
              }}
              className="p-1.5 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-amber-300 border border-white/10 text-xs font-medium transition-all active:scale-95"
              title="Hoàn tác: Xóa lá bài vừa chia"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Clear Button (Popup Modal) */}
          <button
            type="button"
            onClick={handleRequestClearCards}
            className="p-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 text-xs font-medium transition-all active:scale-95"
            title="Xóa toàn bộ danh sách hiện tại"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          {/* Finish Round Button (Popup Modal) */}
          {onFinishRound && (
            <button
              type="button"
              onClick={handleRequestFinishRound}
              className="px-2 py-1 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold transition-all flex items-center space-x-1 active:scale-95"
              title="Làm mới bộ nhớ và bắt đầu phiên mới"
            >
              <CheckCircle2 className="w-3 h-3" />
              <span>Xong Phiên</span>
            </button>
          )}
        </div>
      </div>

      {/* 2. Mode Selector Tabs & Group Count Selector */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 bg-slate-950/60 p-1.5 rounded-xl border border-white/5">
        {/* Game Mode Tabs */}
        <div className="grid grid-cols-2 gap-1 bg-slate-900/80 p-0.5 rounded-lg border border-white/10 flex-1 sm:flex-initial">
          <button
            type="button"
            onClick={() => setGameMode('3cards')}
            className={`px-2.5 py-1.5 rounded-md text-xs font-bold transition-all flex items-center justify-center space-x-1 ${
              gameMode === '3cards'
                ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/40 border border-indigo-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Award className="w-3.5 h-3.5 text-indigo-300" />
            <span>3 Lá (Liêng/Sáp)</span>
          </button>
          <button
            type="button"
            onClick={() => setGameMode('2cards')}
            className={`px-2.5 py-1.5 rounded-md text-xs font-bold transition-all flex items-center justify-center space-x-1 ${
              gameMode === '2cards'
                ? 'bg-amber-500 text-slate-950 shadow-sm shadow-amber-500/40 border border-amber-400 font-black'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Flame className="w-3.5 h-3.5 text-amber-400" />
            <span>2 Lá (Xì Lát)</span>
          </button>
        </div>

        {/* Group Count Selector: 2, 3, 4, 5, 6, 7, 8 */}
        <div className="flex items-center space-x-1 bg-slate-900/80 px-2 py-1 rounded-lg border border-white/10 self-stretch sm:self-auto overflow-x-auto no-scrollbar">
          <span className="text-[10px] sm:text-[11px] font-semibold text-slate-400 flex items-center pr-1 flex-shrink-0">
            <Hash className="w-3 h-3 mr-0.5 text-indigo-400" />
            Nhóm:
          </span>
          {[2, 3, 4, 5, 6, 7, 8].map((count) => (
            <button
              key={count}
              type="button"
              onClick={() => {
                setNumGroups(count);
                if (mobileActiveFilter !== 'all' && mobileActiveFilter > count) {
                  setMobileActiveFilter('all');
                }
              }}
              className={`w-6 h-6 sm:w-6 sm:h-6 rounded text-[11px] font-bold transition-all flex items-center justify-center flex-shrink-0 ${
                numGroups === count
                  ? 'bg-indigo-600 text-white shadow shadow-indigo-600/40 border border-indigo-400'
                  : 'bg-slate-800/80 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
              }`}
            >
              {count}
            </button>
          ))}
        </div>
      </div>

      {/* 3. Unified Input Bar (Chia vòng tuần tự) */}
      <form
        onSubmit={handleManualSubmit}
        className="flex items-center gap-1.5 p-1 sm:p-1.5 rounded-xl border bg-slate-900/90 border-indigo-500/25 shadow-inner transition-all"
      >
        <div className="flex-1 flex items-center space-x-1.5 pl-1.5 min-w-0">
          <input
            type="text"
            value={manualInput}
            onFocus={() => setActiveGroupId(null)}
            onChange={(e) => setManualInput(e.target.value)}
            placeholder="Nhập mã hoặc chọn lá: 8, 9, K, A, 10..."
            className="w-full bg-transparent text-white font-mono text-xs focus:outline-none placeholder:text-slate-500 truncate"
          />
        </div>

        <button
          type="submit"
          className="px-3 py-1.5 rounded-lg font-bold text-xs flex items-center space-x-1 shadow transition-all active:scale-95 flex-shrink-0 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white"
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-300" />
          <span className="hidden xs:inline">Chia Vòng</span>
          <span className="xs:hidden">Chia</span>
        </button>

        {/* Next Target Badge */}
        <div className="flex items-center space-x-1 pl-1.5 pr-0.5 border-l border-white/10 text-[11px] flex-shrink-0 font-mono">
          <span className="text-slate-400 text-[10px] hidden sm:inline">Kế tiếp:</span>
          <span className="px-1.5 py-0.5 rounded font-bold border text-[10px] sm:text-[11px] flex items-center space-x-1 bg-indigo-600/40 text-indigo-200 border-indigo-500/40">
            <span>N{currentTargetGroup}</span>
            <span className="text-[9px] font-normal opacity-90">
              (Lá {targetGroupAll.length + 1}/{maxInitialCards})
            </span>
          </span>
        </div>
      </form>

      {/* 4. Mobile Tab Filter Bar */}
      <div className="flex md:hidden items-center space-x-1 overflow-x-auto no-scrollbar py-0.5">
        <button
          type="button"
          onClick={() => setMobileActiveFilter('all')}
          className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all flex items-center space-x-1 flex-shrink-0 ${
            mobileActiveFilter === 'all'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'bg-slate-900/60 text-slate-400 border border-white/5'
          }`}
        >
          <Layers className="w-3 h-3" />
          <span>Tất cả ({numGroups})</span>
        </button>
        {Array.from({ length: numGroups }).map((_, idx) => {
          const gNum = idx + 1;
          const gName = groupNames[gNum] || `Nhóm ${gNum}`;
          const allItems = groupedItems[gNum] || [];
          return (
            <button
              key={gNum}
              type="button"
              onClick={() => setMobileActiveFilter(gNum)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all flex items-center space-x-1 flex-shrink-0 ${
                mobileActiveFilter === gNum
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-slate-900/60 text-slate-400 border border-white/5'
              }`}
            >
              <span>{gName}</span>
              <span className="text-[9px] opacity-80">({allItems.length})</span>
            </button>
          );
        })}
      </div>

      {/* 5. Grouped Columns Display - Thiết kế cân đối, không bao giờ bị tràn hay lệch */}
      <div
        className={`grid ${
          numGroups === 2
            ? 'grid-cols-2'
            : numGroups === 3
            ? 'grid-cols-2 sm:grid-cols-3'
            : numGroups === 4
            ? 'grid-cols-2 sm:grid-cols-2 xl:grid-cols-4'
            : 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4'
        } gap-2 sm:gap-2.5`}
      >
        {Array.from({ length: numGroups }).map((_, idx) => {
          const groupNum = idx + 1;
          const allItemsInGroup = groupedItems[groupNum] || [];
          const customName = groupNames[groupNum] || `Nhóm ${groupNum}`;
          const isNextTarget = groupNum === currentTargetGroup;
          const isStoodPat = danGroups[groupNum] || false;

          // Mobile filter check
          if (mobileActiveFilter !== 'all' && mobileActiveFilter !== groupNum) {
            return null;
          }

          // Đánh giá kết quả nhóm theo chế độ
          const evalResult =
            gameMode === '3cards'
              ? evaluate3Cards(allItemsInGroup)
              : evaluate2Cards(allItemsInGroup, isStoodPat);

          // Xác định số slot thẻ cần hiển thị (Ít nhất 2 lá cho Xì Lát, 3 lá cho 3 Lá)
          const minSlots = gameMode === '3cards' ? 3 : 2;
          const slotCount = Math.max(minSlots, allItemsInGroup.length);

          return (
            <div
              key={groupNum}
              onClick={() => setActiveGroupId(groupNum)}
              className={`rounded-2xl p-2.5 sm:p-3 transition-all border flex flex-col justify-between shadow-md relative overflow-hidden cursor-pointer ${
                isStoodPat
                  ? 'bg-slate-900/90 border-emerald-500/40 ring-1 ring-emerald-500/30'
                  : isNextTarget
                  ? 'bg-indigo-950/45 border-indigo-500 shadow-indigo-500/20 ring-2 ring-indigo-500/60'
                  : 'bg-slate-900/70 border-white/5 hover:border-white/15'
              }`}
            >
              <div>
                {/* Group Header: [Number] [Name / Inline Edit] [Count] */}
                <div className="flex items-center justify-between border-b border-white/10 pb-2 mb-2">
                  <div className="flex items-center space-x-1.5 min-w-0 flex-1 mr-1">
                    <span
                      className={`w-5 h-5 rounded-lg flex items-center justify-center font-bold text-[11px] flex-shrink-0 ${
                        isNextTarget ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/40' : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {groupNum}
                    </span>

                    {/* Inline Edit Group Name */}
                    {editingGroupId === groupNum ? (
                      <div className="flex items-center space-x-1 min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          value={tempGroupName}
                          onChange={(e) => setTempGroupName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveGroupName(groupNum);
                            if (e.key === 'Escape') setEditingGroupId(null);
                          }}
                          autoFocus
                          className="w-full bg-slate-950 text-white px-1.5 py-0.5 rounded border border-indigo-400 text-xs focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => saveGroupName(groupNum)}
                          className="p-1 rounded bg-emerald-600 text-white hover:bg-emerald-500"
                        >
                          <Check className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditGroupName(groupNum);
                        }}
                        className="flex items-center space-x-1 cursor-pointer group min-w-0"
                        title="Bấm để đổi tên nhóm"
                      >
                        <h3 className="font-bold text-xs text-slate-100 whitespace-nowrap group-hover:text-amber-300 transition-colors">
                          {customName}
                        </h3>
                        <Edit2 className="w-2.5 h-2.5 text-slate-500 group-hover:text-amber-300 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                      </div>
                    )}
                  </div>

                  {/* Card count tag */}
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded border bg-slate-800/90 text-slate-400 border-white/5 flex-shrink-0">
                    {allItemsInGroup.length} lá
                  </span>
                </div>

                {/* List of Cards: Thẻ bài hiển thị đầy đủ, không rỗng */}
                <div className="space-y-1.5 py-0.5 min-h-[64px]">
                  {Array.from({ length: slotCount }).map((_, slotIdx) => {
                    const item = allItemsInGroup[slotIdx];
                    if (item) {
                      const p = parseCard(item.cardValue);
                      return (
                        <div
                          key={item.id || slotIdx}
                          onClick={() => openEditCardModal(item)}
                          className="flex items-center justify-between px-2 py-1.5 rounded-xl bg-slate-800/90 border border-white/10 hover:border-amber-400/60 hover:bg-slate-800 cursor-pointer transition-all text-xs group shadow-sm"
                          title="Bấm vào lá bài để sửa hoặc xóa"
                        >
                          <div className="flex items-center space-x-1.5 min-w-0">
                            <span className="text-[10px] font-mono text-slate-400 w-4">
                              L{slotIdx + 1}
                            </span>
                            <span className="font-black font-mono text-white text-sm tracking-wide truncate group-hover:text-amber-300">
                              {item.cardValue}
                            </span>
                            <span className="text-[9px] font-mono text-slate-500">
                              #{item.sequenceOrder}
                            </span>
                          </div>

                          <div className="flex items-center space-x-1 flex-shrink-0">
                            {p.value > 0 && (
                              <span className="text-[10px] font-mono font-bold text-amber-300 px-1.5 py-0.2 rounded bg-slate-900 border border-white/5">
                                +{p.value}
                              </span>
                            )}
                            <Edit2 className="w-3 h-3 text-slate-500 group-hover:text-amber-300 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                        </div>
                      );
                    } else {
                      return (
                        <div
                          key={`empty-${slotIdx}`}
                          className="flex items-center justify-center py-2 rounded-xl border border-dashed border-white/10 text-[11px] text-slate-500 font-mono select-none"
                        >
                          Lá {slotIdx + 1}
                        </div>
                      );
                    }
                  })}
                </div>
              </div>

              {/* Action Bar riêng cho từng nhóm: Bố cục 2 hàng cực kỳ gọn gàng, không bao giờ tràn */}
              <div className="mt-2.5 pt-2 border-t border-white/10 space-y-1.5">
                {/* Hàng 1: Ô Điền full-width */}
                <div
                  className={`flex items-center bg-slate-950 px-2.5 py-1.5 rounded-xl border w-full transition-all ${
                    isNextTarget
                      ? 'border-indigo-500 ring-2 ring-indigo-500/50 shadow-md shadow-indigo-500/20'
                      : 'border-white/10 hover:border-white/20'
                  }`}
                >
                  <span
                    className={`text-[11px] mr-1.5 font-mono flex-shrink-0 font-bold ${
                      isNextTarget ? 'text-indigo-300' : 'text-slate-400'
                    }`}
                  >
                    Điền:
                  </span>
                  <input
                    type="text"
                    value={groupBotInputs[groupNum] || ''}
                    onFocus={() => setActiveGroupId(groupNum)}
                    onChange={(e) =>
                      setGroupBotInputs((prev) => ({ ...prev, [groupNum]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleBotSubmit(groupNum);
                      }
                    }}
                    placeholder="8, 9, K, A..."
                    className="w-full bg-transparent text-white font-mono text-xs focus:outline-none min-w-0 placeholder:text-slate-600"
                  />
                </div>

                {/* Hàng 2: Hai nút cân đối 50-50 (+ Bọt & Dằn) */}
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleBotSubmit(groupNum)}
                    className="w-full py-1.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-black text-xs flex items-center justify-center space-x-1 shadow-sm transition-all active:scale-95"
                    title={`Rút thêm bài (Bọt) vào ${customName}`}
                  >
                    <Plus className="w-3.5 h-3.5 stroke-[3]" />
                    <span>Bọt</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => toggleDanGroup(groupNum)}
                    className={`w-full py-1.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1 active:scale-95 ${
                      isStoodPat
                        ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/30 font-black'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-white/10'
                    }`}
                    title="Đánh dấu nhóm này đã dằn (không rút thêm)"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>{isStoodPat ? 'Đã Dằn' : 'Dằn'}</span>
                  </button>
                </div>

                {/* Hàng 3: Kết quả nhóm (Hiển thị luật Xì Lát VN hoặc 3 Lá Liêng/Sáp) */}
                <div
                  className={`w-full py-1.5 px-2 rounded-xl text-xs font-mono font-bold text-center border transition-all ${evalResult.highlightClass}`}
                >
                  {evalResult.label}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 6. Modal Popup Sửa hoặc Xóa Lá Bài */}
      {selectedCardForEdit && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-slate-900 border border-amber-500/40 rounded-2xl p-4 max-w-sm w-full space-y-3 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <div className="flex items-center space-x-2">
                <Edit2 className="w-4 h-4 text-amber-400" />
                <h3 className="font-bold text-sm text-white">Sửa / Xóa Lá Bài</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCardForEdit(null)}
                className="text-slate-400 hover:text-white p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-slate-300">
                Lá bài hiện tại: <strong className="text-amber-300 font-mono text-sm">{selectedCardForEdit.cardValue}</strong> (Nhóm {selectedCardForEdit.groupIndex}, Lượt #{selectedCardForEdit.sequenceOrder})
              </p>

              <div>
                <label className="text-[11px] text-slate-400 font-semibold mb-1 block">
                  Nhập giá trị mới:
                </label>
                <input
                  type="text"
                  value={editCardValue}
                  onChange={(e) => setEditCardValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveEditCard();
                  }}
                  autoFocus
                  className="w-full bg-slate-950 text-white font-mono text-sm px-3 py-2 rounded-xl border border-white/20 focus:outline-none focus:border-amber-400"
                  placeholder="A, 2, 3, 10, J, Q, K..."
                />
              </div>

              {/* Quick Select Buttons */}
              <div className="flex flex-wrap gap-1 pt-1">
                {['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'].map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setEditCardValue(c)}
                    className={`px-2 py-1 rounded-md text-xs font-mono font-bold transition-all ${
                      editCardValue.trim().toUpperCase() === c
                        ? 'bg-amber-400 text-slate-950 font-black'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-2 border-t border-white/10">
              <button
                type="button"
                onClick={handleDeleteCurrentCard}
                className="px-3 py-1.5 rounded-xl bg-red-600/20 hover:bg-red-600 text-red-300 hover:text-white border border-red-500/40 text-xs font-bold flex items-center space-x-1 transition-all"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Xóa Lá Này</span>
              </button>

              <div className="flex items-center space-x-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedCardForEdit(null)}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium"
                >
                  Hủy
                </button>
                <button
                  type="button"
                  onClick={handleSaveEditCard}
                  className="px-3.5 py-1.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs flex items-center space-x-1 shadow-md shadow-amber-500/20"
                >
                  <Check className="w-3.5 h-3.5 stroke-[3]" />
                  <span>Lưu Sửa</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 7. Custom App Confirmation Modal (Thay thế window.confirm local) */}
      {confirmModal && confirmModal.isOpen && (
        <div className="fixed inset-0 z-[90] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-slate-900 border border-white/20 rounded-2xl p-5 max-w-sm w-full space-y-4 shadow-2xl text-center">
            <div
              className={`w-12 h-12 rounded-full mx-auto flex items-center justify-center ${
                confirmModal.confirmColor === 'red'
                  ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                  : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
              }`}
            >
              {confirmModal.confirmColor === 'red' ? (
                <Trash2 className="w-6 h-6" />
              ) : (
                <CheckCircle2 className="w-6 h-6" />
              )}
            </div>
            <div>
              <h3 className="text-base font-bold text-white">{confirmModal.title}</h3>
              <p className="text-xs text-slate-400 mt-1">{confirmModal.message}</p>
            </div>
            <div className="flex items-center justify-center space-x-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmModal(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-all flex-1"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={confirmModal.onConfirm}
                className={`px-4 py-2 rounded-xl text-white text-xs font-bold transition-all shadow-md flex-1 ${
                  confirmModal.confirmColor === 'red'
                    ? 'bg-red-600 hover:bg-red-500 shadow-red-600/30'
                    : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/30'
                }`}
              >
                {confirmModal.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 8. Validation Popup Modal (Cảnh báo khi nhập sai lá bài) */}
      {validationError && (
        <div className="fixed inset-0 z-[95] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-slate-900 border border-red-500/50 rounded-2xl p-5 max-w-sm w-full space-y-4 shadow-2xl text-center">
            <div className="w-14 h-14 rounded-full bg-red-500/20 border border-red-500/40 text-red-400 flex items-center justify-center mx-auto shadow-lg shadow-red-500/10 animate-bounce">
              <AlertTriangle className="w-7 h-7" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-wide">Lá Bài Không Hợp Lệ</h3>
              <p className="text-xs text-red-300 mt-1.5 font-medium leading-relaxed bg-red-950/40 border border-red-500/20 p-2.5 rounded-xl">
                {validationError}
              </p>
            </div>
            <div className="bg-slate-950/90 p-3 rounded-xl border border-white/10 text-xs text-slate-300 space-y-2 text-left">
              <p className="font-bold text-amber-300 flex items-center space-x-1">
                <span>💡</span>
                <span>Các lá bài hợp lệ bao gồm:</span>
              </p>
              <div className="flex flex-wrap gap-1.5 font-mono font-black text-xs">
                {['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'].map((c) => (
                  <span
                    key={c}
                    className="px-2 py-0.5 bg-slate-800 rounded-md border border-amber-400/30 text-amber-300 shadow-sm"
                  >
                    {c}
                  </span>
                ))}
              </div>
              <p className="text-[10px] text-slate-400 italic">
                * Có thể nhập chất hoặc tên thân quen: Át, Bồi, Đầm, Già, Ace, King, 10 Bích, v.v.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setValidationError(null)}
              autoFocus
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white font-bold text-xs shadow-lg shadow-red-600/30 transition-all active:scale-95"
            >
              Đã Hiểu & Nhập Lại
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
