// ============================================================================
// SERVER 1 COMPLETE CARD GAME ENGINE FOR WEB MODE 2
// Ported 1:1 from E:\appgame\CardGameEngine (Swift & JS Evaluators)
// Supports all 10 game modes:
//   - 3cards (3 Lá Rô Bonus - Chuẩn Server)
//   - lieng3 (Liêng / Bài Cào 3 Cây Chuẩn - Xét Chất)
//   - 2cards (Xì Dách 2 Lá - Rút Bọt tới 5 lá)
//   - texas5 (Poker Texas Hold'em: 2 Lá Tẩy + 5 Lá Bài Chung)
//   - binh6 (Binh 6 Lá Poker)
//   - binh9 (Binh 9 Lá Có Liêng - 3 Chi × 3 Lá)
//   - binh9NoStraight (9 Lá Không Liên - 6 Lá Trước, 3 Lá Sau)
//   - phom9 (Phỏm / Tá Lả: Cửa 1 = 10 Lá, Các cửa sau = 9 Lá)
//   - samLoc10 (Sâm Lốc 10 Lá)
//   - chan19 (Chắn Trung Quốc 19 Lá)
// ============================================================================

export type Server1GameMode =
  | '3cards'
  | 'lieng3'
  | '2cards'
  | 'texas5'
  | 'binh6'
  | 'binh9'
  | 'binh9NoStraight'
  | 'phom9'
  | 'samLoc10'
  | 'chan19';

export type SuitRuleType = 'ro_bonus' | 'co_ro_tep_bich' | 'bich_ro_co_tep' | 'dong_hang';

export interface ParsedCard {
  raw: string;
  rank: string;       // 'A', '2'..'10', 'J', 'Q', 'K'
  suit: string;       // 'H', 'D', 'C', 'S'
  suitSymbol: string; // '♥', '♦', '♣', '♠'
  isRed: boolean;
  power: number;      // 2..14 (A=14)
  seqValue: number;   // 1..13 (A=1, J=11, Q=12, K=13)
  mod10Value: number; // A=1, 2..9=2..9, 10/J/Q/K=0
  roBonus: number;    // Điểm cộng chất Rô ♦
}

export interface DoorEvaluationResult {
  doorIndex: number; // 1-based
  score: number;     // Điểm số tuyệt đối để xếp hạng
  title: string;     // Tên cước / điểm hiển thị trên bàn (VD: "9 Điểm", "Sáp K", "Chi1: Sáp A | Chi2: 9đ | Chi3: 8đ")
  subTitle?: string; // Chi tiết phụ (VD: tổ hợp 5 lá Poker hoặc các bộ Phỏm / Sâm)
  speechText: string;// Câu đọc giọng nói Tiếng Việt
  chiGroups?: string[][]; // Chia nhóm lá bài (3 chi Binh 9, hoặc Phỏm + Rác, hoặc Sâm)
  chiTitles?: string[];   // Nhãn từng chi
}

const RANK_POWER: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

const SEQ_VALUE: Record<string, number> = {
  'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 11, 'Q': 12, 'K': 13
};

const RO_BONUS_MAP: Record<string, number> = {
  'A': 11, 'K': 10, 'Q': 9, 'J': 8, '10': 7, '9': 6, '8': 5, '7': 4,
  '6': 3, '5': 2, '4': 1, '3': 0.5, '2': 0.2
};

export function parseCardCode(rawCode: string): ParsedCard | null {
  if (!rawCode) return null;
  let clean = rawCode.trim().toUpperCase();
  clean = clean
    .replace(/♥|CƠ|CO/g, 'H')
    .replace(/♦|RÔ|RO/g, 'D')
    .replace(/♣|TÉP|TEP|CHUỒN|CHUON/g, 'C')
    .replace(/♠|BÍCH|BICH/g, 'S')
    .replace(/\s+/g, '');

  const m = clean.match(/^(10|[2-9]|[AJQK])([HDCS])$/);
  if (!m) return null;

  const rank = m[1];
  const suit = m[2];
  const suitSymbol = suit === 'H' ? '♥' : suit === 'D' ? '♦' : suit === 'C' ? '♣' : '♠';
  const isRed = suit === 'H' || suit === 'D';
  const power = RANK_POWER[rank] || 0;
  const seqValue = SEQ_VALUE[rank] || 0;
  const mod10Value = rank === 'A' ? 1 : ['10', 'J', 'Q', 'K'].includes(rank) ? 0 : parseInt(rank, 10) || 0;
  const roBonus = suit === 'D' ? (RO_BONUS_MAP[rank] || 0) : 0;

  return {
    raw: `${rank}${suit}`,
    rank,
    suit,
    suitSymbol,
    isRed,
    power,
    seqValue,
    mod10Value,
    roBonus
  };
}

export function getSuitWeight(suit: string, rule: SuitRuleType): number {
  if (rule === 'dong_hang') return 0;
  if (rule === 'bich_ro_co_tep') {
    if (suit === 'S') return 4;
    if (suit === 'D') return 3;
    if (suit === 'H') return 2;
    if (suit === 'C') return 1;
    return 0;
  }
  // Mặc định co_ro_tep_bich: Cơ > Rô > Tép > Bích
  if (suit === 'H') return 4;
  if (suit === 'D') return 3;
  if (suit === 'C') return 2;
  if (suit === 'S') return 1;
  return 0;
}

export function getMaxCardsPerDoor(mode: Server1GameMode, doorIndex = 1): number {
  switch (mode) {
    case '3cards':
    case 'lieng3':
      return 3;
    case '2cards':
      return 2; // Rút bọt tối đa 5 lá xử lý riêng
    case 'texas5':
      return 2; // 2 lá tẩy mỗi nhà (+ 5 lá bài chung trên bàn)
    case 'binh6':
      return 6;
    case 'binh9':
    case 'binh9NoStraight':
      return 9;
    case 'phom9':
      return doorIndex === 1 ? 10 : 9;
    case 'samLoc10':
      return 10;
    case 'chan19':
      return 19;
    default:
      return 3;
  }
}

export function getRequiredCardsToEvaluate(mode: Server1GameMode, doorIndex = 1): number {
  switch (mode) {
    case '3cards':
    case 'lieng3':
      return 3;
    case '2cards':
      return 2;
    case 'texas5':
      return 2;
    case 'binh6':
      return 5;
    case 'binh9':
      return 9;
    case 'binh9NoStraight':
      return 6; // Chấm điểm ngay từ giai đoạn 6 lá (2 chi) và hoàn tất ở 9 lá (3 chi)
    case 'phom9':
      return 9;
    case 'samLoc10':
      return 10;
    case 'chan19':
      return 19;
    default:
      return 3;
  }
}

// Helper sinh tổ hợp C(n, k)
function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const result: T[][] = [];
  function backtrack(start: number, current: T[]) {
    if (current.length === k) {
      result.push([...current]);
      return;
    }
    for (let i = start; i <= arr.length - (k - current.length); i++) {
      current.push(arr[i]);
      backtrack(i + 1, current);
      current.pop();
    }
  }
  backtrack(0, []);
  return result;
}

// Kiểm tra Liêng 3 lá chuẩn (Q-K-A = 14 > J-Q-K = 13 > ... > 2-3-4 = 4 > A-2-3 = 3; K-A-2 không tính)
function checkThreeCardLieng(cards: ParsedCard[]): { isLieng: boolean; liengPower: number; label: string; highCard: ParsedCard } {
  const sortedBySeq = [...cards].sort((a, b) => a.seqValue - b.seqValue);
  const s0 = sortedBySeq[0].seqValue;
  const s1 = sortedBySeq[1].seqValue;
  const s2 = sortedBySeq[2].seqValue;

  // Q-K-A (seqValues: 1, 12, 13)
  if (s0 === 1 && s1 === 12 && s2 === 13) {
    const aceCard = sortedBySeq[0];
    return { isLieng: true, liengPower: 14, label: 'Q-K-A', highCard: aceCard };
  }
  // A-2-3 (seqValues: 1, 2, 3)
  if (s0 === 1 && s1 === 2 && s2 === 3) {
    return { isLieng: true, liengPower: 3, label: 'A-2-3', highCard: sortedBySeq[2] };
  }
  // Các bộ liên tiếp thông thường (2-3-4 -> J-Q-K)
  if (s0 + 1 === s1 && s1 + 1 === s2) {
    return {
      isLieng: true,
      liengPower: s2,
      label: `${sortedBySeq[0].rank}-${sortedBySeq[1].rank}-${sortedBySeq[2].rank}`,
      highCard: sortedBySeq[2]
    };
  }
  return { isLieng: false, liengPower: 0, label: '', highCard: sortedBySeq[2] };
}

// ============================================================================
// 1. 3 LÁ SERVER 2 (BÀI CÀO RÔ BONUS) & 2. LIÊNG 3 CÂY CHUẨN
// ============================================================================
export function evaluateThreeCards(
  rawCards: string[],
  doorIndex: number,
  mode: '3cards' | 'lieng3',
  suitRule: SuitRuleType = 'ro_bonus'
): DoorEvaluationResult {
  const cards = rawCards.map(parseCardCode).filter((c): c is ParsedCard => c !== null).slice(0, 3);
  if (cards.length < 3) {
    return { doorIndex, score: -1, title: 'Đang đợi...', speechText: '' };
  }

  const totalRoBonus = cards.reduce((s, c) => s + c.roBonus, 0);
  const isSap = cards[0].rank === cards[1].rank && cards[1].rank === cards[2].rank;
  const liengInfo = checkThreeCardLieng(cards);
  const isBaTay = cards.every((c) => ['J', 'Q', 'K'].includes(c.rank));
  const mod10 = cards.reduce((s, c) => s + c.mod10Value, 0) % 10;

  if (mode === '3cards' || suitRule === 'ro_bonus') {
    if (isSap) {
      return {
        doorIndex,
        score: 10000 + cards[0].power * 100 + totalRoBonus,
        title: `Bộ Ba ${cards[0].rank}`,
        speechText: `tụ ${doorIndex} sáp ${cards[0].rank}`
      };
    }
    if (liengInfo.isLieng) {
      return {
        doorIndex,
        score: 5000 + liengInfo.liengPower * 100 + totalRoBonus,
        title: `Chuỗi ${liengInfo.label}`,
        speechText: `tụ ${doorIndex} liêng ${liengInfo.label}`
      };
    }
    if (isBaTay) {
      return {
        doorIndex,
        score: 1000 + totalRoBonus,
        title: '3 Tây',
        speechText: `tụ ${doorIndex} ba tây`
      };
    }
    return {
      doorIndex,
      score: mod10 * 100 + totalRoBonus,
      title: `${mod10} Điểm`,
      speechText: `tụ ${doorIndex} ${mod10} điểm`
    };
  }

  // Chế độ Liêng 3 Cây Chuẩn (Xét Chất Bài: Cơ > Rô > Tép > Bích / Bích > Rô > Cơ > Tép / Đồng hạng)
  const bestCardBySuitThenRank = [...cards].sort((a, b) => {
    const swDiff = getSuitWeight(b.suit, suitRule) - getSuitWeight(a.suit, suitRule);
    if (swDiff !== 0) return swDiff;
    return b.power - a.power;
  })[0];

  const tieBreaker =
    suitRule === 'dong_hang'
      ? 0
      : getSuitWeight(bestCardBySuitThenRank.suit, suitRule) * 20 + bestCardBySuitThenRank.power;

  if (isSap) {
    return {
      doorIndex,
      score: 40000 + cards[0].power * 100 + tieBreaker,
      title: `Sáp ${cards[0].rank}`,
      speechText: `tụ ${doorIndex} sáp ${cards[0].rank}`
    };
  }
  if (liengInfo.isLieng) {
    const highSuit = suitRule === 'dong_hang' ? 0 : getSuitWeight(liengInfo.highCard.suit, suitRule);
    return {
      doorIndex,
      score: 30000 + liengInfo.liengPower * 100 + highSuit,
      title: `Liêng ${liengInfo.label}`,
      speechText: `tụ ${doorIndex} liêng ${liengInfo.label}`
    };
  }
  if (isBaTay) {
    return {
      doorIndex,
      score: 20000 + tieBreaker,
      title: 'Ba Tây (Ảnh)',
      speechText: `tụ ${doorIndex} ba tây`
    };
  }
  return {
    doorIndex,
    score: mod10 * 1000 + tieBreaker,
    title: `${mod10} Điểm`,
    speechText: `tụ ${doorIndex} ${mod10} điểm`
  };
}

// ============================================================================
// 3. XÌ DÁCH (2 LÁ - RÚT BỌT TỚI 5 LÁ)
// ============================================================================
function calculateBlackjackOptimalTotal(cards: ParsedCard[]): number {
  let nonAceSum = 0;
  let aceCount = 0;
  for (const c of cards) {
    if (c.rank === 'A') {
      aceCount++;
    } else if (['10', 'J', 'Q', 'K'].includes(c.rank)) {
      nonAceSum += 10;
    } else {
      nonAceSum += parseInt(c.rank, 10) || 0;
    }
  }
  if (aceCount === 0) return nonAceSum;

  const possibleAceVals = cards.length === 2 ? [1, 10, 11] : [1, 10, 11];
  let totals = [nonAceSum];
  for (let i = 0; i < aceCount; i++) {
    const nextTotals: number[] = [];
    for (const t of totals) {
      for (const av of possibleAceVals) {
        if (!nextTotals.includes(t + av)) nextTotals.push(t + av);
      }
    }
    totals = nextTotals;
  }

  const valid = totals.filter((t) => t <= 21);
  if (valid.length > 0) return Math.max(...valid);
  return Math.min(...totals);
}

export function evaluateXiDach(rawCards: string[], doorIndex: number): DoorEvaluationResult {
  const cards = rawCards.map(parseCardCode).filter((c): c is ParsedCard => c !== null);
  if (cards.length < 2) {
    return { doorIndex, score: -1, title: 'Đang đợi...', speechText: '' };
  }

  const roBonus = cards.reduce((s, c) => s + c.roBonus, 0);

  if (cards.length === 2) {
    const r0 = cards[0].rank;
    const r1 = cards[1].rank;
    if (r0 === 'A' && r1 === 'A') {
      return {
        doorIndex,
        score: 5021 + roBonus,
        title: 'Xì Bàng (2 Át)',
        speechText: `tụ ${doorIndex} xì bàng`
      };
    }
    const tenGroup = ['10', 'J', 'Q', 'K'];
    if ((r0 === 'A' && tenGroup.includes(r1)) || (r1 === 'A' && tenGroup.includes(r0))) {
      return {
        doorIndex,
        score: 4021 + roBonus,
        title: 'Xì Dách',
        speechText: `tụ ${doorIndex} xì dách`
      };
    }
  }

  const total = calculateBlackjackOptimalTotal(cards);

  if (cards.length >= 5 && total <= 21) {
    return {
      doorIndex,
      score: 3000 + (21 - total) * 10 + roBonus,
      title: `Ngũ Linh (${total}đ)`,
      speechText: `tụ ${doorIndex} ngũ linh ${total} điểm`
    };
  }

  if (total > 21) {
    return {
      doorIndex,
      score: Math.max(0, (35 - total) * 10) + roBonus,
      title: `Quắc (${total}đ)`,
      speechText: `tụ ${doorIndex} quắc ${total} điểm`
    };
  }

  if (total < 16) {
    return {
      doorIndex,
      score: 1000 + total * 10 + roBonus,
      title: `${total} Điểm (Non)`,
      speechText: `tụ ${doorIndex} ${total} điểm non`
    };
  }

  return {
    doorIndex,
    score: 2000 + total * 10 + roBonus,
    title: `${total} Điểm`,
    speechText: `tụ ${doorIndex} ${total} điểm`
  };
}

// ============================================================================
// 4 & 5. POKER TEXAS HOLD'EM (2+5 LÁ CHUNG) & BINH 6 LÁ POKER
// ============================================================================
interface FiveCardPokerEval {
  category: number; // 0..9
  tieBreakers: number[];
  score: number;
  title: string;
  bestFiveCodes: string[];
}

function evaluateExactFivePoker(five: ParsedCard[]): FiveCardPokerEval {
  const sorted = [...five].sort((a, b) => b.power - a.power);
  const powers = sorted.map((c) => c.power);
  const isFlush = sorted.every((c) => c.suit === sorted[0].suit);

  // Check Straight (bao gồm A-2-3-4-5: powers = [14, 5, 4, 3, 2])
  let isStraight = false;
  let straightHigh = powers[0];
  const uniquePowers = Array.from(new Set(powers));
  if (uniquePowers.length === 5) {
    if (powers[0] - powers[4] === 4) {
      isStraight = true;
      straightHigh = powers[0];
    } else if (powers[0] === 14 && powers[1] === 5 && powers[2] === 4 && powers[3] === 3 && powers[4] === 2) {
      isStraight = true;
      straightHigh = 5;
    }
  }

  const freqMap = new Map<number, { count: number; rank: string }>();
  for (const c of sorted) {
    const prev = freqMap.get(c.power);
    freqMap.set(c.power, { count: (prev?.count || 0) + 1, rank: c.rank });
  }

  const groups = Array.from(freqMap.entries())
    .map(([power, info]) => ({ power, count: info.count, rank: info.rank }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : b.power - a.power));

  let category = 0;
  let title = '';
  let tieBreakers: number[] = [];

  if (isFlush && isStraight) {
    if (straightHigh === 14) {
      category = 9;
      title = 'Thùng Phá Sảnh Lớn';
      tieBreakers = [14];
    } else {
      category = 8;
      title = `Thùng Phá Sảnh (${straightHigh === 5 ? 'A-5' : sorted[0].rank})`;
      tieBreakers = [straightHigh];
    }
  } else if (groups[0].count === 4) {
    category = 7;
    title = `Tứ Quý ${groups[0].rank}`;
    tieBreakers = [groups[0].power, groups[1].power];
  } else if (groups[0].count === 3 && groups[1].count === 2) {
    category = 6;
    title = `Cù Lũ ${groups[0].rank}-${groups[1].rank}`;
    tieBreakers = [groups[0].power, groups[1].power];
  } else if (isFlush) {
    category = 5;
    title = `Thùng ${sorted[0].suitSymbol} (${sorted[0].rank} cao)`;
    tieBreakers = powers;
  } else if (isStraight) {
    category = 4;
    title = `Sảnh (${straightHigh === 5 ? 'A-2-3-4-5' : `${sorted[4].rank}-${sorted[0].rank}`})`;
    tieBreakers = [straightHigh];
  } else if (groups[0].count === 3) {
    category = 3;
    title = `Sám Cô ${groups[0].rank}`;
    tieBreakers = [groups[0].power, groups[1].power, groups[2].power];
  } else if (groups[0].count === 2 && groups[1].count === 2) {
    category = 2;
    title = `Hai Đôi ${groups[0].rank} & ${groups[1].rank}`;
    tieBreakers = [groups[0].power, groups[1].power, groups[2].power];
  } else if (groups[0].count === 2) {
    category = 1;
    title = `Đôi ${groups[0].rank}`;
    tieBreakers = [groups[0].power, groups[1].power, groups[2].power, groups[3].power];
  } else {
    category = 0;
    title = `Mậu Thầu ${sorted[0].rank}`;
    tieBreakers = powers;
  }

  const padded = [...tieBreakers, 0, 0, 0, 0, 0].slice(0, 5);
  const score =
    category * 1e10 +
    padded[0] * 1e8 +
    padded[1] * 1e6 +
    padded[2] * 1e4 +
    padded[3] * 1e2 +
    padded[4];

  return {
    category,
    tieBreakers: padded,
    score,
    title,
    bestFiveCodes: sorted.map((c) => c.raw)
  };
}

export function evaluateBestPokerPool(rawPool: string[], doorIndex: number): DoorEvaluationResult {
  const cards = rawPool.map(parseCardCode).filter((c): c is ParsedCard => c !== null);
  if (cards.length < 5) {
    return { doorIndex, score: -1, title: `Đang đợi (${cards.length}/5)...`, speechText: '' };
  }

  const allFiveCombos = combinations(cards, 5);
  let best: FiveCardPokerEval | null = null;
  for (const combo of allFiveCombos) {
    const ev = evaluateExactFivePoker(combo);
    if (!best || ev.score > best.score) {
      best = ev;
    }
  }

  if (!best) {
    return { doorIndex, score: -1, title: 'Đang đợi...', speechText: '' };
  }

  return {
    doorIndex,
    score: best.score,
    title: best.title,
    subTitle: best.bestFiveCodes.join(' '),
    speechText: `tụ ${doorIndex} ${best.title}`
  };
}

// ============================================================================
// 6. BINH 9 LÁ (CÓ LIÊNG - 3 CHI × 3 LÁ) - Ported from Binh9Evaluator.swift
// ============================================================================
interface BinhChiEval {
  cards: ParsedCard[];
  category: number;     // 5: Sáp, 4: Liêng, 3: Ba Tây, 2: Điểm Đôi, 1: Điểm Thường
  points: number;       // 0..9
  primaryRank: number;  // Sáp rank / Liêng high / Pair rank / High card
  secondaryRank: number;
  title: string;
}

function evalBinh9ChiWithStraight(chi: ParsedCard[]): BinhChiEval {
  const sorted = [...chi].sort((a, b) => b.power - a.power);
  const isSap = sorted[0].rank === sorted[1].rank && sorted[1].rank === sorted[2].rank;
  if (isSap) {
    return {
      cards: sorted,
      category: 5,
      points: 10,
      primaryRank: sorted[0].power,
      secondaryRank: 0,
      title: `Sáp ${sorted[0].rank}`
    };
  }

  const lieng = checkThreeCardLieng(sorted);
  if (lieng.isLieng) {
    return {
      cards: sorted,
      category: 4,
      points: 10,
      primaryRank: lieng.liengPower,
      secondaryRank: sorted[0].power,
      title: `Liêng ${lieng.label}`
    };
  }

  const isBaTay = sorted.every((c) => ['J', 'Q', 'K'].includes(c.rank));
  if (isBaTay) {
    return {
      cards: sorted,
      category: 3,
      points: 10,
      primaryRank: sorted[0].power,
      secondaryRank: sorted[1].power,
      title: 'Ba Tây'
    };
  }

  const pts = sorted.reduce((s, c) => s + c.mod10Value, 0) % 10;
  let pairPower = 0;
  let pairRankStr = '';
  if (sorted[0].rank === sorted[1].rank) {
    pairPower = sorted[0].power;
    pairRankStr = sorted[0].rank;
  } else if (sorted[1].rank === sorted[2].rank) {
    pairPower = sorted[1].power;
    pairRankStr = sorted[1].rank;
  }

  if (pairPower > 0) {
    return {
      cards: sorted,
      category: 2,
      points: pts,
      primaryRank: pairPower,
      secondaryRank: sorted[0].power,
      title: `${pts}đ (Đôi ${pairRankStr})`
    };
  }

  return {
    cards: sorted,
    category: 1,
    points: pts,
    primaryRank: sorted[0].power,
    secondaryRank: sorted[1].power,
    title: `${pts}đ`
  };
}

// So sánh 2 chi của Binh 9 Lá (Có Liêng):
// Sáp (5) > Liêng (4) > Ba Tây (3) > Điểm (2 & 1 so điểm 0..9 trước; bằng điểm thì Điểm Đôi ăn Điểm Thường!)
function compareBinh9Chi(a: BinhChiEval, b: BinhChiEval): number {
  const aIsSpecial = a.category >= 3;
  const bIsSpecial = b.category >= 3;
  if (aIsSpecial || bIsSpecial) {
    if (a.category !== b.category) return a.category - b.category;
    if (a.primaryRank !== b.primaryRank) return a.primaryRank - b.primaryRank;
    return a.secondaryRank - b.secondaryRank;
  }
  // Cả 2 cùng là nhóm Điểm (category 1 hoặc 2)
  if (a.points !== b.points) return a.points - b.points;
  if (a.category !== b.category) return a.category - b.category; // Cùng điểm: Điểm Đôi (2) > Điểm Thường (1)
  if (a.primaryRank !== b.primaryRank) return a.primaryRank - b.primaryRank;
  return a.secondaryRank - b.secondaryRank;
}

function chiNumericStrength(c: BinhChiEval): number {
  if (c.category >= 3) {
    return c.category * 10000 + c.primaryRank * 100 + c.secondaryRank;
  }
  return c.points * 1000 + c.category * 100 + c.primaryRank;
}

// ============================================================================
// 7. ( 9 LÁ KHÔNG LIÊN ) (6 LÁ TRƯỚC, 3 LÁ SAU) - Ported from Binh9NoStraightEvaluator
// ============================================================================
function evalBinh9ChiNoStraight(chi: ParsedCard[]): BinhChiEval {
  const sorted = [...chi].sort((a, b) => b.power - a.power);
  const isSap = sorted[0].rank === sorted[1].rank && sorted[1].rank === sorted[2].rank;
  if (isSap) {
    return {
      cards: sorted,
      category: 5,
      points: 10,
      primaryRank: sorted[0].power,
      secondaryRank: 0,
      title: `Sáp ${sorted[0].rank}`
    };
  }

  let pairPower = 0;
  let pairRankStr = '';
  if (sorted[0].rank === sorted[1].rank) {
    pairPower = sorted[0].power;
    pairRankStr = sorted[0].rank;
  } else if (sorted[1].rank === sorted[2].rank) {
    pairPower = sorted[1].power;
    pairRankStr = sorted[1].rank;
  }

  const isBaTien = sorted.every((c) => ['J', 'Q', 'K'].includes(c.rank));
  if (isBaTien) {
    if (pairPower > 0) {
      return {
        cards: sorted,
        category: 4, // Ba Tiên có đôi
        points: 10,
        primaryRank: pairPower,
        secondaryRank: sorted[0].power,
        title: `Ba Tiên (Đôi ${pairRankStr})`
      };
    }
    return {
      cards: sorted,
      category: 3, // Ba Tiên không đôi
      points: 10,
      primaryRank: sorted[0].power,
      secondaryRank: sorted[1].power,
      title: 'Ba Tiên'
    };
  }

  const pts = sorted.reduce((s, c) => s + c.mod10Value, 0) % 10;
  if (pairPower > 0) {
    return {
      cards: sorted,
      category: 2,
      points: pts,
      primaryRank: pairPower,
      secondaryRank: sorted[0].power,
      title: `${pts}đ (Đôi ${pairRankStr})`
    };
  }

  return {
    cards: sorted,
    category: 1,
    points: pts,
    primaryRank: sorted[0].power,
    secondaryRank: sorted[1].power,
    title: `${pts}đ`
  };
}

export interface ArrangedBinh9Hand {
  chis: BinhChiEval[];
  instantWinRank: number; // 0: none, 1: Ba Liêng / 9 Lá Kịch Điểm, 2: Ba Sáp
  instantWinName: string;
  compositeScore: number;
}

export function arrangeBinh9Optimal(rawCards: string[], allowStraight: boolean): ArrangedBinh9Hand | null {
  const cards = rawCards.map(parseCardCode).filter((c): c is ParsedCard => c !== null);
  const evalFn = allowStraight ? evalBinh9ChiWithStraight : evalBinh9ChiNoStraight;

  // Hỗ trợ chấm điểm giai đoạn 6 lá (2 chi) cho "9 lá không liên"
  if (!allowStraight && cards.length >= 6 && cards.length < 9) {
    const six = cards.slice(0, 6);
    const firstChiCombos = combinations([0, 1, 2, 3, 4, 5], 3);
    let bestTwoChis: [BinhChiEval, BinhChiEval] | null = null;
    let bestScore = -1;

    for (const idx1 of firstChiCombos) {
      const idx2 = [0, 1, 2, 3, 4, 5].filter((i) => !idx1.includes(i));
      const c1 = evalFn(idx1.map((i) => six[i]));
      const c2 = evalFn(idx2.map((i) => six[i]));
      const ordered: [BinhChiEval, BinhChiEval] = compareBinh9Chi(c1, c2) >= 0 ? [c1, c2] : [c2, c1];
      const sc = chiNumericStrength(ordered[0]) * 100000 + chiNumericStrength(ordered[1]);
      if (sc > bestScore) {
        bestScore = sc;
        bestTwoChis = ordered;
      }
    }

    if (!bestTwoChis) return null;
    return {
      chis: bestTwoChis,
      instantWinRank: 0,
      instantWinName: '',
      compositeScore: bestScore
    };
  }

  if (cards.length < 9) return null;
  const nine = cards.slice(0, 9);

  // Duyệt toàn bộ 280 cách chia 9 lá thành 3 chi (mỗi chi 3 lá), sắp xếp Chi 1 >= Chi 2 >= Chi 3 (không bao giờ Lủng)
  let bestTriple: [BinhChiEval, BinhChiEval, BinhChiEval] | null = null;
  let bestInstantRank = 0;
  let bestInstantName = '';
  let bestComposite = -1;

  const indices = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const firstCombos = combinations(indices.slice(1), 2).map((rest) => [0, ...rest]);

  for (const g1 of firstCombos) {
    const rem1 = indices.filter((i) => !g1.includes(i));
    const secondCombos = combinations(rem1.slice(1), 2).map((rest) => [rem1[0], ...rest]);
    for (const g2 of secondCombos) {
      const g3 = rem1.filter((i) => !g2.includes(i));
      const e1 = evalFn(g1.map((i) => nine[i]));
      const e2 = evalFn(g2.map((i) => nine[i]));
      const e3 = evalFn(g3.map((i) => nine[i]));

      const sortedChis = [e1, e2, e3].sort((a, b) => compareBinh9Chi(b, a)) as [
        BinhChiEval,
        BinhChiEval,
        BinhChiEval
      ];

      let instantRank = 0;
      let instantName = '';
      if (sortedChis.every((c) => c.category === 5)) {
        instantRank = 2;
        instantName = 'THẮNG TRẮNG (BA SÁP)';
      } else if (allowStraight && sortedChis.every((c) => c.category === 4)) {
        instantRank = 1;
        instantName = 'THẮNG TRẮNG (BA LIÊNG)';
      } else if (!allowStraight && sortedChis.every((c) => c.category >= 3 || c.points === 9)) {
        instantRank = 1;
        instantName = 'THẮNG TRẮNG (9 LÁ KỊCH ĐIỂM)';
      }

      const s1 = chiNumericStrength(sortedChis[0]);
      const s2 = chiNumericStrength(sortedChis[1]);
      const s3 = chiNumericStrength(sortedChis[2]);
      // Ưu tiên phương án giúp thắng nhiều chi nhất (cân bằng Chi 2 và Chi 3 cao mà vẫn giữ Chi 1 mạnh)
      const composite = instantRank * 1e13 + (s1 + s2 * 1.35 + s3 * 1.5) * 1e6 + s1 * 1e3 + s2;

      if (composite > bestComposite) {
        bestComposite = composite;
        bestTriple = sortedChis;
        bestInstantRank = instantRank;
        bestInstantName = instantName;
      }
    }
  }

  if (!bestTriple) return null;
  return {
    chis: bestTriple,
    instantWinRank: bestInstantRank,
    instantWinName: bestInstantName,
    compositeScore: bestComposite
  };
}

// So sánh đối kháng 2 nhà trong Binh 9 Lá (ăn >= 2/3 chi là thắng cuộc đối đầu)
export function compareBinh9Match(a: ArrangedBinh9Hand, b: ArrangedBinh9Hand): number {
  if (a.instantWinRank !== b.instantWinRank) {
    return a.instantWinRank - b.instantWinRank;
  }
  const numChis = Math.min(a.chis.length, b.chis.length);
  let aWins = 0;
  let bWins = 0;
  for (let i = 0; i < numChis; i++) {
    const cmp = compareBinh9Chi(a.chis[i], b.chis[i]);
    if (cmp > 0) aWins++;
    else if (cmp < 0) bWins++;
  }
  if (aWins !== bWins) return aWins - bWins;
  return a.compositeScore - b.compositeScore;
}

// ============================================================================
// 8. PHỎM / TÁ LẢ (CỬA 1 = 10 LÁ, CÁC CỬA SAU = 9 LÁ) - Ported from PhomEvaluator
// ============================================================================
export function evaluatePhomHand(rawCards: string[], doorIndex: number): DoorEvaluationResult {
  const maxAllowed = doorIndex === 1 ? 10 : 9;
  const cards = rawCards.map(parseCardCode).filter((c): c is ParsedCard => c !== null).slice(0, maxAllowed);
  if (cards.length < 9) {
    return { doorIndex, score: -1, title: `Đang đợi (${cards.length}/${maxAllowed})...`, speechText: '' };
  }

  // Tìm tất cả các Phỏm hợp lệ (Ngang 3-4 lá cùng số, Dọc >= 3 lá đồng chất liên tiếp)
  const validMelds: number[][] = [];
  const n = cards.length;

  // 1. Phỏm ngang
  const byRank = new Map<string, number[]>();
  cards.forEach((c, idx) => {
    const list = byRank.get(c.rank) || [];
    list.push(idx);
    byRank.set(c.rank, list);
  });
  byRank.forEach((indices) => {
    if (indices.length >= 3) {
      validMelds.push(...combinations(indices, 3));
    }
    if (indices.length === 4) {
      validMelds.push(indices);
    }
  });

  // 2. Phỏm dọc (Sảnh đồng chất >= 3 lá, A=1..K=13)
  const bySuit = new Map<string, { idx: number; seq: number }[]>();
  cards.forEach((c, idx) => {
    const list = bySuit.get(c.suit) || [];
    list.push({ idx, seq: c.seqValue });
    bySuit.set(c.suit, list);
  });
  bySuit.forEach((suitCards) => {
    const sorted = [...suitCards].sort((a, b) => a.seq - b.seq);
    for (let start = 0; start < sorted.length; start++) {
      const run: number[] = [sorted[start].idx];
      let lastSeq = sorted[start].seq;
      for (let nxt = start + 1; nxt < sorted.length; nxt++) {
        if (sorted[nxt].seq === lastSeq + 1) {
          run.push(sorted[nxt].idx);
          lastSeq = sorted[nxt].seq;
          if (run.length >= 3) {
            validMelds.push([...run]);
          }
        } else if (sorted[nxt].seq > lastSeq + 1) {
          break;
        }
      }
    }
  });

  // Backtracking tìm tập Phỏm không trùng lá sao cho tổng điểm rác (deadwood) nhỏ nhất
  let bestMelds: number[][] = [];
  let minDeadwoodPoints = cards.reduce((s, c) => s + c.seqValue, 0);
  let maxMeldCardsCount = 0;

  function searchMelds(meldIdx: number, usedMask: number, currentMelds: number[][]) {
    let deadwood = 0;
    let meldCardCount = 0;
    for (let i = 0; i < n; i++) {
      if ((usedMask & (1 << i)) === 0) {
        deadwood += cards[i].seqValue;
      } else {
        meldCardCount++;
      }
    }

    if (
      currentMelds.length > 0 &&
      (maxMeldCardsCount === 0 ||
        deadwood < minDeadwoodPoints ||
        (deadwood === minDeadwoodPoints && meldCardCount > maxMeldCardsCount))
    ) {
      minDeadwoodPoints = deadwood;
      maxMeldCardsCount = meldCardCount;
      bestMelds = currentMelds.map((m) => [...m]);
    }

    for (let m = meldIdx; m < validMelds.length; m++) {
      const meld = validMelds[m];
      let conflict = false;
      let mask = 0;
      for (const idx of meld) {
        if ((usedMask & (1 << idx)) !== 0) {
          conflict = true;
          break;
        }
        mask |= 1 << idx;
      }
      if (!conflict) {
        currentMelds.push(meld);
        searchMelds(m + 1, usedMask | mask, currentMelds);
        currentMelds.pop();
      }
    }
  }

  searchMelds(0, 0, []);

  // Kiểm tra Ù Khan (0 Phỏm và không có đôi / cạ nào)
  let hasPairOrCa = false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cards[i].rank === cards[j].rank) hasPairOrCa = true;
      if (cards[i].suit === cards[j].suit && Math.abs(cards[i].seqValue - cards[j].seqValue) <= 2) {
        hasPairOrCa = true;
      }
    }
  }

  const usedIndices = new Set<number>();
  bestMelds.forEach((m) => m.forEach((idx) => usedIndices.add(idx)));
  const deadwoodCards = cards.filter((_, idx) => !usedIndices.has(idx));
  const chiGroups: string[][] = [
    ...bestMelds.map((m) => m.map((i) => cards[i].raw)),
    ...(deadwoodCards.length > 0 ? [deadwoodCards.map((c) => c.raw)] : [])
  ];
  const chiTitles: string[] = [
    ...bestMelds.map((_, idx) => `Phỏm ${idx + 1}`),
    ...(deadwoodCards.length > 0 ? [`Rác (${minDeadwoodPoints}đ)`] : [])
  ];

  // Xét Ù (9 hoặc 10 lá nằm trong Phỏm, hoặc chỉ dư đúng 1 lá để đánh đi khi cầm 10 lá)
  const isUTron10 = n === 10 && maxMeldCardsCount === 10;
  const isU = bestMelds.length > 0 && (maxMeldCardsCount >= 9 || deadwoodCards.length === 0 || (n === 10 && deadwoodCards.length <= 1));

  if (isUTron10) {
    return {
      doorIndex,
      score: 100000,
      title: 'Ù TRÒN 10 LÁ',
      subTitle: `${bestMelds.length} Phỏm`,
      speechText: `tụ ${doorIndex} ù tròn 10 lá`,
      chiGroups,
      chiTitles
    };
  }

  if (isU) {
    return {
      doorIndex,
      score: 90000,
      title: 'Ù (0 Điểm)',
      subTitle: `${bestMelds.length} Phỏm`,
      speechText: `tụ ${doorIndex} ù`,
      chiGroups,
      chiTitles
    };
  }

  if (bestMelds.length === 0 && !hasPairOrCa) {
    return {
      doorIndex,
      score: 85000,
      title: 'Ù KHAN',
      subTitle: 'Không cạ, không đôi',
      speechText: `tụ ${doorIndex} ù khan`,
      chiGroups: [cards.map((c) => c.raw)],
      chiTitles: ['Ù Khan']
    };
  }

  if (bestMelds.length === 0) {
    return {
      doorIndex,
      score: Math.max(1, 1000 - minDeadwoodPoints),
      title: `Móm / Cháy (${minDeadwoodPoints}đ)`,
      subTitle: '0 Phỏm',
      speechText: `tụ ${doorIndex} móm ${minDeadwoodPoints} điểm`,
      chiGroups: [cards.map((c) => c.raw)],
      chiTitles: [`Móm (${minDeadwoodPoints}đ)`]
    };
  }

  return {
    doorIndex,
    score: 50000 - minDeadwoodPoints * 100 + bestMelds.length * 10,
    title: `${minDeadwoodPoints} Điểm (${bestMelds.length} Phỏm)`,
    subTitle: `${bestMelds.length} Phỏm • Rác ${minDeadwoodPoints}đ`,
    speechText: `tụ ${doorIndex} ${minDeadwoodPoints} điểm`,
    chiGroups,
    chiTitles
  };
}

// ============================================================================
// 9. SÂM LỐC (10 LÁ) - Ported from SamLocEvaluator
// ============================================================================
export function evaluateSamLocHand(rawCards: string[], doorIndex: number): DoorEvaluationResult {
  const cards = rawCards.map(parseCardCode).filter((c): c is ParsedCard => c !== null).slice(0, 10);
  if (cards.length < 10) {
    return { doorIndex, score: -1, title: `Đang đợi (${cards.length}/10)...`, speechText: '' };
  }

  const byRank = new Map<string, ParsedCard[]>();
  cards.forEach((c) => {
    const arr = byRank.get(c.rank) || [];
    arr.push(c);
    byRank.set(c.rank, arr);
  });

  // Kiểm tra Thắng Trắng Sâm Lốc:
  // 1. Tứ Quý 2
  if ((byRank.get('2')?.length || 0) === 4) {
    return {
      doorIndex,
      score: 95000,
      title: 'THẮNG TRẮNG (Tứ Quý 2)',
      speechText: `tụ ${doorIndex} thắng trắng tứ quý 2`
    };
  }
  // 2. Đồng Màu (10 lá cùng màu Đỏ hoặc Đen)
  const redCount = cards.filter((c) => c.isRed).length;
  if (redCount === 10 || redCount === 0) {
    return {
      doorIndex,
      score: 94000,
      title: `THẮNG TRẮNG (Đồng Màu ${redCount === 10 ? 'Đỏ' : 'Đen'})`,
      speechText: `tụ ${doorIndex} thắng trắng đồng màu`
    };
  }
  // 3. Sảnh Rồng 10 lá
  const uniqueSeqs = Array.from(new Set(cards.map((c) => c.seqValue))).sort((a, b) => a - b);
  if (uniqueSeqs.length === 10 && uniqueSeqs[9] - uniqueSeqs[0] === 9) {
    return {
      doorIndex,
      score: 93000 + uniqueSeqs[9],
      title: 'THẮNG TRẮNG (Sảnh Rồng 10 Lá)',
      speechText: `tụ ${doorIndex} thắng trắng sảnh rồng`
    };
  }
  // 4. 5 Đôi
  let pairEquiv = 0;
  byRank.forEach((arr) => {
    pairEquiv += Math.floor(arr.length / 2);
  });
  if (pairEquiv === 5) {
    return {
      doorIndex,
      score: 92000,
      title: 'THẮNG TRẮNG (5 Đôi)',
      speechText: `tụ ${doorIndex} thắng trắng 5 đôi`
    };
  }

  // Tách bộ tự động để tối thiểu số lá bài lẻ (Rác)
  const used = new Set<number>();
  const groups: { label: string; cards: ParsedCard[] }[] = [];

  // Tứ quý
  byRank.forEach((arr, rk) => {
    if (arr.length === 4) {
      groups.push({ label: `Tứ Quý ${rk}`, cards: arr });
      arr.forEach((c) => {
        const idx = cards.indexOf(c);
        if (idx >= 0) used.add(idx);
      });
    }
  });

  // Sảnh dài nhất trên các lá còn lại (không tính 2 trong sảnh thường)
  const remForStraight = cards
    .map((c, idx) => ({ c, idx }))
    .filter((item) => !used.has(item.idx) && item.c.rank !== '2')
    .sort((a, b) => a.c.power - b.c.power);

  let run: { c: ParsedCard; idx: number }[] = [];
  for (const item of remForStraight) {
    if (run.length === 0 || item.c.power === run[run.length - 1].c.power + 1) {
      run.push(item);
    } else if (item.c.power === run[run.length - 1].c.power) {
      continue;
    } else {
      if (run.length >= 3) {
        groups.push({ label: `Sảnh ${run.length} lá`, cards: run.map((r) => r.c) });
        run.forEach((r) => used.add(r.idx));
      }
      run = [item];
    }
  }
  if (run.length >= 3) {
    groups.push({ label: `Sảnh ${run.length} lá`, cards: run.map((r) => r.c) });
    run.forEach((r) => used.add(r.idx));
  }

  // Sám cô & Đôi trên các lá còn lại
  const remByRank = new Map<string, { c: ParsedCard; idx: number }[]>();
  cards.forEach((c, idx) => {
    if (used.has(idx)) return;
    const list = remByRank.get(c.rank) || [];
    list.push({ c, idx });
    remByRank.set(c.rank, list);
  });

  remByRank.forEach((list, rk) => {
    if (list.length === 3) {
      groups.push({ label: `Sám ${rk}`, cards: list.map((x) => x.c) });
      list.forEach((x) => used.add(x.idx));
    } else if (list.length === 2) {
      groups.push({ label: `Đôi ${rk}`, cards: list.map((x) => x.c) });
      list.forEach((x) => used.add(x.idx));
    }
  });

  const trashCards = cards.filter((_, idx) => !used.has(idx));
  const trashCount = trashCards.length;
  const twoCount = cards.filter((c) => c.rank === '2').length;

  const chiGroups = [
    ...(trashCards.length > 0 ? [trashCards.map((c) => c.raw)] : []),
    ...groups.map((g) => g.cards.map((c) => c.raw))
  ];
  const chiTitles = [
    ...(trashCards.length > 0 ? [`Rác (${trashCount} lá)`] : []),
    ...groups.map((g) => g.label)
  ];

  return {
    doorIndex,
    score: (10 - trashCount) * 1000 + groups.length * 50 + twoCount * 20,
    title: `Rác: ${trashCount} lá (${groups.length} bộ)`,
    subTitle: groups.map((g) => g.label).join(' • ') || 'Bài lẻ',
    speechText: `tụ ${doorIndex} ${trashCount} lá rác`,
    chiGroups,
    chiTitles
  };
}

// ============================================================================
// 10. ĐÁNH GIÁ TOÀN BỘ CÁC TỤ TRÊN BÀN CHẾ ĐỘ 2
// ============================================================================
export function evaluateAllDoorsServer1(
  doors: string[][],
  communityCards: string[],
  mode: Server1GameMode,
  suitRule: SuitRuleType = 'ro_bonus'
): DoorEvaluationResult[] {
  // Xử lý đối kháng đặc biệt cho Binh 9 Lá (Có Liêng) và 9 Lá Không Liên
  if (mode === 'binh9' || mode === 'binh9NoStraight') {
    const allowStraight = mode === 'binh9';
    const arrangedList = doors.map((d) => arrangeBinh9Optimal(d, allowStraight));

    return doors.map((d, idx) => {
      const doorIndex = idx + 1;
      const arranged = arrangedList[idx];
      if (!arranged) {
        const req = mode === 'binh9NoStraight' ? 6 : 9;
        return {
          doorIndex,
          score: -1,
          title: `Đang đợi (${d.length}/${req})...`,
          speechText: ''
        };
      }

      // Tính số trận thắng đối kháng trước tất cả các tụ khác đã đủ bài
      let headToHeadWins = 0;
      for (let otherIdx = 0; otherIdx < arrangedList.length; otherIdx++) {
        if (otherIdx === idx) continue;
        const other = arrangedList[otherIdx];
        if (!other) continue;
        const cmp = compareBinh9Match(arranged, other);
        if (cmp > 0) headToHeadWins++;
      }

      const chiTitles = arranged.chis.map((c, cIdx) => `Chi ${cIdx + 1}: ${c.title}`);
      const chiGroups = arranged.chis.map((c) => c.cards.map((card) => card.raw));
      const summaryTitle = arranged.instantWinName
        ? arranged.instantWinName
        : arranged.chis.map((c, i) => `C${i + 1}: ${c.title}`).join(' | ');

      const totalScore =
        arranged.instantWinRank * 1e15 +
        headToHeadWins * 1e12 +
        arranged.compositeScore;

      return {
        doorIndex,
        score: totalScore,
        title: summaryTitle,
        subTitle: arranged.chis.length === 2 ? 'Giai đoạn 1 (6 lá - 2 chi)' : 'Hoàn tất 9 lá (3 chi)',
        speechText: `tụ ${doorIndex} ${arranged.chis.map((c, i) => `chi ${i + 1} ${c.title}`).join(', ')}`,
        chiGroups,
        chiTitles
      };
    });
  }

  return doors.map((d, idx) => {
    const doorIndex = idx + 1;
    switch (mode) {
      case '3cards':
        return evaluateThreeCards(d, doorIndex, '3cards', 'ro_bonus');
      case 'lieng3':
        return evaluateThreeCards(d, doorIndex, 'lieng3', suitRule);
      case '2cards':
        return evaluateXiDach(d, doorIndex);
      case 'texas5': {
        if (d.length < 2) {
          return { doorIndex, score: -1, title: `Đang đợi (${d.length}/2 lá tẩy)...`, speechText: '' };
        }
        const pool = [...d.slice(0, 2), ...communityCards];
        if (pool.length < 5) {
          return {
            doorIndex,
            score: -1,
            title: `Đã chia 2 lá tẩy (Chờ ${5 - pool.length} lá chung)...`,
            speechText: ''
          };
        }
        return evaluateBestPokerPool(pool, doorIndex);
      }
      case 'binh6':
        return evaluateBestPokerPool(d.slice(0, 6), doorIndex);
      case 'phom9':
        return evaluatePhomHand(d, doorIndex);
      case 'samLoc10':
        return evaluateSamLocHand(d, doorIndex);
      case 'chan19': {
        const parsed = d.map(parseCardCode).filter((c): c is ParsedCard => c !== null);
        const sorted = [...parsed].sort((a, b) => a.power - b.power);
        return {
          doorIndex,
          score: parsed.length >= 19 ? 100 : -1,
          title: parsed.length >= 19 ? 'Đủ 19 lá' : `Đang chia (${parsed.length}/19)...`,
          speechText: '',
          chiGroups: sorted.length > 0 ? [sorted.map((c) => c.raw)] : undefined
        };
      }
      default:
        return evaluateThreeCards(d, doorIndex, '3cards', 'ro_bonus');
    }
  });
}
