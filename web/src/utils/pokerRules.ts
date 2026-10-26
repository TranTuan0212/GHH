// Bộ tiện ích nhận diện & tính điểm Poker (Texas Hold'em) chuẩn quốc tế
// Hỗ trợ đầy đủ 4 chất (♥ Cơ, ♦ Rô, ♣ Chuồn, ♠ Bích) và từ 2 đến 7+ lá bài

export type PokerSuit = 'hearts' | 'diamonds' | 'clubs' | 'spades';

export interface ParsedPokerCard {
  raw: string;
  rank: number; // 2..14 (Ace = 14)
  suit: PokerSuit;
  isUnknown: boolean;
}

export type PokerHandCategory =
  | 'ROYAL_FLUSH'
  | 'STRAIGHT_FLUSH'
  | 'FOUR_OF_A_KIND'
  | 'FULL_HOUSE'
  | 'FLUSH'
  | 'STRAIGHT'
  | 'THREE_OF_A_KIND'
  | 'TWO_PAIR'
  | 'ONE_PAIR'
  | 'HIGH_CARD';

export interface PokerEvaluationResult {
  category: PokerHandCategory;
  categoryRank: number; // 10 = Royal Flush .. 1 = High Card
  label: string;
  tieBreakers: number[];
  score: number; // Điểm scalar để xếp thứ hạng
  highlightClass: string;
  hasUnknown: boolean;
}

export function parsePokerCard(raw: string): ParsedPokerCard {
  if (!raw) return { raw: '', rank: 0, suit: 'spades', isUnknown: false };
  const s = raw.trim().toUpperCase();

  // Kiểm tra 0 hoặc không thấy
  if (s === '0' || s.includes('KHÔNG THẤY') || s.includes('KHONG THAY') || s === '?' || s.includes('UNKNOWN') || s.includes('N/A')) {
    return { raw, rank: 0, suit: 'spades', isUnknown: true };
  }

  // Nhận diện chất
  let suit: PokerSuit = 'spades';
  if (s.includes('♥') || s.includes('CO') || s.includes('CƠ') || s.endsWith('H')) {
    suit = 'hearts';
  } else if (s.includes('♦') || s.includes('RO') || s.includes('RÔ') || s.endsWith('R') || s.endsWith('D')) {
    suit = 'diamonds';
  } else if (s.includes('♣') || s.includes('CHUON') || s.includes('CHUỒN') || s.includes('TEP') || s.includes('TÉP') || s.endsWith('C')) {
    suit = 'clubs';
  } else if (s.includes('♠') || s.includes('BICH') || s.includes('BÍCH') || s.endsWith('S')) {
    suit = 'spades';
  }

  // Tách bỏ chất để lấy rank
  let clean = s.replace(/[♥♦♣♠]/g, '').trim();
  clean = clean.replace(/(CO|CƠ|RO|RÔ|CHUON|CHUỒN|TEP|TÉP|BICH|BÍCH)$/i, '').trim();
  clean = clean.replace(/[HRDC]$/i, '').trim();

  let rank = 0;
  if (clean === 'A' || clean === 'ÁT' || clean === 'AT' || clean === '1' || clean === 'ACE') {
    rank = 14; // Ace is 14 in Poker
  } else if (clean === 'K' || clean === 'GIÀ' || clean === 'KING' || clean === '13') {
    rank = 13;
  } else if (clean === 'Q' || clean === 'ĐẦM' || clean === 'QUEEN' || clean === '12') {
    rank = 12;
  } else if (clean === 'J' || clean === 'BỒI' || clean === 'JACK' || clean === '11') {
    rank = 11;
  } else {
    const m = clean.match(/\d+/);
    if (m) {
      const n = parseInt(m[0], 10);
      if (n === 1) rank = 14;
      else if (n >= 2 && n <= 10) rank = n;
      else if (n === 11) rank = 11;
      else if (n === 12) rank = 12;
      else if (n === 13) rank = 13;
    }
  }

  return { raw, rank, suit, isUnknown: rank === 0 };
}

export function getPokerRankSymbol(rank: number): string {
  switch (rank) {
    case 14: return 'A';
    case 13: return 'K';
    case 12: return 'Q';
    case 11: return 'J';
    default: return rank.toString();
  }
}

export function getSuitSymbol(suit: PokerSuit): string {
  switch (suit) {
    case 'hearts': return '♥';
    case 'diamonds': return '♦';
    case 'clubs': return '♣';
    case 'spades': return '♠';
  }
}

// Sinh tổ hợp k phần tử
function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const head = arr[0];
  const tail = arr.slice(1);
  const withHead = combinations(tail, k - 1).map(c => [head, ...c]);
  const withoutHead = combinations(tail, k);
  return [...withHead, ...withoutHead];
}

// Đánh giá chính xác 5 lá bài
export function evaluate5Cards(cards: ParsedPokerCard[]): PokerEvaluationResult {
  if (cards.length < 5) {
    return evaluateLessThan5Cards(cards);
  }

  const sorted = [...cards].sort((a, b) => b.rank - a.rank);
  const ranks = sorted.map(c => c.rank);
  const suits = sorted.map(c => c.suit);

  // Kiểm tra Thùng (Flush)
  const isFlush = suits.every(s => s === suits[0]);

  // Kiểm tra Sảnh (Straight): bao gồm Sảnh Bánh Xe A-2-3-4-5
  let isStraight = false;
  let straightHigh = 0;

  if (
    ranks[0] - ranks[1] === 1 &&
    ranks[1] - ranks[2] === 1 &&
    ranks[2] - ranks[3] === 1 &&
    ranks[3] - ranks[4] === 1
  ) {
    isStraight = true;
    straightHigh = ranks[0];
  } else if (
    ranks[0] === 14 &&
    ranks[1] === 5 &&
    ranks[2] === 4 &&
    ranks[3] === 3 &&
    ranks[4] === 2
  ) {
    isStraight = true;
    straightHigh = 5; // A-2-3-4-5: đỉnh là 5
  }

  // Đếm tần suất các rank
  const counts: { [rank: number]: number } = {};
  ranks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });

  const groups = Object.keys(counts)
    .map(Number)
    .sort((a, b) => {
      // Ưu tiên số lượng giảm dần, nếu bằng nhau thì rank cao hơn xếp trước
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      return b - a;
    });

  const suitSym = getSuitSymbol(suits[0]);

  // 1. Thùng Phá Sảnh Lớn (Royal Flush) / Thùng Phá Sảnh (Straight Flush)
  if (isFlush && isStraight) {
    if (straightHigh === 14) {
      return {
        category: 'ROYAL_FLUSH',
        categoryRank: 10,
        label: `👑 Thùng Phá Sảnh Lớn (${suitSym})`,
        tieBreakers: [14],
        score: 100000000,
        highlightClass: 'bg-amber-500/30 text-amber-300 border-amber-400 shadow-md shadow-amber-500/20 font-black',
        hasUnknown: false
      };
    }
    return {
      category: 'STRAIGHT_FLUSH',
      categoryRank: 9,
      label: `⚡ Thùng Phá Sảnh (${suitSym} đỉnh ${getPokerRankSymbol(straightHigh)})`,
      tieBreakers: [straightHigh],
      score: 90000000 + straightHigh * 10000,
      highlightClass: 'bg-emerald-500/30 text-emerald-300 border-emerald-400 font-black',
      hasUnknown: false
    };
  }

  // 2. Tứ Quý (Four of a Kind)
  if (counts[groups[0]] === 4) {
    const quadRank = groups[0];
    const kicker = groups[1];
    return {
      category: 'FOUR_OF_A_KIND',
      categoryRank: 8,
      label: `💥 Tứ Quý ${getPokerRankSymbol(quadRank)}`,
      tieBreakers: [quadRank, kicker],
      score: 80000000 + quadRank * 10000 + kicker,
      highlightClass: 'bg-rose-500/30 text-rose-300 border-rose-400 font-black',
      hasUnknown: false
    };
  }

  // 3. Cù Lũ (Full House: 3 + 2)
  if (counts[groups[0]] === 3 && counts[groups[1]] >= 2) {
    const tripRank = groups[0];
    const pairRank = groups[1];
    return {
      category: 'FULL_HOUSE',
      categoryRank: 7,
      label: `🏠 Cù Lũ (${getPokerRankSymbol(tripRank)} trên ${getPokerRankSymbol(pairRank)})`,
      tieBreakers: [tripRank, pairRank],
      score: 70000000 + tripRank * 10000 + pairRank,
      highlightClass: 'bg-purple-500/30 text-purple-300 border-purple-400 font-black',
      hasUnknown: false
    };
  }

  // 4. Thùng (Flush)
  if (isFlush) {
    const score = 60000000 + ranks[0] * 10000 + ranks[1] * 1000 + ranks[2] * 100 + ranks[3] * 10 + ranks[4];
    return {
      category: 'FLUSH',
      categoryRank: 6,
      label: `🌊 Thùng (${suitSym} đỉnh ${getPokerRankSymbol(ranks[0])})`,
      tieBreakers: ranks,
      score,
      highlightClass: 'bg-sky-500/30 text-sky-300 border-sky-400 font-bold',
      hasUnknown: false
    };
  }

  // 5. Sảnh (Straight)
  if (isStraight) {
    return {
      category: 'STRAIGHT',
      categoryRank: 5,
      label: `📶 Sảnh (đỉnh ${getPokerRankSymbol(straightHigh)})`,
      tieBreakers: [straightHigh],
      score: 50000000 + straightHigh * 10000,
      highlightClass: 'bg-cyan-500/30 text-cyan-300 border-cyan-400 font-bold',
      hasUnknown: false
    };
  }

  // 6. Sám Cô (Three of a Kind)
  if (counts[groups[0]] === 3) {
    const tripRank = groups[0];
    const kickers = [groups[1], groups[2]];
    return {
      category: 'THREE_OF_A_KIND',
      categoryRank: 4,
      label: `🎯 Sám Cô ${getPokerRankSymbol(tripRank)}`,
      tieBreakers: [tripRank, ...kickers],
      score: 40000000 + tripRank * 10000 + kickers[0] * 100 + (kickers[1] || 0),
      highlightClass: 'bg-blue-500/20 text-blue-300 border-blue-400/50 font-bold',
      hasUnknown: false
    };
  }

  // 7. Hai Đôi (Two Pair)
  if (counts[groups[0]] === 2 && counts[groups[1]] === 2) {
    const highPair = Math.max(groups[0], groups[1]);
    const lowPair = Math.min(groups[0], groups[1]);
    const kicker = groups[2];
    return {
      category: 'TWO_PAIR',
      categoryRank: 3,
      label: `✌️ Hai Đôi (${getPokerRankSymbol(highPair)} & ${getPokerRankSymbol(lowPair)})`,
      tieBreakers: [highPair, lowPair, kicker],
      score: 30000000 + highPair * 10000 + lowPair * 100 + (kicker || 0),
      highlightClass: 'bg-indigo-500/20 text-indigo-300 border-indigo-400/50 font-bold',
      hasUnknown: false
    };
  }

  // 8. Một Đôi (One Pair)
  if (counts[groups[0]] === 2) {
    const pairRank = groups[0];
    const kickers = [groups[1], groups[2], groups[3]];
    return {
      category: 'ONE_PAIR',
      categoryRank: 2,
      label: `🃏 Một Đôi ${getPokerRankSymbol(pairRank)}`,
      tieBreakers: [pairRank, ...kickers],
      score: 20000000 + pairRank * 10000 + kickers[0] * 100 + (kickers[1] || 0),
      highlightClass: 'bg-slate-700/60 text-slate-200 border-white/20',
      hasUnknown: false
    };
  }

  // 9. Mậu Thầu (High Card)
  const score = 10000000 + ranks[0] * 10000 + ranks[1] * 1000 + ranks[2] * 100 + ranks[3] * 10 + ranks[4];
  return {
    category: 'HIGH_CARD',
    categoryRank: 1,
    label: `Mậu Thầu (${getPokerRankSymbol(ranks[0])})`,
    tieBreakers: ranks,
    score,
    highlightClass: 'bg-slate-800/80 text-slate-400 border-white/10',
    hasUnknown: false
  };
}

// Đánh giá khi chưa đủ 5 lá (1 đến 4 lá)
function evaluateLessThan5Cards(cards: ParsedPokerCard[]): PokerEvaluationResult {
  if (cards.length === 0) {
    return {
      category: 'HIGH_CARD',
      categoryRank: 0,
      label: 'Trống',
      tieBreakers: [0],
      score: -1,
      highlightClass: 'text-slate-500 border-white/5',
      hasUnknown: false
    };
  }

  const sorted = [...cards].sort((a, b) => b.rank - a.rank);
  const ranks = sorted.map(c => c.rank);
  const counts: { [rank: number]: number } = {};
  ranks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });

  const groups = Object.keys(counts)
    .map(Number)
    .sort((a, b) => {
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      return b - a;
    });

  if (counts[groups[0]] === 4) {
    const quad = groups[0];
    return {
      category: 'FOUR_OF_A_KIND',
      categoryRank: 8,
      label: `💥 Tứ Quý ${getPokerRankSymbol(quad)}`,
      tieBreakers: [quad],
      score: 80000000 + quad * 10000,
      highlightClass: 'bg-rose-500/30 text-rose-300 border-rose-400 font-black',
      hasUnknown: false
    };
  }

  if (counts[groups[0]] === 3) {
    const trip = groups[0];
    return {
      category: 'THREE_OF_A_KIND',
      categoryRank: 4,
      label: `🎯 Sám Cô ${getPokerRankSymbol(trip)}`,
      tieBreakers: [trip],
      score: 40000000 + trip * 10000,
      highlightClass: 'bg-blue-500/20 text-blue-300 border-blue-400/50 font-bold',
      hasUnknown: false
    };
  }

  if (counts[groups[0]] === 2 && counts[groups[1]] === 2) {
    const hp = Math.max(groups[0], groups[1]);
    const lp = Math.min(groups[0], groups[1]);
    return {
      category: 'TWO_PAIR',
      categoryRank: 3,
      label: `✌️ Hai Đôi (${getPokerRankSymbol(hp)} & ${getPokerRankSymbol(lp)})`,
      tieBreakers: [hp, lp],
      score: 30000000 + hp * 10000 + lp * 100,
      highlightClass: 'bg-indigo-500/20 text-indigo-300 border-indigo-400/50 font-bold',
      hasUnknown: false
    };
  }

  if (counts[groups[0]] === 2) {
    const pair = groups[0];
    return {
      category: 'ONE_PAIR',
      categoryRank: 2,
      label: `🃏 Đôi ${getPokerRankSymbol(pair)}`,
      tieBreakers: [pair],
      score: 20000000 + pair * 10000,
      highlightClass: 'bg-slate-700/60 text-slate-200 border-white/20',
      hasUnknown: false
    };
  }

  // Mậu thầu
  const high = ranks[0];
  return {
    category: 'HIGH_CARD',
    categoryRank: 1,
    label: `${cards.length} lá: Cao ${getPokerRankSymbol(high)}`,
    tieBreakers: ranks,
    score: 10000000 + high * 10000,
    highlightClass: 'bg-slate-800/80 text-slate-400 border-white/10',
    hasUnknown: false
  };
}

// Đánh giá bộ bài có bất kỳ số lượng lá nào (2..7+ lá)
export function evaluatePokerHand(rawCards: string[]): PokerEvaluationResult {
  const parsed = rawCards.map(parsePokerCard);

  if (parsed.some(c => c.isUnknown)) {
    return {
      category: 'HIGH_CARD',
      categoryRank: 0,
      label: '??? (Chưa rõ bài)',
      tieBreakers: [0],
      score: -1,
      highlightClass: 'bg-red-950/80 text-red-400 border-red-500/50 animate-pulse',
      hasUnknown: true
    };
  }

  if (parsed.length <= 5) {
    return evaluate5Cards(parsed);
  }

  // Nếu nhiều hơn 5 lá (ví dụ 6 hoặc 7 lá trong Texas Hold'em):
  // Lấy tổ hợp 5 lá mạnh nhất trong tất cả tổ hợp C(n, 5)
  const allCombos = combinations(parsed, 5);
  let bestResult: PokerEvaluationResult | null = null;

  for (const combo of allCombos) {
    const res = evaluate5Cards(combo);
    if (!bestResult || res.score > bestResult.score) {
      bestResult = res;
    }
  }

  return bestResult || evaluate5Cards(parsed.slice(0, 5));
}
