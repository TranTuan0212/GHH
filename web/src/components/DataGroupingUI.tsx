import React, { useState, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
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
  AlertTriangle,
  EyeOff,
  LayoutGrid,
  Swords
} from 'lucide-react';
import { CardPickerPopup, CardPickerTarget } from './CardPickerPopup';

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

// Chuẩn hóa và bóc tách giá trị số (hỗ trợ số từ 1..13 và số 0 không thấy)
export function parseCard(raw: string): { rank: string; value: number } {
  if (!raw) return { rank: '', value: 0 };
  const s = raw.trim().toUpperCase();

  // Nút 0 hoặc "Không thấy"
  if (s === '0' || s.includes('KHÔNG THẤY') || s.includes('KHONG THAY') || s === '?' || s.includes('UNKNOWN')) {
    return { rank: '0', value: 0 };
  }

  // Tách bỏ ký hiệu chất ♥♦♣♠ nếu có để lấy rank
  const cleanRank = s.replace(/[♥♦♣♠]/g, '').trim();

  // Chuyển ký tự chữ cũ nếu có về số tương ứng
  if (cleanRank === 'A' || cleanRank === 'ÁT' || cleanRank === 'AT' || cleanRank === 'ACE' || cleanRank.endsWith('A') || cleanRank.includes('ACE')) {
    return { rank: '1', value: 1 };
  }
  if (cleanRank === 'J' || cleanRank === 'BỒI' || cleanRank === 'JACK' || cleanRank.endsWith('J')) {
    return { rank: '11', value: 10 };
  }
  if (cleanRank === 'Q' || cleanRank === 'ĐẦM' || cleanRank === 'QUEEN' || cleanRank.endsWith('Q')) {
    return { rank: '12', value: 10 };
  }
  if (cleanRank === 'K' || cleanRank === 'GIÀ' || cleanRank === 'KING' || cleanRank.endsWith('K')) {
    return { rank: '13', value: 10 };
  }

  // Số từ 0..13
  const match = cleanRank.match(/\d+/);
  if (match) {
    const n = parseInt(match[0], 10);
    if (n === 0) return { rank: '0', value: 0 };
    if (n >= 1 && n <= 9) return { rank: n.toString(), value: n };
    if (n >= 10 && n <= 13) return { rank: n.toString(), value: 10 };
  }

  return { rank: cleanRank || s, value: 0 };
}

// Kiểm tra tính hợp lệ của từng mục đơn lẻ
function validateSingleCard(raw: string): { isValid: boolean; normalizedRank: string; value: number; error?: string } {
  if (!raw || !raw.trim()) {
    return { isValid: false, normalizedRank: '', value: 0, error: 'Vui lòng nhập giá trị!' };
  }

  const s = raw.trim().toUpperCase();

  // Hỗ trợ số 0 và "Không thấy"
  if (s === '0' || s.includes('KHÔNG THẤY') || s.includes('KHONG THAY') || s === '?' || s.includes('UNKNOWN')) {
    return { isValid: true, normalizedRank: '0', value: 0 };
  }

  const cleanRank = s.replace(/[♥♦♣♠]/g, '').trim();

  // 1 / A
  if (cleanRank === '1' || cleanRank === 'A' || cleanRank === 'ÁT' || cleanRank === 'AT' || cleanRank === 'ACE') {
    return { isValid: true, normalizedRank: '1', value: 1 };
  }
  // 11 / J
  if (cleanRank === '11' || cleanRank === 'J' || cleanRank === 'BỒI' || cleanRank === 'JACK') {
    return { isValid: true, normalizedRank: '11', value: 10 };
  }
  // 12 / Q
  if (cleanRank === '12' || cleanRank === 'Q' || cleanRank === 'ĐẦM' || cleanRank === 'QUEEN') {
    return { isValid: true, normalizedRank: '12', value: 10 };
  }
  // 13 / K
  if (cleanRank === '13' || cleanRank === 'K' || cleanRank === 'GIÀ' || cleanRank === 'KING') {
    return { isValid: true, normalizedRank: '13', value: 10 };
  }

  // Số từ 2..13
  const numMatch = cleanRank.match(/\d+/);
  if (numMatch) {
    const num = parseInt(numMatch[0], 10);
    if (num === 0) {
      return { isValid: true, normalizedRank: '0', value: 0 };
    }
    if (num >= 2 && num <= 9) {
      return { isValid: true, normalizedRank: num.toString(), value: num };
    }
    if (num >= 10 && num <= 13) {
      return { isValid: true, normalizedRank: num.toString(), value: 10 };
    }
  }

  return { isValid: true, normalizedRank: raw.trim(), value: 0 };
}

// Kiểm tra tính hợp lệ của lá bài nhập vào (hỗ trợ cả 1 lá hoặc nhiều lá cách nhau bởi dấu phẩy hoặc khoảng trắng)
export function isValidCardValue(raw: string): { isValid: boolean; normalizedRank: string; value: number; error?: string } {
  if (!raw || !raw.trim()) {
    return { isValid: false, normalizedRank: '', value: 0, error: 'Vui lòng nhập giá trị lá bài!' };
  }

  // 1. Hỗ trợ nhập nhiều lá bài cách nhau bằng dấu phẩy (vd: "1,2,3,4,5,6,7,8,9" hoặc "8, 9, K")
  if (raw.includes(',')) {
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      const normalizedParts: string[] = [];
      let lastValue = 0;
      for (const part of parts) {
        const res = validateSingleCard(part);
        if (!res.isValid) {
          return res;
        }
        normalizedParts.push(res.normalizedRank);
        lastValue = res.value;
      }
      return {
        isValid: true,
        normalizedRank: normalizedParts.join(','),
        value: lastValue
      };
    }
  }

  // 2. Hỗ trợ nhập nhiều lá bài cách nhau bằng dấu cách (vd: "1 2 3 4 5 6 7 8 9" hoặc "8 9 10")
  const spaceParts = raw.trim().split(/\s+/).filter(Boolean);
  if (spaceParts.length > 1) {
    let allValid = true;
    const normalizedParts: string[] = [];
    let lastValue = 0;
    for (const part of spaceParts) {
      const res = validateSingleCard(part);
      if (!res.isValid) {
        allValid = false;
        break;
      }
      normalizedParts.push(res.normalizedRank);
      lastValue = res.value;
    }
    if (allValid && normalizedParts.length > 1) {
      return {
        isValid: true,
        normalizedRank: normalizedParts.join(','),
        value: lastValue
      };
    }
  }

  return validateSingleCard(raw);
}

// Helper tính độ mạnh của quân bài (Át = 14 trong so bài Liêng/Sáp, K = 13, Q = 12, J = 11, 10..2)
export function getRankPower(r: string): number {
  const s = r.trim().toUpperCase();
  if (s === '1' || s === 'A' || s === 'ÁT' || s === 'AT' || s === 'ACE') return 14;
  if (s === '13' || s === 'K' || s === 'GIÀ' || s === 'KING') return 13;
  if (s === '12' || s === 'Q' || s === 'ĐẦM' || s === 'QUEEN') return 12;
  if (s === '11' || s === 'J' || s === 'BỒI' || s === 'JACK') return 11;
  const n = parseInt(s, 10);
  if (!isNaN(n) && n >= 2 && n <= 10) return n;
  return 0;
}

// Helper hiển thị tên quân bài thân thiện
export function getRankDisplay(r: string): string {
  const s = r.trim().toUpperCase();
  if (s === '1' || s === 'A' || s === 'ÁT' || s === 'AT' || s === 'ACE') return 'A';
  if (s === '13' || s === 'K' || s === 'GIÀ' || s === 'KING') return 'K';
  if (s === '12' || s === 'Q' || s === 'ĐẦM' || s === 'QUEEN') return 'Q';
  if (s === '11' || s === 'J' || s === 'BỒI' || s === 'JACK') return 'J';
  return s;
}

// Tính kết quả Chế độ 3 Mục
export function evaluate3Cards(cards: DataEntry[]): {
  type: 'empty' | 'partial' | 'sap' | 'lieng' | '3tay' | 'points';
  label: string;
  score: number;
  highlightClass: string;
} {
  if (cards.length === 0) {
    return { type: 'empty', label: 'Chờ nhập (0 mục)', score: 0, highlightClass: 'text-slate-500 bg-slate-900/60 border-white/5' };
  }
  if (cards.length < 3) {
    const sum = cards.reduce((acc, c) => acc + parseCard(c.cardValue).value, 0);
    return {
      type: 'partial',
      label: `Chờ nhập (${cards.length}/3 mục)`,
      score: sum % 10,
      highlightClass: 'text-slate-400 bg-slate-900/80 border-slate-700/60'
    };
  }

  // Xét 3 mục gần nhất
  const last3 = cards.slice(-3);
  const parsed = last3.map((c) => parseCard(c.cardValue));
  const ranks = parsed.map((p) => p.rank);

  // 1. Kiểm tra Sáp (Bộ 3 giống nhau / 3 mục cùng số)
  // Quy tắc: Sáp số lớn hơn THẮNG Sáp số nhỏ hơn! (Sáp A = 14 > Sáp K = 13 > ... > Sáp 2 = 2)
  if (ranks[0] !== '0' && ranks[0] === ranks[1] && ranks[1] === ranks[2]) {
    const power = getRankPower(ranks[0]);
    const display = getRankDisplay(ranks[0]);
    return {
      type: 'sap',
      label: `Bộ Ba (${display}) 👑`,
      // Base score 10,000 + power đảm bảo Sáp luôn thắng mọi Liêng, và Sáp to thắng Sáp nhỏ
      score: 10000 + power,
      highlightClass: 'bg-gradient-to-r from-amber-500 to-yellow-400 text-slate-950 font-black shadow-lg shadow-amber-500/30 border-amber-300 animate-pulse'
    };
  }

  // 2. Kiểm tra Chuỗi liên tiếp (Liêng / 3 số liên tiếp)
  // Quy tắc: Chuỗi lớn hơn THẮNG Chuỗi nhỏ hơn!
  // Thứ tự: Q-K-A (cao nhất = 14) > J-Q-K (13) > 10-J-Q (12) > ... > 7-8-9 (9) > 4-5-6 (6) > A-2-3 (nhỏ nhất = 3)
  const rankOrderMap: { [k: string]: number } = {
    '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
    '11': 11, '12': 12, '13': 13, A: 1, J: 11, Q: 12, K: 13
  };
  const orderNums = ranks.map((r) => rankOrderMap[r] || 0).sort((a, b) => a - b);

  let isLieng = false;
  let liengPower = 0;
  let liengLabel = '';

  if (orderNums[0] > 0 && orderNums[1] > 0 && orderNums[2] > 0) {
    // Chuỗi cao nhất: 12-13-1 (Q-K-A) -> Quân kết thúc là Át (power = 14)
    if (orderNums[0] === 1 && orderNums[1] === 12 && orderNums[2] === 13) {
      isLieng = true;
      liengPower = 14;
      liengLabel = 'Chuỗi Cao (Q-K-A) ⭐';
    }
    // Chuỗi thấp nhất: 1-2-3 (A-2-3) -> Quân kết thúc là 3 (power = 3)
    else if (orderNums[0] === 1 && orderNums[1] === 2 && orderNums[2] === 3) {
      isLieng = true;
      liengPower = 3;
      liengLabel = 'Chuỗi (A-2-3)';
    }
    // Chuỗi liên tiếp thông thường: 2-3-4, 4-5-6, 7-8-9, ..., 11-12-13 (J-Q-K)
    else if (orderNums[0] + 1 === orderNums[1] && orderNums[1] + 1 === orderNums[2]) {
      isLieng = true;
      liengPower = orderNums[2]; // 4..13
      const d0 = getRankDisplay(orderNums[0].toString());
      const d1 = getRankDisplay(orderNums[1].toString());
      const d2 = getRankDisplay(orderNums[2].toString());
      liengLabel = `Chuỗi (${d0}-${d1}-${d2})`;
    }
  }

  if (isLieng) {
    return {
      type: 'lieng',
      label: liengLabel,
      // Base score 5,000 + liengPower đảm bảo:
      // Chuỗi 7-8-9 (5009) > Chuỗi 4-5-6 (5006)
      // Chuỗi Q-K-A (5014) > Chuỗi J-Q-K (5013)
      score: 5000 + liengPower,
      highlightClass: 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-black shadow-md shadow-indigo-500/30 border-indigo-400'
    };
  }

  // 3. Kiểm tra Nhóm Cao (Ba Tây / cả 3 mục đều là J, Q, K / 11, 12, 13)
  const is3Tay = ranks.every((r) => r === '11' || r === '12' || r === '13' || r === 'J' || r === 'Q' || r === 'K');
  if (is3Tay) {
    const tayPowers = ranks.map(getRankPower).sort((a, b) => a - b);
    return {
      type: '3tay',
      label: 'Nhóm Cao (11-13) ✨',
      // Base score 1,000 + phân cấp theo quân cao nhất
      score: 1000 + tayPowers[2] * 20 + tayPowers[1],
      highlightClass: 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 font-bold'
    };
  }

  // 4. Tính điểm thường: tổng điểm mod 10
  // Nếu bằng điểm nhau, nhóm có quân bài lớn nhất (A=14, K=13..2) sẽ THẮNG!
  const sum = parsed.reduce((acc, p) => acc + p.value, 0);
  const mod10 = sum % 10;
  const sortedPowers = ranks.map(getRankPower).sort((a, b) => a - b);
  const maxPower = sortedPowers[2] || 0;
  const midPower = sortedPowers[1] || 0;
  const minPower = sortedPowers[0] || 0;
  // mod10 quyết định điểm chính (0..9); quân bài cao nhất phá vỡ hòa điểm
  const normalScore = mod10 * 100 + maxPower + (midPower / 20) + (minPower / 400);

  return {
    type: 'points',
    label: mod10 === 0 ? '0 Điểm' : `${mod10} Điểm`,
    score: normalScore,
    highlightClass:
      mod10 >= 8
        ? 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 font-bold'
        : mod10 >= 5
        ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 font-bold'
        : 'bg-slate-800/80 text-slate-400 border border-white/10'
  };
}

// Tính kết quả Chế độ 2 Mục
export function evaluate2Cards(cards: DataEntry[], isDan?: boolean): {
  status: 'empty' | 'partial' | 'xibang' | 'xilat' | 'ngulinh' | 'quac' | 'points' | 'non';
  label: string;
  total: number;
  highlightClass: string;
} {
  if (cards.length === 0) {
    return { status: 'empty', label: 'Chờ nhập (0 mục)', total: 0, highlightClass: 'text-slate-500 bg-slate-900/60 border-white/5' };
  }
  if (cards.length === 1) {
    const p = parseCard(cards[0].cardValue);
    return {
      status: 'partial',
      label: `Chờ nhập (1/2 mục)`,
      total: p.value,
      highlightClass: 'text-slate-400 bg-slate-900/80 border-slate-700/60'
    };
  }

  const parsed = cards.map((c) => parseCard(c.cardValue));
  const count = cards.length;
  const danSuffix = isDan ? ' • Đã Khóa' : '';

  // TRƯỜNG HỢP 1: Đúng 2 mục ban đầu
  if (count === 2) {
    const aceCount = parsed.filter((p) => p.rank === '1' || p.rank === 'A').length;

    // 2 mục 1: Cặp 1-1 Đặc Biệt
    if (aceCount === 2) {
      return {
        status: 'xibang',
        label: `Cặp 1-1 Đặc Biệt 👑${danSuffix}`,
        total: 21,
        highlightClass: 'bg-gradient-to-r from-amber-500 via-yellow-400 to-amber-600 text-slate-950 font-black shadow-lg shadow-amber-500/40 border-amber-300'
      };
    }

    // 1 mục 1 + 1 mục 10/11/12/13: Chuẩn 21đ
    const hasFaceOrTen = parsed.some((p) => p.rank === '10' || p.rank === '11' || p.rank === '12' || p.rank === '13' || p.rank === 'J' || p.rank === 'Q' || p.rank === 'K');
    if (aceCount === 1 && hasFaceOrTen) {
      return {
        status: 'xilat',
        label: `Chuẩn 21đ 🔥${danSuffix}`,
        total: 21,
        highlightClass: 'bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950 font-black shadow-lg shadow-emerald-500/40 border-emerald-300'
      };
    }

    // 1 mục 1 + 1 số thường: 1 tính linh hoạt 11, 10 hoặc 1
    if (aceCount === 1) {
      const other = parsed.find((p) => p.rank !== '1' && p.rank !== 'A')?.value || 0;
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
          label: `${best} Điểm (Dưới 16đ)${danSuffix}`,
          total: best,
          highlightClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold'
        };
      }
    }

    // 0 mục 1: Tổng 2 mục thường
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
        label: `${total} Điểm (Dưới 16đ)${danSuffix}`,
        total,
        highlightClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold'
      };
    }
  }

  // TRƯỜNG HỢP 2: TỪ 3 MỤC TRỞ LÊN (3, 4, hoặc 5 mục)
  // Mục 1 chỉ tính là 1 điểm
  const total = parsed.reduce((acc, p) => {
    if (p.rank === '1' || p.rank === 'A') return acc + 1;
    return acc + p.value;
  }, 0);

  // Chu kỳ 5 mục mà tổng <= 21
  if (count === 5 && total <= 21) {
    return {
      status: 'ngulinh',
      label: `Chu Kỳ Tối Đa 5 Mục 🌟 (${total}đ)${danSuffix}`,
      total,
      highlightClass: 'bg-gradient-to-r from-purple-600 to-indigo-500 text-white font-black shadow-lg shadow-purple-500/40 border-purple-400'
    };
  }

  // Vượt mức (Tổng > 21)
  if (total > 21) {
    return {
      status: 'quac',
      label: `Vượt Ngưỡng (${total}đ)`,
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

  // Dưới 16đ
  return {
    status: 'non',
    label: `${total} Điểm (Dưới 16đ)${danSuffix}`,
    total,
    highlightClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold'
  };
}

export interface VersusDetail {
  groupNum: number;
  name: string;
  label: string;
}

export interface GroupAnswerItem {
  groupNum: number;
  name: string;
  items: DataEntry[];
  label: string;
  highlightClass: string;
  isWinner: boolean;
  score: number;
  isStoodPat: boolean;
  isComplete: boolean;
  rank: number | null;
  winsCount: number;
  lossesCount: number;
  tiesCount: number;
  totalCompared: number;
  rankBadgeText: string;
  rankBadgeClass: string;
  wonAgainst: VersusDetail[];
  lostAgainst: VersusDetail[];
  tiedWith: VersusDetail[];
  vsDealerResult?: 'win' | 'loss' | 'tie' | null;
}

// Hàm tính toán đáp án và ĐỐI CHIẾU TẤT CẢ CÁC NHÓM VỚI NHAU (Cross-Check & Leaderboard)
export function computeAllGroupAnswers(
  entries: DataEntry[],
  numGroups: number,
  gameMode: GameMode,
  groupNames: { [groupIndex: number]: string } = {},
  danGroups: { [groupIndex: number]: boolean } = {}
): {
  answers: GroupAnswerItem[];
  winnerGroupNum: number | null;
  leaderboardText: string;
  completeGroupsCount: number;
  sortedComplete: GroupAnswerItem[];
} {
  const grouped: { [key: number]: DataEntry[] } = {};
  for (let i = 1; i <= numGroups; i++) {
    grouped[i] = [];
  }
  entries.forEach((e) => {
    if (grouped[e.groupIndex]) {
      grouped[e.groupIndex].push(e);
    }
  });

  const tempAnswers: {
    groupNum: number;
    name: string;
    items: DataEntry[];
    label: string;
    highlightClass: string;
    score: number;
    isStoodPat: boolean;
    isComplete: boolean;
  }[] = [];

  for (let g = 1; g <= numGroups; g++) {
    const items = grouped[g] || [];
    const isStoodPat = danGroups[g] || false;
    let label = '';
    let highlightClass = '';
    let scoreForRank = -1;
    let isComplete = false;

    if (gameMode === '3cards') {
      const res = evaluate3Cards(items);
      label = res.label;
      highlightClass = res.highlightClass;
      if (items.length >= 3) {
        scoreForRank = res.score;
        isComplete = true;
      }
    } else {
      const res = evaluate2Cards(items, isStoodPat);
      label = res.label;
      highlightClass = res.highlightClass;
      if (items.length >= 2) {
        isComplete = true;
        if (res.status === 'xibang') scoreForRank = 5000 + 21;
        else if (res.status === 'xilat') scoreForRank = 4000;
        else if (res.status === 'ngulinh') scoreForRank = 3000 + (21 - res.total);
        else if (res.status === 'points') scoreForRank = 2000 + res.total;
        else if (res.status === 'non') scoreForRank = 1000 + res.total;
        else if (res.status === 'quac') scoreForRank = Math.max(0, 35 - res.total);
      }
    }

    tempAnswers.push({
      groupNum: g,
      name: groupNames[g] || `Nhóm ${g}`,
      items,
      label,
      highlightClass,
      score: scoreForRank,
      isStoodPat,
      isComplete
    });
  }

  // 1. Lọc các nhóm đã hoàn thành bài để đối chiếu
  const completeList = tempAnswers.filter((a) => a.isComplete && a.score >= 0);
  const completeGroupsCount = completeList.length;

  // 2. Đối chiếu trực tiếp từng cặp nhóm (Head-to-head Cross-Check chi tiết)
  const headToHead: {
    [groupNum: number]: {
      wins: number;
      losses: number;
      ties: number;
      wonAgainst: VersusDetail[];
      lostAgainst: VersusDetail[];
      tiedWith: VersusDetail[];
    };
  } = {};
  for (let g = 1; g <= numGroups; g++) {
    headToHead[g] = { wins: 0, losses: 0, ties: 0, wonAgainst: [], lostAgainst: [], tiedWith: [] };
  }

  for (let i = 0; i < completeList.length; i++) {
    for (let j = i + 1; j < completeList.length; j++) {
      const a = completeList[i];
      const b = completeList[j];
      const diff = a.score - b.score;
      if (Math.abs(diff) < 0.0001) {
        headToHead[a.groupNum].ties++;
        headToHead[b.groupNum].ties++;
        headToHead[a.groupNum].tiedWith.push({ groupNum: b.groupNum, name: b.name, label: b.label });
        headToHead[b.groupNum].tiedWith.push({ groupNum: a.groupNum, name: a.name, label: a.label });
      } else if (diff > 0) {
        headToHead[a.groupNum].wins++;
        headToHead[b.groupNum].losses++;
        headToHead[a.groupNum].wonAgainst.push({ groupNum: b.groupNum, name: b.name, label: b.label });
        headToHead[b.groupNum].lostAgainst.push({ groupNum: a.groupNum, name: a.name, label: a.label });
      } else {
        headToHead[a.groupNum].losses++;
        headToHead[b.groupNum].wins++;
        headToHead[a.groupNum].lostAgainst.push({ groupNum: b.groupNum, name: b.name, label: b.label });
        headToHead[b.groupNum].wonAgainst.push({ groupNum: a.groupNum, name: a.name, label: a.label });
      }
    }
  }

  // 3. Xếp hạng đối chiếu toàn cục từ cao xuống thấp (Hạng 1, 2, 3...)
  const sortedComplete = [...completeList].sort((a, b) => b.score - a.score);
  const ranksMap: { [groupNum: number]: number } = {};
  let currentRank = 1;
  for (let i = 0; i < sortedComplete.length; i++) {
    if (i > 0 && Math.abs(sortedComplete[i].score - sortedComplete[i - 1].score) >= 0.0001) {
      currentRank = i + 1;
    }
    ranksMap[sortedComplete[i].groupNum] = currentRank;
  }

  const winnerGroupNum: number | null = sortedComplete.length > 0 ? sortedComplete[0].groupNum : null;

  // Lấy kết quả của Nhóm 1 nếu có chế độ so với Nhà Cái
  const group1Item = completeList.find((g) => g.groupNum === 1);

  const answers: GroupAnswerItem[] = tempAnswers.map((a) => {
    const isComplete = a.isComplete && a.score >= 0;
    const r = isComplete ? ranksMap[a.groupNum] : null;
    const isWinner = r === 1;
    const wins = headToHead[a.groupNum]?.wins || 0;
    const losses = headToHead[a.groupNum]?.losses || 0;
    const ties = headToHead[a.groupNum]?.ties || 0;
    const wonAgainst = headToHead[a.groupNum]?.wonAgainst || [];
    const lostAgainst = headToHead[a.groupNum]?.lostAgainst || [];
    const tiedWith = headToHead[a.groupNum]?.tiedWith || [];
    const totalCompared = Math.max(0, completeGroupsCount - 1);

    let rankBadgeText = '';
    let rankBadgeClass = '';

    if (r === 1) {
      rankBadgeText = '👑 Hạng 1 (Thắng)';
      rankBadgeClass = 'bg-amber-400 text-slate-950 font-black shadow-md shadow-amber-400/30 border border-amber-300 ring-1 ring-amber-400/50';
    } else if (r === 2) {
      rankBadgeText = '🥈 Hạng 2';
      rankBadgeClass = 'bg-slate-200 text-slate-950 font-bold border border-slate-100 shadow-sm';
    } else if (r === 3) {
      rankBadgeText = '🥉 Hạng 3';
      rankBadgeClass = 'bg-amber-700/85 text-amber-100 font-bold border border-amber-600/70 shadow-sm';
    } else if (r !== null && r >= 4) {
      rankBadgeText = `Hạng ${r}`;
      rankBadgeClass = 'bg-slate-800 text-slate-300 border border-white/15 font-semibold';
    }

    // So riêng với Nhà Cái (Nhóm 1)
    let vsDealerResult: 'win' | 'loss' | 'tie' | null = null;
    if (a.groupNum !== 1 && group1Item && isComplete) {
      const diff = a.score - group1Item.score;
      if (Math.abs(diff) < 0.0001) vsDealerResult = 'tie';
      else if (diff > 0) vsDealerResult = 'win';
      else vsDealerResult = 'loss';
    }

    return {
      ...a,
      isWinner,
      isComplete,
      rank: r,
      winsCount: wins,
      lossesCount: losses,
      tiesCount: ties,
      wonAgainst,
      lostAgainst,
      tiedWith,
      totalCompared,
      rankBadgeText,
      rankBadgeClass,
      vsDealerResult
    };
  });

  const sortedCompleteAnswers = answers
    .filter((a) => a.rank !== null)
    .sort((a, b) => (a.rank || 999) - (b.rank || 999));

  const leaderboardText = sortedCompleteAnswers
    .map((g) => {
      const icon = g.rank === 1 ? '👑 ' : g.rank === 2 ? '🥈 ' : g.rank === 3 ? '🥉 ' : '';
      return `${icon}${g.name} (Hạng ${g.rank} • ${g.label})`;
    })
    .join('  >  ');

  return {
    answers,
    winnerGroupNum,
    leaderboardText,
    completeGroupsCount,
    sortedComplete: sortedCompleteAnswers
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

  // Modal Bảng Ma Trận Đối Chiếu Chi Tiết Toàn Bộ Các Nhóm
  const [showMatrixModal, setShowMatrixModal] = useState(false);
  // Chế độ đối chiếu: 'free' (Đối kháng tự do tất cả các nhóm) | 'dealer' (Nhóm 1 làm Nhà Cái / Chương)
  const [comparisonMode, setComparisonMode] = useState<'free' | 'dealer'>('free');

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

  // Dự đoán lượt chia vòng kế tiếp theo thứ tự tuần tự chuẩn như cũ (Round-Robin: 1 -> 2 -> 3 -> ... -> N -> 1 -> 2 -> 3...)
  const nextSequenceOrder = entries.length + 1;
  const nextGroupIndex = ((nextSequenceOrder - 1) % numGroups) + 1;
  const targetGroupAll = groupedItems[nextGroupIndex] || [];
  const maxInitialCards = gameMode === '3cards' ? 3 : 2;

  // Tính toán đáp án và ĐỐI CHIẾU XẾP HẠNG TẤT CẢ CÁC NHÓM
  const comparisonResult = useMemo(() => {
    return computeAllGroupAnswers(
      entries,
      numGroups,
      gameMode,
      groupNames,
      danGroups
    );
  }, [entries, numGroups, gameMode, groupNames, danGroups]);

  const { answers: allGroupAnswers, completeGroupsCount, sortedComplete, leaderboardText } = comparisonResult;
  const answerByGroupNum = useMemo(() => {
    const map: { [groupNum: number]: GroupAnswerItem } = {};
    allGroupAnswers.forEach((a) => {
      map[a.groupNum] = a;
    });
    return map;
  }, [allGroupAnswers]);

  // Validation Popup Modal khi nhập sai
  const [validationError, setValidationError] = useState<string | null>(null);

  // Floating Draggable Card Picker Popup (Popup nổi kéo thả 52 lá bài - mặc định luôn mở sẵn)
  const [isCardPickerOpen, setIsCardPickerOpen] = useState(true);
  const [cardPickerTarget, setCardPickerTarget] = useState<CardPickerTarget>({
    mode: 'add',
    groupNum: 1
  });

  // Tự động đồng bộ nhóm mục tiêu khi đang ở chế độ chia vòng
  React.useEffect(() => {
    if (cardPickerTarget.mode === 'add') {
      setCardPickerTarget((prev) => ({
        ...prev,
        groupNum: nextGroupIndex
      }));
    }
  }, [nextGroupIndex]);

  // Xử lý chọn lá bài từ CardPickerPopup
  const handleSelectCardFromPicker = (cardValue: string, targetGroup: number, editCardId?: string) => {
    if (cardPickerTarget.mode === 'edit' && editCardId && onEditCard) {
      onEditCard(editCardId, cardValue);
      showToast(`🃏 Đã đổi thành "${cardValue}"`);
      // Sau khi sửa xong, chuyển lại mode 'add' để chia tiếp theo vòng
      setCardPickerTarget({
        mode: 'add',
        groupNum: nextGroupIndex
      });
    } else {
      // Mode add
      onAddCard(cardValue, numGroups, targetGroup);
      const gName = groupNames[targetGroup] || `Nhóm ${targetGroup}`;
      showToast(`✨ Đã gán "${cardValue}" vào ${gName}`);

      // Tự động chuyển nhóm mục tiêu sang nhóm tiếp theo theo vòng tuần tự
      const nextG = (targetGroup % numGroups) + 1;
      setCardPickerTarget({
        mode: 'add',
        groupNum: nextG
      });
    }
  };

  // Mở popup để sửa/chọn lại lá bài đã có
  const handleOpenEditCardPicker = (item: DataEntry, groupNum: number, slotIdx: number) => {
    setCardPickerTarget({
      mode: 'edit',
      groupNum,
      slotIndex: slotIdx,
      cardId: item.id,
      currentValue: item.cardValue,
      groupName: groupNames[groupNum] || `Nhóm ${groupNum}`
    });
    setIsCardPickerOpen(true);
  };

  // Mở popup để thêm lá bài cho ô trống
  const handleOpenAddCardPicker = (groupNum: number, slotIdx: number) => {
    setCardPickerTarget({
      mode: 'add',
      groupNum,
      slotIndex: slotIdx,
      groupName: groupNames[groupNum] || `Nhóm ${groupNum}`
    });
    setIsCardPickerOpen(true);
  };

  // Chia bài từ thanh input trên cùng (CHIA VÒNG TUẦN TỰ THEO THỨ TỰ NHƯ CŨ, KHÔNG DỒN VÀO 1 NHÓM)
  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const rawManual = manualInput.trim();

    if (rawManual) {
      // 1. Chia vòng tuần tự chuẩn như cũ: KHÔNG truyền targetGroup để các lá bài được chia đều vào từng nhóm 1, 2, 3...
      const check = isValidCardValue(rawManual);
      if (!check.isValid) {
        setValidationError(check.error || 'Giá trị không hợp lệ!');
        return;
      }
      onAddCard(check.normalizedRank, numGroups);
      showToast(`✨ Đã ghi nhận mã "${check.normalizedRank}"`);
      setManualInput('');
      return;
    }

    // 2. Nếu ô trên cùng trống, kiểm tra xem người dùng có gõ số vào ô Điền của nhóm nào không
    const foundGroupKey = Object.keys(groupBotInputs).find(
      (k) => (groupBotInputs[Number(k)] || '').trim() !== ''
    );

    if (foundGroupKey) {
      const gNum = Number(foundGroupKey);
      const rawVal = groupBotInputs[gNum].trim();
      const check = isValidCardValue(rawVal);
      if (!check.isValid) {
        setValidationError(check.error || 'Giá trị không hợp lệ!');
        return;
      }
      onAddCard(check.normalizedRank, numGroups, gNum);
      const gName = groupNames[gNum] || `Nhóm ${gNum}`;
      showToast(`✨ Đã thêm "${check.normalizedRank}" vào ${gName}`);
      setGroupBotInputs((prev) => ({ ...prev, [gNum]: '' }));
      return;
    }

    setValidationError('Vui lòng nhập giá trị trước khi ghi nhận!');
  };

  // Thao tác Thêm riêng cho từng nhóm
  const handleBotSubmit = (groupNum: number) => {
    const raw = (groupBotInputs[groupNum] || '').trim() || manualInput.trim();
    const gName = groupNames[groupNum] || `Nhóm ${groupNum}`;
    const allItemsInGroup = groupedItems[groupNum] || [];
    const minSlots = gameMode === '3cards' ? 3 : 2;
    const isBot = allItemsInGroup.length >= minSlots;

    if (!raw) {
      setValidationError(`Vui lòng nhập giá trị vào ${gName}!`);
      return;
    }
    const check = isValidCardValue(raw);
    if (!check.isValid) {
      setValidationError(check.error || 'Giá trị không hợp lệ!');
      return;
    }
    onAddCard(check.normalizedRank, numGroups, groupNum);
    showToast(`✨ Đã thêm "${check.normalizedRank}" vào ${gName}`);
    setGroupBotInputs((prev) => ({ ...prev, [groupNum]: '' }));
    if (raw === manualInput.trim()) {
      setManualInput('');
    }
  };

  // Toggle trạng thái Khóa của nhóm
  const toggleDanGroup = (groupNum: number) => {
    const nextState = !danGroups[groupNum];
    setDanGroups((prev) => ({ ...prev, [groupNum]: nextState }));
    const gName = groupNames[groupNum] || `Nhóm ${groupNum}`;
    showToast(nextState ? `🛡️ ${gName} đã KHÓA` : `🔓 ${gName} mở khóa`);
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

  // Lưu sửa mục dữ liệu
  const handleSaveEditCard = () => {
    if (!selectedCardForEdit || !onEditCard) return;
    const raw = editCardValue.trim();
    if (!raw) {
      setValidationError('Vui lòng nhập giá trị mới!');
      return;
    }
    const check = isValidCardValue(raw);
    if (!check.isValid) {
      setValidationError(check.error || 'Giá trị không hợp lệ!');
      return;
    }
    onEditCard(selectedCardForEdit.id, check.normalizedRank);
    showToast(`✏️ Đã sửa thành "${check.normalizedRank}"`);
    setSelectedCardForEdit(null);
  };

  // Xóa mục dữ liệu
  const handleDeleteCurrentCard = () => {
    if (selectedCardForEdit && onDeleteCard) {
      onDeleteCard(selectedCardForEdit.id);
      showToast(`🗑️ Đã xóa mục`);
      setSelectedCardForEdit(null);
    }
  };

  // Mở popup xác nhận xóa tất cả dữ liệu
  const handleRequestClearCards = () => {
    setConfirmModal({
      isOpen: true,
      title: 'Xóa Dữ Liệu Hiện Tại?',
      message: 'Bạn có chắc chắn muốn xóa toàn bộ các mục dữ liệu đã phân nhóm không?',
      confirmText: 'Xác Nhận Xóa',
      confirmColor: 'red',
      onConfirm: () => {
        onClearCards();
        showToast('🗑️ Đã xóa sạch dữ liệu');
        setConfirmModal(null);
      }
    });
  };

  // Xong phiên: Xóa sạch toàn bộ dữ liệu bài, reset khóa nhóm, reset input, không lưu lại gì
  const handleRequestFinishRound = () => {
    if (entries.length === 0) {
      // Nếu chưa có dữ liệu gì thì chỉ cần reset trạng thái phụ
      setDanGroups({});
      setGroupBotInputs({});
      setManualInput('');
      setCardPickerTarget({ mode: 'add', groupNum: 1 });
      showToast('✨ Phiên hiện tại đang trống');
      return;
    }

    setConfirmModal({
      isOpen: true,
      title: 'Xong Phiên & Xóa Hết Dữ Liệu?',
      message: 'Toàn bộ dữ liệu của phiên này sẽ được xóa sạch để bắt đầu phiên mới, không lưu lại gì.',
      confirmText: 'Xong Phiên (Xóa Hết)',
      confirmColor: 'emerald',
      onConfirm: () => {
        if (onFinishRound) onFinishRound();
        setDanGroups({});
        setGroupBotInputs({});
        setManualInput('');
        setCardPickerTarget({ mode: 'add', groupNum: 1 });
        showToast('✅ Đã xong phiên: Toàn bộ dữ liệu đã được xóa sạch!');
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
              {gameMode === '2cards' ? 'Chế Độ 2 Mục (M2)' : 'Chế Độ 3 Mục (M3)'}
            </span>
          </div>
        </div>

        {/* Action Buttons: Bảng Mã, Undo, Clear, Finish */}
        <div className="flex items-center space-x-1.5 flex-shrink-0">
          {/* Nút Bật/Tắt Popup Bảng Mã */}
          <button
            type="button"
            onClick={() => setIsCardPickerOpen(!isCardPickerOpen)}
            className={`px-2.5 py-1 rounded-lg text-xs font-black transition-all flex items-center space-x-1 border active:scale-95 shadow-sm ${
              isCardPickerOpen
                ? 'bg-amber-400 text-slate-950 border-amber-300 ring-1 ring-amber-400 shadow-amber-500/20'
                : 'bg-slate-800/90 text-amber-300 hover:text-amber-200 border-amber-500/30 hover:bg-slate-750'
            }`}
            title="Bật / Tắt Bảng Nhập Mã Kéo Thả"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            <span>Bảng Mã</span>
          </button>

          {/* Undo Button */}
          {onUndoCard && entries.length > 0 && (
            <button
              onClick={() => {
                onUndoCard();
                showToast('↩️ Đã hoàn tác mục vừa nhập');
              }}
              className="p-1.5 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-amber-300 border border-white/10 text-xs font-medium transition-all active:scale-95"
              title="Hoàn tác: Xóa mục vừa nhập"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Clear Button (Popup Modal) */}
          <button
            type="button"
            onClick={handleRequestClearCards}
            className="p-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 text-xs font-medium transition-all active:scale-95"
            title="Xóa toàn bộ dữ liệu hiện tại"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          {/* Finish Round Button (Popup Modal) */}
          {onFinishRound && (
            <button
              type="button"
              onClick={handleRequestFinishRound}
              className="px-2 py-1 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold transition-all flex items-center space-x-1 active:scale-95"
              title="Lưu trữ và bắt đầu chu kỳ dữ liệu mới"
            >
              <CheckCircle2 className="w-3 h-3" />
              <span>Lưu Chu Kỳ</span>
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
            <span>Chế Độ 3 Mục (M3)</span>
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
            <span>Chế Độ 2 Mục (M2)</span>
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
        {/* Nút bật Popup Bảng Mã trực quan */}
        <button
          type="button"
          onClick={() => {
            setCardPickerTarget({
              mode: 'add',
              groupNum: nextGroupIndex
            });
            setIsCardPickerOpen(true);
          }}
          className="px-2.5 py-1.5 rounded-lg font-bold text-xs flex items-center space-x-1 shadow transition-all active:scale-95 flex-shrink-0 bg-indigo-600 hover:bg-indigo-500 text-white border border-indigo-400/40"
          title="Mở bảng chọn số (1-13)"
        >
          <LayoutGrid className="w-3.5 h-3.5 text-amber-300" />
          <span>Bảng Số</span>
        </button>

        <div className="flex-1 flex items-center space-x-1.5 pl-1.5 min-w-0">
          <input
            type="text"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            placeholder="Hoặc gõ số: 1, 2, 8, 9, 10, 11, 12, 13..."
            className="w-full bg-transparent text-white font-mono text-xs focus:outline-none placeholder:text-slate-500 truncate"
          />
        </div>

        <button
          type="submit"
          className="px-3 py-1.5 rounded-lg font-bold text-xs flex items-center space-x-1 shadow transition-all active:scale-95 flex-shrink-0 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white"
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-300" />
          <span className="hidden xs:inline">Ghi Nhận</span>
          <span className="xs:hidden">Ghi</span>
        </button>

        {/* Next Target Badge */}
        <div className="flex items-center space-x-1 pl-1.5 pr-0.5 border-l border-white/10 text-[11px] flex-shrink-0 font-mono">
          <span className="text-slate-400 text-[10px] hidden sm:inline">Kế tiếp:</span>
          <span className="px-1.5 py-0.5 rounded font-bold border text-[10px] sm:text-[11px] flex items-center space-x-1 bg-indigo-600/40 text-indigo-200 border-indigo-500/40">
            <span>N{nextGroupIndex}</span>
            <span className="text-[9px] font-normal opacity-90">
              (Mục {targetGroupAll.length + 1}/{maxInitialCards})
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

      {/* BANNER BẢNG ĐỐI CHIẾU XẾP HẠNG TẤT CẢ CÁC NHÓM */}
      {completeGroupsCount > 1 && (
        <div className="p-2.5 sm:p-3 rounded-2xl bg-gradient-to-r from-indigo-950/80 via-slate-900 to-indigo-950/80 border border-indigo-500/40 shadow-lg shadow-indigo-950/40 flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 animate-fadeIn">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center space-x-2 flex-shrink-0">
              <div className="w-8 h-8 rounded-xl bg-amber-500/20 border border-amber-400/40 flex items-center justify-center text-amber-400 font-bold text-base shadow-inner">
                👑
              </div>
              <div>
                <div className="text-xs font-black text-amber-300 uppercase tracking-wider flex items-center space-x-1.5">
                  <span>BẢNG ĐỐI CHIẾU XẾP HẠNG ({gameMode === '3cards' ? '3 Lá' : '2 Lá'})</span>
                </div>
                <p className="text-[10px] text-slate-400">Đã đối chiếu chéo tất cả {completeGroupsCount}/{numGroups} nhóm theo thực lực</p>
              </div>
            </div>

            {/* Nút Mở Bảng Ma Trận Chi Tiết (Hiển thị trên mobile) */}
            <button
              type="button"
              onClick={() => setShowMatrixModal(true)}
              className="lg:hidden px-2.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center space-x-1.5 border border-indigo-400/50 shadow-md shadow-indigo-600/30 transition-all active:scale-95 flex-shrink-0"
              title="Xem Bảng Ma Trận Đối Chiếu Chi Tiết 3 - 8 Nhóm"
            >
              <Swords className="w-3.5 h-3.5 text-amber-300" />
              <span>Đối Chiếu Chi Tiết</span>
            </button>
          </div>

          <div className="flex items-center space-x-2 overflow-x-auto no-scrollbar py-0.5">
            {/* Nút Mở Bảng Ma Trận Chi Tiết (Hiển thị trên desktop) */}
            <button
              type="button"
              onClick={() => setShowMatrixModal(true)}
              className="hidden lg:flex px-2.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs items-center space-x-1.5 border border-indigo-400/50 shadow-md shadow-indigo-600/30 transition-all active:scale-95 flex-shrink-0"
              title="Xem Bảng Ma Trận Đối Chiếu Chi Tiết 3 - 8 Nhóm"
            >
              <Swords className="w-3.5 h-3.5 text-amber-300" />
              <span>Đối Chiếu Chi Tiết</span>
            </button>

            {/* Dây chuyền đối chiếu thứ hạng từ cao xuống thấp */}
            <div className="flex items-center space-x-1.5 overflow-x-auto no-scrollbar text-xs font-mono font-bold">
              {sortedComplete.map((item, sIdx) => {
                const r = item.rank;
                return (
                  <React.Fragment key={item.groupNum}>
                    {sIdx > 0 && <span className="text-slate-500 px-0.5 font-sans font-black select-none">&gt;</span>}
                    <div
                      className={`px-2 py-1 rounded-xl border flex items-center space-x-1.5 flex-shrink-0 cursor-default transition-all ${
                        r === 1
                          ? 'bg-amber-400 text-slate-950 border-amber-300 shadow-md shadow-amber-400/20 font-black'
                          : r === 2
                          ? 'bg-slate-200 text-slate-900 border-slate-100 font-bold'
                          : r === 3
                          ? 'bg-amber-700/85 text-amber-100 border-amber-600/70 font-bold'
                          : 'bg-slate-800/90 text-slate-300 border-white/10'
                      }`}
                      title={`Thắng ${item.winsCount}/${item.totalCompared} nhóm khác`}
                    >
                      <span>{r === 1 ? '👑' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`}</span>
                      <span>{item.name}:</span>
                      <span className="opacity-90">{item.label}</span>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </div>
      )}

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
          const isNextTarget = groupNum === nextGroupIndex;
          const isStoodPat = danGroups[groupNum] || false;
          const ansItem = answerByGroupNum[groupNum];

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
              className={`rounded-2xl p-2.5 sm:p-3 transition-all border flex flex-col justify-between shadow-md relative overflow-hidden ${
                ansItem?.isWinner
                  ? 'bg-amber-500/10 border-amber-400/80 ring-2 ring-amber-400/40 shadow-amber-500/10'
                  : isStoodPat
                  ? 'bg-slate-900/90 border-emerald-500/40 ring-1 ring-emerald-500/30'
                  : isNextTarget
                  ? 'bg-indigo-950/45 border-indigo-500 shadow-indigo-500/20 ring-2 ring-indigo-500/60'
                  : 'bg-slate-900/70 border-white/5 hover:border-white/15'
              }`}
            >
              <div>
                {/* Group Header: [Number] [Name / Inline Edit] [Rank Badge] [Count] */}
                <div className="flex items-center justify-between border-b border-white/10 pb-2 mb-2">
                  <div className="flex items-center space-x-1.5 min-w-0 flex-1 mr-1">
                    <span
                      className={`w-5 h-5 rounded-lg flex items-center justify-center font-bold text-[11px] flex-shrink-0 ${
                        ansItem?.isWinner
                          ? 'bg-amber-400 text-slate-950 font-black shadow-sm'
                          : isNextTarget
                          ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/40'
                          : 'bg-slate-800 text-slate-300'
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

                    {/* Huy hiệu thứ hạng đối chiếu */}
                    {ansItem && ansItem.rank && (
                      <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-mono whitespace-nowrap flex items-center space-x-0.5 flex-shrink-0 ${ansItem.rankBadgeClass}`}>
                        <span>{ansItem.rankBadgeText}</span>
                      </span>
                    )}
                  </div>

                  {/* Item count tag */}
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded border bg-slate-800/90 text-slate-400 border-white/5 flex-shrink-0">
                    {allItemsInGroup.length} mục
                  </span>
                </div>

                {/* List of Items: Mục hiển thị đầy đủ */}
                <div className="space-y-1.5 py-0.5 min-h-[64px]">
                  {Array.from({ length: slotCount }).map((_, slotIdx) => {
                    const item = allItemsInGroup[slotIdx];
                    if (item) {
                      const p = parseCard(item.cardValue);
                      const isUnknown = item.cardValue === '0' || item.cardValue.includes('Không thấy') || item.cardValue.includes('Không rõ') || item.cardValue === '?';
                      return (
                        <div
                          key={item.id || slotIdx}
                          onClick={() => handleOpenEditCardPicker(item, groupNum, slotIdx)}
                          className="flex items-center justify-between px-2 py-1.5 rounded-xl bg-slate-800/90 border border-white/10 hover:border-amber-400/60 hover:bg-slate-800 cursor-pointer transition-all text-xs group shadow-sm"
                          title="Bấm vào mục để sửa hoặc xóa"
                        >
                          <div className="flex items-center space-x-1.5 min-w-0">
                            <span className="text-[10px] font-mono text-slate-400 w-4">
                              #{slotIdx + 1}
                            </span>

                            {isUnknown ? (
                              <span className="px-1.5 py-0.5 rounded-md bg-amber-500/20 text-amber-300 font-bold border border-amber-500/40 text-[11px] flex items-center space-x-1">
                                <EyeOff className="w-3 h-3 text-amber-400" />
                                <span>0 (Không thấy)</span>
                              </span>
                            ) : (
                              <span
                                className="font-black font-mono text-sm tracking-wide truncate group-hover:text-amber-300 text-white"
                              >
                                {item.cardValue}
                              </span>
                            )}

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
                          onClick={() => handleOpenAddCardPicker(groupNum, slotIdx)}
                          className="flex items-center justify-center py-2 rounded-xl border border-dashed border-white/10 hover:border-amber-400/50 hover:bg-slate-800/40 text-[11px] text-slate-500 hover:text-amber-300 font-mono select-none cursor-pointer transition-all"
                          title="Bấm để mở bảng mã chọn cho ô này"
                        >
                          + Mục {slotIdx + 1} (Chọn)
                        </div>
                      );
                    }
                  })}
                </div>
              </div>

              {/* Action Bar riêng cho từng nhóm */}
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
                    onChange={(e) =>
                      setGroupBotInputs((prev) => ({ ...prev, [groupNum]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleBotSubmit(groupNum);
                      }
                    }}
                    placeholder="8, 9, 10, 11..."
                    className="w-full bg-transparent text-white font-mono text-xs focus:outline-none min-w-0 placeholder:text-slate-600"
                  />
                </div>

                {/* Hàng 2: Hai nút cân đối 50-50 (+ Nhập/Thêm & Khóa) */}
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleBotSubmit(groupNum)}
                    className="w-full py-1.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-black text-xs flex items-center justify-center space-x-1 shadow-sm transition-all active:scale-95"
                    title={
                      allItemsInGroup.length < minSlots
                        ? `Ghi nhận mục vào ${customName}`
                        : `Thêm mục vào ${customName}`
                    }
                  >
                    <Plus className="w-3.5 h-3.5 stroke-[3]" />
                    <span>{allItemsInGroup.length < minSlots ? 'Nhập' : '+ Thêm'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => toggleDanGroup(groupNum)}
                    className={`w-full py-1.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1 active:scale-95 ${
                      isStoodPat
                        ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/30 font-black'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-white/10'
                    }`}
                    title="Khóa nhóm này (không nhận thêm mục mới)"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>{isStoodPat ? 'Đã Khóa' : 'Khóa'}</span>
                  </button>
                </div>

                {/* Hàng 3: Kết quả nhóm + Đối chiếu thắng thua chi tiết */}
                <div className="space-y-1.5 pt-0.5">
                  <div
                    className={`w-full py-1.5 px-2 rounded-xl text-xs font-mono font-bold text-center border transition-all ${evalResult.highlightClass}`}
                  >
                    {evalResult.label}
                  </div>

                  {ansItem && ansItem.isComplete && completeGroupsCount > 1 && (
                    <div className="space-y-1 pt-1 text-[10px] font-mono">
                      {/* Tóm tắt Thắng/Thua/Hòa & Nút mở ma trận */}
                      <div
                        onClick={() => setShowMatrixModal(true)}
                        className="flex items-center justify-between px-1.5 py-1 rounded-lg bg-slate-950/60 border border-white/5 hover:border-indigo-400/40 cursor-pointer transition-all text-slate-400 hover:text-slate-200"
                        title="Bấm để xem Bảng Ma Trận Đối Chiếu Chi Tiết"
                      >
                        <span className="font-semibold text-slate-400 flex items-center space-x-1">
                          <Swords className="w-3 h-3 text-indigo-400" />
                          <span>Đối chiếu ({ansItem.totalCompared} nhóm):</span>
                        </span>
                        <div className="flex items-center space-x-1 font-bold">
                          <span className="text-emerald-400">{ansItem.winsCount} Thắng</span>
                          <span className="text-slate-600">/</span>
                          <span className="text-rose-400">{ansItem.lossesCount} Thua</span>
                          {ansItem.tiesCount > 0 && (
                            <>
                              <span className="text-slate-600">/</span>
                              <span className="text-amber-400">{ansItem.tiesCount} Hòa</span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Hiển thị cụ thể ĂN những nhóm nào */}
                      {ansItem.wonAgainst.length > 0 && (
                        <div className="flex items-start space-x-1 bg-emerald-950/40 border border-emerald-500/25 px-1.5 py-1 rounded-lg text-emerald-300">
                          <span className="font-bold whitespace-nowrap text-[9.5px] flex-shrink-0 text-emerald-400">✓ Ăn:</span>
                          <div className="flex flex-wrap gap-1">
                            {ansItem.wonAgainst.map((w) => (
                              <span
                                key={w.groupNum}
                                className="px-1 py-0.2 rounded bg-emerald-900/70 border border-emerald-500/40 text-[9px] font-bold text-emerald-200"
                                title={`${w.name}: ${w.label}`}
                              >
                                {w.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Hiển thị cụ thể THUA những nhóm nào */}
                      {ansItem.lostAgainst.length > 0 && (
                        <div className="flex items-start space-x-1 bg-rose-950/40 border border-rose-500/25 px-1.5 py-1 rounded-lg text-rose-300">
                          <span className="font-bold whitespace-nowrap text-[9.5px] flex-shrink-0 text-rose-400">✗ Thua:</span>
                          <div className="flex flex-wrap gap-1">
                            {ansItem.lostAgainst.map((l) => (
                              <span
                                key={l.groupNum}
                                className="px-1 py-0.2 rounded bg-rose-900/70 border border-rose-500/40 text-[9px] font-bold text-rose-200"
                                title={`${l.name}: ${l.label}`}
                              >
                                {l.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Hiển thị cụ thể HÒA những nhóm nào */}
                      {ansItem.tiedWith.length > 0 && (
                        <div className="flex items-start space-x-1 bg-amber-950/40 border border-amber-500/25 px-1.5 py-1 rounded-lg text-amber-300">
                          <span className="font-bold whitespace-nowrap text-[9.5px] flex-shrink-0 text-amber-400">= Hòa:</span>
                          <div className="flex flex-wrap gap-1">
                            {ansItem.tiedWith.map((t) => (
                              <span
                                key={t.groupNum}
                                className="px-1 py-0.2 rounded bg-amber-900/70 border border-amber-500/40 text-[9px] font-bold text-amber-200"
                                title={`${t.name}: ${t.label}`}
                              >
                                {t.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Kết quả so với Nhà Cái (Nhóm 1) nếu có */}
                      {comparisonMode === 'dealer' && groupNum !== 1 && (
                        <div className="pt-0.5 flex items-center justify-between text-[9.5px] border-t border-white/5">
                          <span className="text-slate-400">So với Nhà Cái:</span>
                          {ansItem.vsDealerResult === 'win' ? (
                            <span className="px-1.5 py-0.2 rounded bg-emerald-600/40 text-emerald-300 font-bold border border-emerald-500/40">
                              Ăn Cái (Thắng)
                            </span>
                          ) : ansItem.vsDealerResult === 'loss' ? (
                            <span className="px-1.5 py-0.2 rounded bg-rose-600/40 text-rose-300 font-bold border border-rose-500/40">
                              Thua Cái
                            </span>
                          ) : ansItem.vsDealerResult === 'tie' ? (
                            <span className="px-1.5 py-0.2 rounded bg-amber-500/40 text-amber-300 font-bold border border-amber-500/40">
                              Hòa Cái
                            </span>
                          ) : (
                            <span className="text-slate-500 italic">Chờ bài</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
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
                <h3 className="font-bold text-sm text-white">Sửa / Xóa Mục Dữ Liệu</h3>
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
                Mục hiện tại: <strong className="text-amber-300 font-mono text-sm">{selectedCardForEdit.cardValue}</strong> (Nhóm {selectedCardForEdit.groupIndex}, Lượt #{selectedCardForEdit.sequenceOrder})
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
                  placeholder="1, 2, 3, 10, 11, 12, 13, 0..."
                />
              </div>

              {/* Quick Select Buttons */}
              <div className="flex flex-wrap gap-1 pt-1">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '0'].map((c) => (
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
                    {c === '0' ? '0 (Không thấy)' : c}
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
                <span>Xóa Mục Này</span>
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
              <h3 className="text-base font-bold text-white tracking-wide">Dữ Liệu Không Hợp Lệ</h3>
              <p className="text-xs text-red-300 mt-1.5 font-medium leading-relaxed bg-red-950/40 border border-red-500/20 p-2.5 rounded-xl">
                {validationError}
              </p>
            </div>
            <div className="bg-slate-950/90 p-3 rounded-xl border border-white/10 text-xs text-slate-300 space-y-2 text-left">
              <p className="font-bold text-amber-300 flex items-center space-x-1">
                <span>💡</span>
                <span>Các số hợp lệ bao gồm (1 ➔ 13 | 0: Không thấy):</span>
              </p>
              <div className="flex flex-wrap gap-1.5 font-mono font-black text-xs">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '0'].map((c) => (
                  <span
                    key={c}
                    className="px-2 py-0.5 bg-slate-800 rounded-md border border-amber-400/30 text-amber-300 shadow-sm"
                  >
                    {c === '0' ? '0 (Không thấy)' : c}
                  </span>
                ))}
              </div>
              <p className="text-[10px] text-slate-400 italic">
                * Nhập các số từ 1..13 hoặc số 0 (Không thấy)
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

      {/* 8b. BẢNG MA TRẬN ĐỐI CHIẾU CHÉO TẤT CẢ CÁC NHÓM (CROSS-CHECK MATRIX MODAL) */}
      {showMatrixModal && (
        <div className="fixed inset-0 z-[120] bg-black/85 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 animate-fadeIn">
          <div className="bg-slate-900 border border-indigo-500/50 rounded-2xl max-w-5xl w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden ring-1 ring-indigo-400/40">
            {/* Header */}
            <div className="px-4 py-3 bg-gradient-to-r from-slate-950 via-slate-900 to-indigo-950 border-b border-indigo-500/30 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center space-x-2.5 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-amber-500/20 border border-amber-400/40 flex items-center justify-center text-amber-400 font-bold flex-shrink-0">
                  <Swords className="w-4 h-4" />
                </div>
                <div className="truncate">
                  <h3 className="font-black text-sm sm:text-base text-white flex items-center space-x-2 truncate">
                    <span>MA TRẬN ĐỐI CHIẾU CHÉO TẤT CẢ CÁC NHÓM</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-600/40 text-indigo-200 border border-indigo-400/40 font-mono flex-shrink-0">
                      {completeGroupsCount}/{numGroups} Nhóm
                    </span>
                  </h3>
                  <p className="text-[11px] text-slate-400 truncate">
                    {gameMode === '3cards'
                      ? '3 Lá: Sáp (1-1-1 cao nhất) > Liêng (12-13-1 cao nhất) > Ba Tây > Điểm thường'
                      : '2 Lá: Xì Bàng > Xì Lát > Ngũ Linh > Điểm thường'}
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2 flex-shrink-0">
                {/* Switch Mode: Đối Kháng Tất Cả vs Nhóm 1 Làm Cái */}
                <div className="hidden sm:flex items-center bg-slate-950 p-0.5 rounded-lg border border-white/10 text-[11px] font-bold">
                  <button
                    type="button"
                    onClick={() => setComparisonMode('free')}
                    className={`px-2 py-1 rounded transition-all ${
                      comparisonMode === 'free'
                        ? 'bg-indigo-600 text-white shadow'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Đối Kháng Tất Cả
                  </button>
                  <button
                    type="button"
                    onClick={() => setComparisonMode('dealer')}
                    className={`px-2 py-1 rounded transition-all ${
                      comparisonMode === 'dealer'
                        ? 'bg-amber-500 text-slate-950 font-black shadow'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Nhóm 1 Làm Cái
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setShowMatrixModal(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                  title="Đóng bảng ma trận"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Mobile Mode Switcher */}
            <div className="sm:hidden px-3 py-1.5 bg-slate-950/80 border-b border-white/10 flex items-center justify-between text-xs">
              <span className="text-slate-400 font-semibold">Chế độ xem:</span>
              <div className="flex items-center bg-slate-900 p-0.5 rounded-lg border border-white/10 text-[10px] font-bold">
                <button
                  type="button"
                  onClick={() => setComparisonMode('free')}
                  className={`px-2 py-1 rounded ${comparisonMode === 'free' ? 'bg-indigo-600 text-white' : 'text-slate-400'}`}
                >
                  Đối Kháng Tất Cả
                </button>
                <button
                  type="button"
                  onClick={() => setComparisonMode('dealer')}
                  className={`px-2 py-1 rounded ${comparisonMode === 'dealer' ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400'}`}
                >
                  Nhóm 1 Làm Cái
                </button>
              </div>
            </div>

            {/* Body scrollable */}
            <div className="p-3 sm:p-4 space-y-4 overflow-y-auto no-scrollbar flex-1">
              {/* Leaderboard Banner */}
              {sortedComplete.length > 0 && (
                <div className="p-2.5 sm:p-3 rounded-xl bg-slate-950/90 border border-amber-500/30 flex flex-col md:flex-row md:items-center justify-between gap-2 text-xs font-mono shadow-inner">
                  <div className="flex items-center space-x-1.5 flex-shrink-0">
                    <span className="text-amber-400 font-bold">👑 THỨ BẬC TỔNG SẮP:</span>
                  </div>
                  <div className="flex items-center space-x-1.5 overflow-x-auto no-scrollbar py-0.5">
                    {sortedComplete.map((it, idx) => (
                      <React.Fragment key={it.groupNum}>
                        {idx > 0 && <span className="text-slate-600 font-sans font-black select-none">&gt;</span>}
                        <span
                          className={`px-2 py-0.5 rounded-lg font-bold border text-[11px] whitespace-nowrap ${
                            it.rank === 1
                              ? 'bg-amber-400 text-slate-950 border-amber-300 font-black shadow-sm'
                              : it.rank === 2
                              ? 'bg-slate-200 text-slate-950 border-slate-100'
                              : it.rank === 3
                              ? 'bg-amber-700/85 text-amber-100 border-amber-600'
                              : 'bg-slate-800 text-slate-300 border-white/10'
                          }`}
                        >
                          {it.rank === 1 ? '👑 ' : it.rank === 2 ? '🥈 ' : it.rank === 3 ? '🥉 ' : `#${it.rank} `}
                          {it.name} ({it.label})
                        </span>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}

              {/* BẢNG MA TRẬN ĐỐI CHIẾU TRỰC TIẾP (NxN Table) */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-black text-amber-300 uppercase tracking-wide flex items-center space-x-1.5">
                    <span>1. MA TRẬN ĐỐI ĐẦU TRỰC TIẾP (HÀNG VS CỘT)</span>
                  </h4>
                  <div className="flex items-center space-x-2 text-[10px] font-mono">
                    <span className="text-emerald-400 font-bold">🟢 Ăn (Thắng)</span>
                    <span className="text-rose-400 font-bold">🔴 Thua</span>
                    <span className="text-amber-400 font-bold">🟡 Hòa</span>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-white/10 bg-slate-950/90 shadow-inner">
                  <table className="w-full text-left text-xs font-mono border-collapse">
                    <thead>
                      <tr className="bg-slate-900/90 border-b border-white/10 text-slate-300">
                        <th className="p-2.5 font-bold sticky left-0 bg-slate-900/95 z-10 min-w-[130px]">
                          Nhóm \ Đối thủ
                        </th>
                        {Array.from({ length: numGroups }).map((_, cIdx) => {
                          const colG = cIdx + 1;
                          const colName = groupNames[colG] || `Nhóm ${colG}`;
                          const colAns = answerByGroupNum[colG];
                          return (
                            <th key={colG} className="p-2 text-center min-w-[110px] border-l border-white/5">
                              <div className="font-bold text-slate-200 truncate">{colName}</div>
                              <div className="text-[10px] text-slate-400 truncate font-normal">
                                {colAns?.label || 'Chờ bài'}
                              </div>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {Array.from({ length: numGroups }).map((_, rIdx) => {
                        const rowG = rIdx + 1;
                        const rowName = groupNames[rowG] || `Nhóm ${rowG}`;
                        const rowAns = answerByGroupNum[rowG];

                        return (
                          <tr key={rowG} className="hover:bg-slate-850/40 transition-colors">
                            {/* Tiêu đề hàng */}
                            <td className="p-2.5 font-bold sticky left-0 bg-slate-900/95 z-10 border-r border-white/10">
                              <div className="flex items-center space-x-1.5">
                                {rowAns?.rank === 1 && <span>👑</span>}
                                <span className="text-white">{rowName}</span>
                                {rowAns?.rank && (
                                  <span className={`text-[9px] px-1 py-0.2 rounded font-black ${rowAns.rankBadgeClass}`}>
                                    #{rowAns.rank}
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-slate-400 font-normal truncate">
                                {rowAns?.label || 'Chờ bài'}
                              </div>
                            </td>

                            {/* Các ô đối chiếu chéo (Row vs Col) */}
                            {Array.from({ length: numGroups }).map((_, cIdx) => {
                              const colG = cIdx + 1;
                              const colAns = answerByGroupNum[colG];

                              if (rowG === colG) {
                                return (
                                  <td key={colG} className="p-2 text-center text-slate-600 bg-slate-900/40 border-l border-white/5">
                                    —
                                  </td>
                                );
                              }

                              if (!rowAns?.isComplete || !colAns?.isComplete) {
                                return (
                                  <td key={colG} className="p-2 text-center text-slate-500 text-[10px] border-l border-white/5">
                                    Chờ bài
                                  </td>
                                );
                              }

                              const diff = rowAns.score - colAns.score;
                              if (Math.abs(diff) < 0.0001) {
                                return (
                                  <td key={colG} className="p-2 text-center font-bold text-amber-300 bg-amber-500/10 border-l border-white/5 whitespace-nowrap">
                                    🟡 Hòa
                                  </td>
                                );
                              } else if (diff > 0) {
                                return (
                                  <td key={colG} className="p-2 text-center font-bold text-emerald-300 bg-emerald-500/15 border-l border-white/5 whitespace-nowrap">
                                    🟢 Ăn
                                  </td>
                                );
                              } else {
                                return (
                                  <td key={colG} className="p-2 text-center font-bold text-rose-300 bg-rose-500/15 border-l border-white/5 whitespace-nowrap">
                                    🔴 Thua
                                  </td>
                                );
                              }
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* BẢNG TỔNG KẾT CHI TIẾT TỪNG NHÓM (ĂN NHÓM NÀO, THUA NHÓM NÀO) */}
              <div className="space-y-2">
                <h4 className="text-xs font-black text-amber-300 uppercase tracking-wide">
                  2. CHI TIẾT THẮNG - THUA CỦA TỪNG NHÓM
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {allGroupAnswers.map((g) => {
                    return (
                      <div
                        key={g.groupNum}
                        className={`p-3 rounded-xl border flex flex-col justify-between space-y-2 transition-all ${
                          g.isWinner
                            ? 'bg-amber-500/10 border-amber-400/60 ring-1 ring-amber-400/30 shadow-md shadow-amber-500/10'
                            : 'bg-slate-950/80 border-white/10'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <span className="font-bold text-sm text-white">{g.name}</span>
                            {g.rank && (
                              <span className={`text-[10px] px-1.5 py-0.2 rounded font-black ${g.rankBadgeClass}`}>
                                {g.rankBadgeText}
                              </span>
                            )}
                          </div>
                          <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded-lg border ${g.highlightClass}`}>
                            {g.label || 'Chưa xong'}
                          </span>
                        </div>

                        {g.isComplete ? (
                          <div className="space-y-1.5 text-xs font-mono">
                            <div className="flex items-center justify-between text-slate-400 text-[11px] pb-1 border-b border-white/5">
                              <span>Tỷ số đối kháng ({g.totalCompared} nhóm):</span>
                              <div className="flex items-center space-x-1.5 font-bold">
                                <span className="text-emerald-400">Thắng {g.winsCount}</span>
                                <span className="text-slate-600">/</span>
                                <span className="text-rose-400">Thua {g.lossesCount}</span>
                                {g.tiesCount > 0 && (
                                  <>
                                    <span className="text-slate-600">/</span>
                                    <span className="text-amber-400">Hòa {g.tiesCount}</span>
                                  </>
                                )}
                              </div>
                            </div>

                            {/* Cụ thể ăn nhóm nào */}
                            {g.wonAgainst.length > 0 ? (
                              <div className="flex items-start space-x-1.5 bg-emerald-950/40 border border-emerald-500/30 p-1.5 rounded-lg">
                                <span className="text-emerald-400 font-bold whitespace-nowrap text-[11px]">
                                  ✓ Ăn ({g.wonAgainst.length}):
                                </span>
                                <div className="flex flex-wrap gap-1">
                                  {g.wonAgainst.map((w) => (
                                    <span
                                      key={w.groupNum}
                                      className="px-1.5 py-0.5 rounded bg-emerald-900/80 text-emerald-200 border border-emerald-500/40 text-[10px] font-bold"
                                    >
                                      {w.name} ({w.label})
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <div className="text-[11px] text-slate-500 italic pl-1">Không ăn được nhóm nào</div>
                            )}

                            {/* Cụ thể thua nhóm nào */}
                            {g.lostAgainst.length > 0 ? (
                              <div className="flex items-start space-x-1.5 bg-rose-950/40 border border-rose-500/30 p-1.5 rounded-lg">
                                <span className="text-rose-400 font-bold whitespace-nowrap text-[11px]">
                                  ✗ Thua ({g.lostAgainst.length}):
                                </span>
                                <div className="flex flex-wrap gap-1">
                                  {g.lostAgainst.map((l) => (
                                    <span
                                      key={l.groupNum}
                                      className="px-1.5 py-0.5 rounded bg-rose-900/80 text-rose-200 border border-rose-500/40 text-[10px] font-bold"
                                    >
                                      {l.name} ({l.label})
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <div className="text-[11px] text-emerald-400 font-bold pl-1">
                                ✓ Thắng tuyệt đối (Bất bại trước mọi nhóm)
                              </div>
                            )}

                            {/* Cụ thể hòa nhóm nào */}
                            {g.tiedWith.length > 0 && (
                              <div className="flex items-start space-x-1.5 bg-amber-950/40 border border-amber-500/30 p-1.5 rounded-lg">
                                <span className="text-amber-400 font-bold whitespace-nowrap text-[11px]">
                                  = Hòa ({g.tiedWith.length}):
                                </span>
                                <div className="flex flex-wrap gap-1">
                                  {g.tiedWith.map((t) => (
                                    <span
                                      key={t.groupNum}
                                      className="px-1.5 py-0.5 rounded bg-amber-900/80 text-amber-200 border border-amber-500/40 text-[10px] font-bold"
                                    >
                                      {t.name} ({t.label})
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Chế độ Nhà Cái (Nhóm 1 làm Cái) */}
                            {comparisonMode === 'dealer' && g.groupNum !== 1 && (
                              <div className="pt-1 border-t border-white/10 flex items-center justify-between text-[11px]">
                                <span className="text-slate-400">So với Nhà Cái (Nhóm 1):</span>
                                {g.vsDealerResult === 'win' ? (
                                  <span className="px-2 py-0.5 rounded bg-emerald-600 text-white font-bold">
                                    Ăn Cái (Thắng)
                                  </span>
                                ) : g.vsDealerResult === 'loss' ? (
                                  <span className="px-2 py-0.5 rounded bg-rose-600 text-white font-bold">
                                    Thua Cái
                                  </span>
                                ) : g.vsDealerResult === 'tie' ? (
                                  <span className="px-2 py-0.5 rounded bg-amber-500 text-slate-950 font-bold">
                                    Hòa Cái
                                  </span>
                                ) : (
                                  <span className="text-slate-500 italic">Chưa xác định</span>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-xs text-slate-500 italic">Chưa đủ bài để đối chiếu</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-4 py-2.5 bg-slate-950 border-t border-white/10 flex items-center justify-between text-xs text-slate-400">
              <span>Bảng đối chiếu cập nhật trực tiếp theo từng lá bài nhập vào</span>
              <button
                type="button"
                onClick={() => setShowMatrixModal(false)}
                className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold transition-all"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 9. Floating Draggable 1-13 & 0 Picker Popup (Có kèm Bảng Đáp Án & Xong Phiên) */}
      <CardPickerPopup
        isOpen={isCardPickerOpen}
        onClose={() => setIsCardPickerOpen(false)}
        target={cardPickerTarget}
        numGroups={numGroups}
        groupNames={groupNames}
        entries={entries}
        gameMode={gameMode}
        danGroups={danGroups}
        onSelectCard={handleSelectCardFromPicker}
        onDeleteCard={onDeleteCard}
        onChangeTargetGroup={(gNum) => setCardPickerTarget((prev) => ({ ...prev, groupNum: gNum }))}
        onFinishRound={handleRequestFinishRound}
      />

      {/* 10. Nút Nổi To Cố Định Ở Góc Màn Hình: Bật lại bảng số bất cứ khi nào */}
      {!isCardPickerOpen && typeof document !== 'undefined' && createPortal(
        <button
          type="button"
          onClick={() => setIsCardPickerOpen(true)}
          className="fixed bottom-5 right-5 z-[99998] px-4 py-3 rounded-2xl bg-gradient-to-r from-amber-500 via-yellow-500 to-amber-600 hover:from-amber-400 hover:to-yellow-400 text-slate-950 font-black text-sm shadow-2xl shadow-amber-500/50 flex items-center space-x-2 border-2 border-amber-300 active:scale-95 transition-all cursor-pointer animate-pulse hover:animate-none"
          title="Bấm vào đây để mở Bảng Nhập Số (1-13)"
        >
          <LayoutGrid className="w-5 h-5 text-slate-950" />
          <span>⌨️ BẢNG NHẬP SỐ (1-13)</span>
        </button>,
        document.body
      )}
    </div>
  );
};
