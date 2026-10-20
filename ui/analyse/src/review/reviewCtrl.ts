import { isNormal, parseUci } from 'chessops';
import { makeSan } from 'chessops/san';
import { normalizeMove } from 'chessops/variant';

import { defined } from 'lib';
import { storedBooleanProp } from 'lib/storage';
import type { ClientEval, TreeNode } from 'lib/tree/types';

import type AnalyseCtrl from '../ctrl';
import type { AnalysisMeta } from '../interfaces';
import {
  classify,
  isSacrifice,
  judge,
  thresholds,
  winPercentLoss,
  type Classification,
  type Judgment,
} from './classify';

export interface MoveReview {
  node: TreeNode;
  color: Color;
  classification: Classification;
  judgment?: Judgment;
  before: EvalScore;
  after: EvalScore;
  loss: number; // win% points
  best?: San; // the engine's choice, when it differs from the move played
}

interface Evaluation {
  ev: EvalScore;
  fromAnalysis: boolean; // server or local game analysis, which come with judgment glyphs
  lines?: { uci: Uci; ev: EvalScore }[];
}

const glyphJudgments: Record<string, Judgment> = { '?!': 'inaccuracy', '?': 'mistake', '??': 'blunder' };

export class ReviewCtrl {
  readonly enabled = storedBooleanProp('analyse.game-review', false);
  private cache?: {
    mainline: TreeNode[];
    analysis?: AnalysisMeta;
    ceval?: ClientEval;
    moves: Map<TreeNode, MoveReview>;
  };

  constructor(private readonly root: AnalyseCtrl) {}

  allowed = (): boolean => !this.root.study && !!this.root.mainlineAnalysis;

  active = (): boolean =>
    this.enabled() &&
    this.allowed() &&
    this.root.settings.showMainlineAnalysis &&
    !this.root.retro &&
    !this.root.practice;

  get = (node: TreeNode): MoveReview | undefined => this.moves().get(node);

  count = (color: Color, classification: Classification): number =>
    [...this.moves().values()].filter(m => m.color === color && m.classification === classification).length;

  keyMoments(): MoveReview[] {
    const weight = (m: MoveReview) =>
      m.classification === 'brilliant' || m.classification === 'great' ? 100 : m.judgment ? m.loss : 0;
    return [...this.moves().values()]
      .filter(m => weight(m) > 0)
      .sort((a, b) => weight(b) - weight(a))
      .slice(0, thresholds.maxKeyMoments)
      .sort((a, b) => a.node.ply - b.node.ply);
  }

  jumpToNext(color: Color, classification: Classification): void {
    const moves = [...this.moves().values()].filter(
      m => m.color === color && m.classification === classification,
    );
    const next = moves.find(m => m.node.ply > this.root.node.ply) ?? moves[0];
    if (next) this.root.jumpToMain(next.node.ply);
  }

  // recomputed when the mainline, the analysis or the current local eval changes
  moves(): Map<TreeNode, MoveReview> {
    const { mainline, mainlineAnalysis: analysis } = this.root;
    const ceval = this.root.node.ceval;
    const cache = this.cache;
    if (cache?.mainline === mainline && cache.analysis === analysis && cache.ceval === ceval)
      return cache.moves;
    const game = this.root.data.game;
    const bookPly = game.variant.key === 'standard' ? game.opening?.ply : undefined;
    const moves = new Map<TreeNode, MoveReview>();
    let prev: MoveReview | undefined;
    for (const [i, node] of mainline.slice(1).entries()) {
      prev = reviewMove(mainline[i], node, prev, bookPly);
      if (prev) moves.set(node, prev);
    }
    this.cache = { mainline, analysis, ceval, moves };
    return moves;
  }
}

function evaluate(node: TreeNode): Evaluation | undefined {
  const ceval = node.ceval && node.ceval.depth >= thresholds.minCevalDepth ? node.ceval : undefined;
  const cevalLines = ceval?.pvs.map(pv => ({ uci: pv.moves[0], ev: pv }));
  if (node.eval && (defined(node.eval.cp) || defined(node.eval.mate)))
    return {
      ev: node.eval,
      fromAnalysis: true,
      // only local game analysis keeps its lines
      lines: node.eval.pvs?.map(pv => ({ uci: pv.moves.split(' ')[0], ev: pv })) ?? cevalLines,
    };
  if (ceval) return { ev: ceval, fromAnalysis: false, lines: cevalLines };
  // analysis has no eval for a checkmate
  const outcome = node.outcome();
  if (outcome)
    return {
      ev: outcome.winner ? { mate: outcome.winner === 'white' ? 1 : -1 } : { cp: 0 },
      fromAnalysis: false,
    };
  return undefined;
}

function reviewMove(
  parent: TreeNode,
  node: TreeNode,
  prev: MoveReview | undefined,
  bookPly: Ply | undefined,
): MoveReview | undefined {
  const before = evaluate(parent);
  const after = evaluate(node);
  const uci = node.uci;
  if (!before || !after || !uci) return undefined;
  const color: Color = node.ply % 2 === 1 ? 'white' : 'black';
  // the analysis line, added where the move was judged ?!, ? or ??
  const comp = parent.children.find(c => c.comp);
  const top = comp ? false : before.lines?.length ? before.lines[0].uci === uci : undefined;
  const judgment =
    before.fromAnalysis && after.fromAnalysis
      ? node.glyphs?.map(g => (g.comp ? glyphJudgments[g.symbol] : undefined)).find(defined)
      : judge(color, before.ev, after.ev);
  const classification = classify({
    color,
    before: before.ev,
    after: after.ev,
    judgment,
    top,
    lines: before.lines?.map(l => l.ev),
    book: defined(bookPly) && node.ply <= bookPly,
    sacrifice: () => {
      const pos = parent.pos();
      const move = parseUci(uci);
      if (pos.isErr || !move) return false;
      const normal = normalizeMove(pos.value, move);
      return isNormal(normal) && isSacrifice(pos.value, normal);
    },
    prev: prev && { judgment: prev.judgment, before: prev.before },
  });
  return {
    node,
    color,
    classification,
    judgment,
    before: before.ev,
    after: after.ev,
    loss: winPercentLoss(color, before.ev, after.ev),
    best: top === false ? (comp?.san ?? bestSan(parent, before.lines?.[0]?.uci)) : undefined,
  };
}

function bestSan(parent: TreeNode, uci: Uci | undefined): San | undefined {
  const pos = parent.pos();
  const move = uci && parseUci(uci);
  return move && pos.isOk ? makeSan(pos.value, move) : undefined;
}
