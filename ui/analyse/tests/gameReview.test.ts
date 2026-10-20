import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import type { NormalMove } from 'chessops/types';
import { parseUci } from 'chessops/util';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { classify, judge, sacrificedMaterial, winPercent, type MoveFacts } from '../src/review/classify';

const move = (facts: Partial<MoveFacts>): MoveFacts => ({
  color: 'white',
  before: { cp: 0 },
  after: { cp: 0 },
  ...facts,
});

describe('winPercent', () => {
  test('is 50 when equal and symmetric between colors', () => {
    assert.equal(winPercent('white', { cp: 0 }), 50);
    assert.equal(winPercent('white', { cp: 200 }), 100 - winPercent('black', { cp: 200 }));
    assert.ok(winPercent('white', { mate: 3 }) > 99);
  });
});

describe('judge', () => {
  test('uses lila win% thresholds', () => {
    assert.equal(judge('white', { cp: 0 }, { cp: -30 }), undefined);
    assert.equal(judge('white', { cp: 0 }, { cp: -100 }), 'inaccuracy');
    assert.equal(judge('white', { cp: 0 }, { cp: -150 }), 'mistake');
    assert.equal(judge('white', { cp: 0 }, { cp: -200 }), 'blunder');
    assert.equal(judge('black', { cp: 0 }, { cp: 200 }), 'blunder');
    assert.equal(judge('black', { cp: 0 }, { cp: -200 }), undefined);
  });
  test('handles mate sequences like MateAdvice', () => {
    assert.equal(judge('white', { cp: 50 }, { mate: -3 }), 'blunder');
    assert.equal(judge('white', { cp: -800 }, { mate: -3 }), 'mistake');
    assert.equal(judge('white', { cp: -1200 }, { mate: -3 }), 'inaccuracy');
    assert.equal(judge('white', { mate: 2 }, { cp: 1200 }), 'inaccuracy');
    assert.equal(judge('white', { mate: 2 }, { cp: 300 }), 'blunder');
    assert.equal(judge('black', { mate: -2 }, { mate: 4 }), 'blunder');
    assert.equal(judge('white', { mate: 2 }, { mate: 5 }), undefined);
    assert.equal(judge('white', { mate: -2 }, { cp: -500 }), undefined);
  });
});

describe('classify', () => {
  test('book comes first', () => {
    assert.equal(classify(move({ book: true, judgment: 'mistake' })), 'book');
  });
  test('splits unjudged moves by loss', () => {
    assert.equal(classify(move({ top: true, after: { cp: -40 } })), 'best');
    assert.equal(classify(move({ after: { cp: -5 } })), 'best');
    assert.equal(classify(move({ after: { cp: -15 } })), 'excellent');
    assert.equal(classify(move({ after: { cp: -40 } })), 'good');
    assert.equal(classify(move({ top: false })), 'excellent');
  });
  test('keeps the judgment', () => {
    assert.equal(classify(move({ after: { cp: -300 }, judgment: 'blunder' })), 'blunder');
  });
  test('great needs the top move and a large gap to the second line', () => {
    assert.equal(classify(move({ top: true, lines: [{ cp: 300 }, { cp: 0 }] })), 'great');
    assert.equal(classify(move({ top: true, lines: [{ cp: 50 }, { cp: 30 }] })), 'best');
    assert.equal(classify(move({ top: false, lines: [{ cp: 300 }, { cp: 0 }] })), 'excellent');
  });
  test('brilliant needs a sound sacrifice outside a won position', () => {
    const sac = () => true;
    assert.equal(classify(move({ sacrifice: sac })), 'brilliant');
    assert.equal(classify(move({ sacrifice: sac, before: { cp: 800 }, after: { cp: 800 } })), 'best');
    assert.equal(classify(move({ sacrifice: sac, after: { cp: -80 } })), 'good');
    assert.equal(classify(move({ sacrifice: sac, top: false })), 'excellent');
  });
  test('miss gives back an opponent error', () => {
    const prev = { judgment: 'blunder' as const, before: { cp: 0 } };
    const facts = { prev, before: { cp: 500 } };
    assert.equal(classify(move({ ...facts, after: { cp: 50 }, judgment: 'blunder' })), 'miss');
    assert.equal(classify(move({ ...facts, after: { cp: -300 }, judgment: 'blunder' })), 'blunder');
    assert.equal(classify(move({ ...facts, after: { cp: 350 }, judgment: 'inaccuracy' })), 'inaccuracy');
    const inaccuracy = { judgment: 'inaccuracy' as const, before: { cp: 0 } };
    assert.equal(
      classify(move({ ...facts, prev: inaccuracy, after: { cp: 50 }, judgment: 'blunder' })),
      'blunder',
    );
  });
});

describe('sacrificedMaterial', () => {
  const sacrificed = (fen: string, uci: string) =>
    sacrificedMaterial(Chess.fromSetup(parseFen(fen).unwrap()).unwrap(), parseUci(uci) as NormalMove);

  test('quiet moves and even trades', () => {
    assert.equal(sacrificed('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e2e4'), 0);
    assert.ok(sacrificed('4k3/8/4p3/3n4/8/2N5/8/4K3 w - - 0 1', 'c3d5') <= 0);
  });
  test('greek gift', () => {
    const fen = 'r1bq1rk1/pppn1ppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R2QK2R w KQ - 0 1';
    assert.equal(sacrificed(fen, 'd3h7'), 2);
  });
  test("legal's mate leaves the queen", () => {
    const fen = 'rn1qkbnr/ppp2p1p/3p2p1/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5';
    assert.equal(sacrificed(fen, 'f3e5'), 5);
  });
  test('pinned attackers cannot take', () => {
    assert.equal(sacrificed('4k3/4r3/8/8/8/8/2B5/5K2 w - - 0 1', 'c2h7'), 3);
    // the rook on e7 is pinned to its king
    assert.equal(sacrificed('4k3/4r3/8/8/8/8/2B5/4RK2 w - - 0 1', 'c2h7'), 0);
  });
});
