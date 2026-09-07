// Bộ tiện ích nhận diện & tính điểm bài chuẩn Việt Nam:
// 1. Luật 3 Lá (Ba Cây / Cào / Liêng / Sáp)
// 2. Luật 2 Lá (Xì Lát / Xì Dách Việt Nam)

export interface CardEvaluation {
  category: 'SAP' | 'LIENG' | 'BA_TAY' | 'DIEM_3LA' | 'XI_BANG' | 'XI_DACH' | 'DIEM_XIDACH' | 'QUAC' | 'WAITING' | 'EMPTY';
  title: string;
  subText: string;
  points: number;
  highlightClass: string;
  isSpecial: boolean;
}

/**
 * Chuyển chuỗi bài thô thành Rank số từ 1 đến 13
 * 1: A, 2..10: 2..10, 11: J, 12: Q, 13: K
 */
export function parseCardRank(raw: string): number {
  if (!raw) return 0;
  const s = raw.trim().toUpperCase();

  if (s === 'A' || s === 'ÁT' || s === 'AT' || s === 'ACE') return 1;
  if (s === 'J' || s === 'BỒI' || s === 'BOI' || s === 'JACK') return 11;
  if (s === 'Q' || s === 'ĐẦM' || s === 'DAM' || s === 'QUEEN') return 12;
  if (s === 'K' || s === 'GIÀ' || s === 'GIA' || s === 'KING') return 13;

  // Số nguyên trực tiếp
  const directNum = parseInt(s, 10);
  if (!isNaN(directNum) && directNum >= 1 && directNum <= 10) {
    return directNum;
  }

  // Bóc tách số trong chuỗi (ví dụ: TAG-8 -> 8, L10 -> 10)
  const match = s.match(/\d+/);
  if (match) {
    const num = parseInt(match[0], 10);
    if (!isNaN(num) && num >= 1 && num <= 10) return num;
  }

  if (s.includes('ACE') || s.endsWith('A')) return 1;
  if (s.includes('JACK') || s.endsWith('J') || s.includes('BỒI')) return 11;
  if (s.includes('QUEEN') || s.endsWith('Q') || s.includes('ĐẦM')) return 12;
  if (s.includes('KING') || s.endsWith('K') || s.includes('GIÀ')) return 13;

  return 0;
}

/**
 * Tên hiển thị ngắn gọn của Rank (A, 2..10, J, Q, K)
 */
export function getRankLabel(rank: number): string {
  if (rank === 1) return 'A';
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  if (rank >= 2 && rank <= 10) return rank.toString();
  return '?';
}

/**
 * Điểm cơ bản của lá bài trong cào 3 lá: A=1, 2..9=2..9, 10,J,Q,K=0 (hoặc 10)
 */
export function get3CardPoint(rank: number): number {
  if (rank === 1) return 1;
  if (rank >= 2 && rank <= 9) return rank;
  if (rank >= 10 && rank <= 13) return 0;
  return 0;
}

/**
 * ĐÁNH GIÁ LUẬT 3 LÁ (CÀO / LIÊNG / SÁP):
 * Ưu tiên: SÁP > LIÊNG > BA TÂY > ĐIỂM NÚT (0-9 NÚT)
 */
export function evaluate3Cards(cards: string[]): CardEvaluation {
  const ranks = cards.map(parseCardRank).filter((r) => r > 0);

  if (ranks.length === 0) {
    return {
      category: 'EMPTY',
      title: 'Chờ chia',
      subText: '0/3 lá',
      points: 0,
      highlightClass: 'bg-slate-800/90 text-slate-400 border-white/5',
      isSpecial: false,
    };
  }

  if (ranks.length < 3) {
    const tempPoints = ranks.reduce((acc, r) => acc + get3CardPoint(r), 0) % 10;
    return {
      category: 'WAITING',
      title: `${tempPoints} điểm (tạm)`,
      subText: `${ranks.length}/3 lá`,
      points: tempPoints,
      highlightClass: 'bg-indigo-950/60 text-indigo-300 border-indigo-500/30',
      isSpecial: false,
    };
  }

  const [r1, r2, r3] = ranks;

  // 1. KIỂM TRA SÁP (3 lá cùng Rank)
  if (r1 === r2 && r2 === r3) {
    const label = getRankLabel(r1);
    return {
      category: 'SAP',
      title: `🔥 SÁP ${label}`,
      subText: `Sáp ${label}${label}${label} cực lớn`,
      points: 100 + r1,
      highlightClass: 'bg-gradient-to-r from-red-600 to-rose-600 text-white font-extrabold shadow-lg shadow-rose-600/40 border-rose-400 animate-pulse',
      isSpecial: true,
    };
  }

  // 2. KIỂM TRA LIÊNG (3 lá liên tiếp)
  const sorted = [...ranks].sort((a, b) => a - b);
  const isNormalConsecutive = sorted[1] === sorted[0] + 1 && sorted[2] === sorted[1] + 1;
  const isQKA = sorted[0] === 1 && sorted[1] === 12 && sorted[2] === 13;
  const isLieng = isNormalConsecutive || isQKA;

  if (isLieng) {
    let liengName = `${getRankLabel(sorted[0])}-${getRankLabel(sorted[1])}-${getRankLabel(sorted[2])}`;
    if (isQKA) {
      liengName = 'Q-K-A';
    }
    return {
      category: 'LIENG',
      title: `⚡ LIÊNG ${liengName}`,
      subText: `Bộ 3 liên tiếp ${liengName}`,
      points: 50 + (isQKA ? 14 : sorted[2]),
      highlightClass: 'bg-gradient-to-r from-amber-500 to-yellow-500 text-slate-950 font-extrabold shadow-lg shadow-amber-500/40 border-yellow-300',
      isSpecial: true,
    };
  }

  // 3. KIỂM TRA BA TÂY / BA CÀO (Cả 3 lá đều là hình người J, Q, K)
  const isAllFaces = ranks.every((r) => r >= 11 && r <= 13);
  if (isAllFaces) {
    return {
      category: 'BA_TAY',
      title: `👑 BA TÂY`,
      subText: '3 cây hình J-Q-K',
      points: 30,
      highlightClass: 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-extrabold shadow-md shadow-purple-600/30 border-purple-400',
      isSpecial: true,
    };
  }

  // 4. TÍNH NÚT / ĐIỂM THƯỜNG (0 - 9 NÚT)
  const totalRawPoints = ranks.reduce((acc, r) => acc + get3CardPoint(r), 0);
  const nut = totalRawPoints % 10;

  if (nut === 9) {
    return {
      category: 'DIEM_3LA',
      title: `⭐ 9 NÚT`,
      subText: 'Chín nút cao nhất',
      points: 9,
      highlightClass: 'bg-emerald-600 text-white font-bold shadow-md shadow-emerald-600/30 border-emerald-400',
      isSpecial: false,
    };
  }

  if (nut === 8) {
    return {
      category: 'DIEM_3LA',
      title: `8 NÚT`,
      subText: 'Tám nút',
      points: 8,
      highlightClass: 'bg-teal-600 text-white font-bold border-teal-400',
      isSpecial: false,
    };
  }

  if (nut === 0) {
    return {
      category: 'DIEM_3LA',
      title: `BÙ (0 NÚT)`,
      subText: '0 nút',
      points: 0,
      highlightClass: 'bg-slate-800 text-slate-400 border-white/10',
      isSpecial: false,
    };
  }

  return {
    category: 'DIEM_3LA',
    title: `${nut} NÚT`,
    subText: `${nut} điểm`,
    points: nut,
    highlightClass: 'bg-indigo-600 text-white font-semibold border-indigo-400',
    isSpecial: false,
  };
}

/**
 * ĐÁNH GIÁ LUẬT XÌ LÁT / XÌ DÁCH VIỆT NAM (2 - 3 LÁ)
 */
export function evaluateXiDach(cards: string[]): CardEvaluation {
  const ranks = cards.map(parseCardRank).filter((r) => r > 0);

  if (ranks.length === 0) {
    return {
      category: 'EMPTY',
      title: 'Chờ chia',
      subText: '0 lá',
      points: 0,
      highlightClass: 'bg-slate-800/90 text-slate-400 border-white/5',
      isSpecial: false,
    };
  }

  if (ranks.length === 1) {
    const single = ranks[0];
    const pt = single === 1 ? 11 : (single >= 10 ? 10 : single);
    return {
      category: 'WAITING',
      title: `${pt} điểm (1 lá)`,
      subText: 'Chờ lá thứ 2',
      points: pt,
      highlightClass: 'bg-indigo-950/60 text-indigo-300 border-indigo-500/30',
      isSpecial: false,
    };
  }

  // 1. XÌ BÀNG (2 lá đều là A)
  if (ranks.length === 2 && ranks[0] === 1 && ranks[1] === 1) {
    return {
      category: 'XI_BANG',
      title: `💎 XÌ BÀNG (A-A)`,
      subText: 'Thắng tuyệt đối',
      points: 100,
      highlightClass: 'bg-gradient-to-r from-red-600 via-pink-600 to-rose-600 text-white font-extrabold shadow-lg shadow-red-600/50 border-rose-300 animate-pulse',
      isSpecial: true,
    };
  }

  // 2. XÌ DÁCH / XÌ LÁT (1 lá A + 1 lá thuộc 10, J, Q, K)
  if (ranks.length === 2) {
    const hasAce = ranks.includes(1);
    const has10OrFace = ranks.some((r) => r >= 10 && r <= 13);
    if (hasAce && has10OrFace) {
      const faceRank = ranks.find((r) => r >= 10 && r <= 13);
      const faceName = faceRank ? getRankLabel(faceRank) : '';
      return {
        category: 'XI_DACH',
        title: `⚡ XÌ DÁCH (A-${faceName})`,
        subText: 'Ăn chắc (Xì Lát)',
        points: 90,
        highlightClass: 'bg-gradient-to-r from-amber-500 to-yellow-500 text-slate-950 font-extrabold shadow-lg shadow-amber-500/40 border-yellow-300',
        isSpecial: true,
      };
    }
  }

  // 3. TÍNH ĐIỂM TỐI ƯU CỦA XÌ DÁCH (A có thể tính 11, 10 hoặc 1)
  const numAces = ranks.filter((r) => r === 1).length;
  const nonAceSum = ranks
    .filter((r) => r !== 1)
    .reduce((sum, r) => sum + (r >= 10 ? 10 : r), 0);

  let bestScore = nonAceSum;
  if (numAces === 0) {
    bestScore = nonAceSum;
  } else if (numAces === 1) {
    if (nonAceSum + 11 <= 21) {
      bestScore = nonAceSum + 11;
    } else if (nonAceSum + 10 <= 21 && ranks.length === 2) {
      bestScore = nonAceSum + 10;
    } else {
      bestScore = nonAceSum + 1;
    }
  } else {
    let sumWithMinAces = nonAceSum + numAces;
    if (sumWithMinAces + 10 <= 21) {
      bestScore = sumWithMinAces + 10;
    } else {
      bestScore = sumWithMinAces;
    }
  }

  if (bestScore === 21) {
    return {
      category: 'DIEM_XIDACH',
      title: `21 ĐIỂM`,
      subText: 'Điểm tối đa',
      points: 21,
      highlightClass: 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-extrabold shadow-md shadow-emerald-600/30 border-emerald-400',
      isSpecial: true,
    };
  }

  if (bestScore > 21) {
    return {
      category: 'QUAC',
      title: `QUẮC (${bestScore}đ)`,
      subText: 'Quá 21 điểm (Cháy)',
      points: bestScore,
      highlightClass: 'bg-rose-950/80 text-rose-300 font-bold border-rose-500/40',
      isSpecial: false,
    };
  }

  if (bestScore >= 18) {
    return {
      category: 'DIEM_XIDACH',
      title: `${bestScore} ĐIỂM (ĐỦ)`,
      subText: 'Điểm đẹp',
      points: bestScore,
      highlightClass: 'bg-emerald-600 text-white font-bold border-emerald-400',
      isSpecial: false,
    };
  }

  if (bestScore >= 16) {
    return {
      category: 'DIEM_XIDACH',
      title: `${bestScore} ĐIỂM (DẰN)`,
      subText: 'Đủ tuổi dằn',
      points: bestScore,
      highlightClass: 'bg-blue-600 text-white font-bold border-blue-400',
      isSpecial: false,
    };
  }

  return {
    category: 'DIEM_XIDACH',
    title: `${bestScore} ĐIỂM (NON)`,
    subText: 'Chưa đủ tuổi dằn',
    points: bestScore,
    highlightClass: 'bg-amber-600/80 text-amber-100 font-semibold border-amber-500/40',
    isSpecial: false,
  };
}
