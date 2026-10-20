import type { DrawShape } from '@lichess-org/chessground/draw';

import { defined } from 'lib';
import { renderEval } from 'lib/ceval';
import { glyphSquare } from 'lib/game/glyphs';
import { licon } from 'lib/licon';
import { hl, onInsert, type VNode } from 'lib/view';

import type AnalyseCtrl from '../ctrl';
import { renderIndexAndMove } from '../view/components';
import { classifications, type Classification } from './classify';
import type { MoveReview } from './reviewCtrl';

interface Style {
  label: string;
  phrase: string;
  symbol: string;
  icon?: boolean; // symbol is a lichess font icon
  color: string;
}

export const styles: Record<Classification, Style> = {
  brilliant: { label: 'Brilliant', phrase: 'is brilliant', symbol: '!!', color: '#1baca6' },
  great: { label: 'Great', phrase: 'is a great move', symbol: '!', color: '#5c8bb0' },
  best: { label: 'Best', phrase: 'is best', symbol: licon.Star, icon: true, color: '#81b64c' },
  excellent: {
    label: 'Excellent',
    phrase: 'is excellent',
    symbol: licon.ThumbsUp,
    icon: true,
    color: '#96bc4b',
  },
  good: { label: 'Good', phrase: 'is good', symbol: licon.Checkmark, icon: true, color: '#97af8b' },
  book: { label: 'Book', phrase: 'is a book move', symbol: licon.Book, icon: true, color: '#a88865' },
  inaccuracy: { label: 'Inaccuracy', phrase: 'is an inaccuracy', symbol: '?!', color: '#56b4e9' },
  mistake: { label: 'Mistake', phrase: 'is a mistake', symbol: '?', color: '#e69f00' },
  miss: { label: 'Miss', phrase: 'is a miss', symbol: licon.X, icon: true, color: '#ee6b55' },
  blunder: { label: 'Blunder', phrase: 'is a blunder', symbol: '??', color: '#df5353' },
};

const colors: Color[] = ['white', 'black'];

export function renderBadge(classification: Classification): VNode {
  const { label, symbol, icon, color } = styles[classification];
  const attrs = { title: label, style: `background-color:${color}` };
  return icon
    ? hl('review-badge', { attrs: { ...attrs, 'data-icon': symbol } })
    : hl('review-badge', { attrs }, symbol);
}

// drawn like chessground's move annotation glyphs, top right of the destination square
export function boardShape(m: MoveReview, shapes: DrawShape[]): DrawShape | undefined {
  if (!m.node.uci || !m.node.san) return undefined;
  const orig = glyphSquare(m.node.uci, m.node.san);
  const stacked = shapes.filter(s => s.orig === orig && s.customSvg).length;
  const { symbol, icon, color } = styles[m.classification];
  const font = icon
    ? 'font-family="lichess" font-size="54"'
    : `font-weight="bold" font-size="${symbol.length > 1 ? 50 : 62}"`;
  const html =
    '<defs><filter id="a"><feDropShadow dx="4" dy="7" flood-opacity=".5" stdDeviation="5"/></filter></defs>' +
    `<g transform="matrix(.4 0 0 .4 ${71 - (stacked % 4) * 28} -12)">` +
    `<circle cx="50" cy="50" r="50" fill="${color}" filter="url(#a)"/>` +
    `<text x="50" y="52" fill="#fff" text-anchor="middle" dominant-baseline="central" ${font}>${symbol}</text>` +
    '</g>';
  return { orig, brush: '', customSvg: { html } };
}

const evalText = (ev: EvalScore): string => (defined(ev.mate) ? `#${ev.mate}` : renderEval(ev.cp ?? 0));

const evalSwing = (m: MoveReview): VNode =>
  hl('span.game-review__eval', `${evalText(m.before)} → ${evalText(m.after)}`);

const bestWas = (m: MoveReview): string | undefined =>
  m.best && m.classification !== 'book' ? i18n.site.bestWasX(m.best) : undefined;

export function renderMoveCard(ctrl: AnalyseCtrl): VNode | undefined {
  const m = ctrl.review.active() ? ctrl.review.get(ctrl.node) : undefined;
  if (!m) return undefined;
  const best = bestWas(m);
  return hl('div.game-review__card', [
    renderBadge(m.classification),
    hl('div.game-review__verdict', [
      hl('strong', [
        hl('move', renderIndexAndMove(m.node, false, false)),
        ' ',
        styles[m.classification].phrase,
      ]),
      best && hl('em', best),
    ]),
    evalSwing(m),
  ]);
}

const renderMoment = (ctrl: AnalyseCtrl, m: MoveReview): VNode => {
  const best = bestWas(m);
  return hl(
    'a.game-review__moment',
    { class: { active: m.node === ctrl.node }, attrs: { 'data-ply': m.node.ply } },
    [
      renderBadge(m.classification),
      hl('move', renderIndexAndMove(m.node, false, false)),
      hl('span.game-review__label', styles[m.classification].label),
      best && hl('span.game-review__best', best),
      evalSwing(m),
    ],
  );
};

export function renderReview(ctrl: AnalyseCtrl): VNode {
  const { review } = ctrl;
  const analysis = ctrl.mainlineAnalysis;
  const moments = review.keyMoments();
  return hl(
    'div.game-review',
    {
      hook: onInsert(el =>
        el.addEventListener('click', e => {
          const target = (e.target as HTMLElement).closest<HTMLElement>('[data-ply], [data-classification]');
          if (!target) return;
          const { ply, color, classification } = target.dataset;
          if (ply) ctrl.jumpToMain(parseInt(ply));
          else review.jumpToNext(color as Color, classification as Classification);
          ctrl.redraw();
        }),
      ),
    },
    [
      hl('table.game-review__summary', [
        hl('thead', hl('tr', [hl('th'), ...colors.map(c => hl('th', hl(`i.is.color-icon.${c}`)))])),
        hl('tbody', [
          hl('tr.game-review__accuracy', [
            hl('th', i18n.site.accuracy),
            ...colors.map(c => hl('td', analysis ? `${analysis[c].accuracy}%` : '-')),
          ]),
          ...classifications.map(classification =>
            hl('tr', [
              hl('th', [renderBadge(classification), styles[classification].label]),
              ...colors.map(color => {
                const nb = review.count(color, classification);
                return hl(
                  'td',
                  nb
                    ? {
                        class: { jump: true },
                        attrs: { 'data-color': color, 'data-classification': classification },
                      }
                    : { class: { zero: true } },
                  String(nb),
                );
              }),
            ]),
          ),
        ]),
      ]),
      hl('div.game-review__moments', [
        hl('strong', 'Key moments'),
        moments.length ? moments.map(m => renderMoment(ctrl, m)) : hl('p', 'No big swings in this game.'),
      ]),
    ],
  );
}
