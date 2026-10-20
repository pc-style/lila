import { opposite, type NormalMove, type Position, type Role, type Square } from 'chessops';

import { povChances } from 'lib/ceval/winningChances';

export type Judgment = 'inaccuracy' | 'mistake' | 'blunder';

export type Classification =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'excellent'
  | 'good'
  | 'book'
  | 'inaccuracy'
  | 'mistake'
  | 'miss'
  | 'blunder';

export const classifications: Classification[] = [
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'inaccuracy',
  'mistake',
  'miss',
  'blunder',
];

// Win% values are 0-100 on the curve used for accuracy (lib/ceval/winningChances, WinPercent.scala).
// A move's loss is the mover's win% before it minus their win% after it.
export const thresholds = {
  // largest loss still called best when the engine's top move is unknown. Server analysis only
  // keeps the engine's choice on moves it judged ?!, ? or ??
  best: 1,
  excellent: 2,
  // judgments, as in CpAdvice (modules/tree/src/main/Advice.scala)
  inaccuracy: 5,
  mistake: 10,
  blunder: 15,
  // great: the engine's top move, with its second choice at least this much worse
  greatGap: 10,
  // brilliant: a sacrifice losing at most `excellent`, played below this win%...
  brilliantMaxBefore: 90,
  // ...and keeping at least this much
  brilliantMinAfter: 40,
  // material (pawn = 1) newly left en prise, net of captures, that makes a sacrifice
  sacrifice: 2,
  // miss: after the opponent's ? or ??, a judged move giving back at least half of what that error
  // handed over, and ending at most this far below where the player stood before it
  missMargin: 5,
  // local engine evals shallower than this are ignored
  minCevalDepth: 16,
  maxKeyMoments: 6,
} as const;

export interface MoveFacts {
  color: Color; // side that played the move
  before: EvalScore;
  after: EvalScore;
  judgment?: Judgment;
  top?: boolean; // whether this was the engine's top move, if known
  lines?: EvalScore[]; // engine evals of its best choices before the move, best first
  book?: boolean;
  sacrifice?: () => boolean;
  prev?: { judgment?: Judgment; before: EvalScore }; // the opponent's previous move
}

export const winPercent = (color: Color, ev: EvalScore): number => 50 + 50 * povChances(color, ev);

export const winPercentLoss = (color: Color, before: EvalScore, after: EvalScore): number =>
  Math.max(0, winPercent(color, before) - winPercent(color, after));

export function classify(m: MoveFacts): Classification {
  if (m.book) return 'book';
  const before = winPercent(m.color, m.before);
  const after = winPercent(m.color, m.after);
  const loss = Math.max(0, before - after);
  if (m.judgment) {
    const prev = m.prev;
    if (prev && (prev.judgment === 'mistake' || prev.judgment === 'blunder')) {
      const standing = winPercent(m.color, prev.before);
      const gift = before - standing;
      if (loss >= gift / 2 && after >= standing - thresholds.missMargin) return 'miss';
    }
    return m.judgment;
  }
  if (
    m.top !== false &&
    loss <= thresholds.excellent &&
    before < thresholds.brilliantMaxBefore &&
    after >= thresholds.brilliantMinAfter &&
    m.sacrifice?.()
  )
    return 'brilliant';
  const [first, second] = m.lines ?? [];
  if (
    m.top &&
    first &&
    second &&
    winPercent(m.color, first) - winPercent(m.color, second) >= thresholds.greatGap
  )
    return 'great';
  if (m.top || (m.top === undefined && loss <= thresholds.best)) return 'best';
  return loss <= thresholds.excellent ? 'excellent' : 'good';
}

// lila's own judgment of a move (CpAdvice and MateAdvice in modules/tree/src/main/Advice.scala),
// for evals that did not come with the server's ?!, ? and ?? glyphs
export function judge(color: Color, before: EvalScore, after: EvalScore): Judgment | undefined {
  const sign = color === 'white' ? 1 : -1;
  const prevMate = before.mate !== undefined ? before.mate * sign : undefined;
  const mate = after.mate !== undefined ? after.mate * sign : undefined;
  const prevCp = prevMate === undefined ? (before.cp ?? 0) * sign : 0;
  const cp = mate === undefined ? (after.cp ?? 0) * sign : 0;
  if (prevMate === undefined) {
    if (mate === undefined) {
      const loss = winPercentLoss(color, before, after);
      if (loss >= thresholds.blunder) return 'blunder';
      if (loss >= thresholds.mistake) return 'mistake';
      if (loss >= thresholds.inaccuracy) return 'inaccuracy';
      return undefined;
    }
    // checkmate is now unavoidable
    if (mate < 0) return prevCp < -999 ? 'inaccuracy' : prevCp < -700 ? 'mistake' : 'blunder';
    return undefined;
  }
  // lost forced checkmate sequence
  if (prevMate > 0 && (mate === undefined || mate < 0))
    return cp > 999 ? 'inaccuracy' : cp > 700 ? 'mistake' : 'blunder';
  return undefined;
}

const values: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

// what the side not to move stands to lose on each piece the side to move can take
function enPrise(pos: Position): Map<Square, number> {
  const ctx = pos.ctx();
  const victim = opposite(pos.turn);
  const cheapest = new Map<Square, number>();
  for (const from of pos.board[pos.turn]) {
    const value = values[pos.board.getRole(from)!];
    for (const to of pos.dests(from, ctx).intersect(pos.board[victim]))
      cheapest.set(to, Math.min(cheapest.get(to) ?? Infinity, value));
  }
  const loss = new Map<Square, number>();
  for (const [square, attacker] of cheapest) {
    const value = values[pos.board.getRole(square)!];
    const defended = pos.kingAttackers(square, victim, pos.board.occupied).nonEmpty();
    if (value > (defended ? attacker : 0)) loss.set(square, defended ? value - attacker : value);
  }
  return loss;
}

// material the move leaves newly en prise, less what it captures or promotes.
// expects a normalized move (castling as king takes rook, as chessops plays it)
export function sacrificedMaterial(before: Position, move: NormalMove): number {
  if (before.rules !== 'chess') return 0;
  const captured = before.board[opposite(before.turn)].has(move.to)
    ? before.board.getRole(move.to)
    : before.board.getRole(move.from) === 'pawn' && move.to === before.epSquare
      ? 'pawn'
      : undefined;
  const gained = (captured ? values[captured] : 0) + (move.promotion ? values[move.promotion] - 1 : 0);
  const prior = before.clone();
  prior.turn = opposite(before.turn);
  prior.epSquare = undefined;
  const risked = enPrise(prior);
  const after = before.clone();
  after.play(move);
  let worst = 0;
  for (const [square, loss] of enPrise(after))
    worst = Math.max(worst, loss - (risked.get(square === move.to ? move.from : square) ?? 0));
  return worst - gained;
}

export const isSacrifice = (before: Position, move: NormalMove): boolean =>
  sacrificedMaterial(before, move) >= thresholds.sacrifice;
