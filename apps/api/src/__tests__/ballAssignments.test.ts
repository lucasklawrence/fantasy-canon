/**
 * Ball numbering (#211): the hopper's numbers must be a faithful, stable picture of the bag —
 * contiguous per-team ranges in odds-table order, and a drawn-ball choice every viewer agrees on.
 */

import { describe, expect, it } from 'vitest';

import {
  assignBallRanges,
  ballRadius,
  drawnBallFor,
  rangeLabel,
} from '../client/ballAssignments.js';

const ROWS = [
  { team: 'Ravens', balls: 4 },
  { team: 'Bengals', balls: 3 },
  { team: 'Browns', balls: 2 },
  { team: 'Steelers', balls: 1 },
];

describe('assignBallRanges', () => {
  it('assigns contiguous 1-based ranges in row order', () => {
    const ranges = assignBallRanges(ROWS);
    expect(ranges.map((r) => [r.team, r.start, r.end])).toEqual([
      ['Ravens', 1, 4],
      ['Bengals', 5, 7],
      ['Browns', 8, 9],
      ['Steelers', 10, 10],
    ]);
  });

  it('covers the whole bag with no gaps or overlaps', () => {
    const ranges = assignBallRanges(ROWS);
    const seen = new Set<number>();
    for (const range of ranges) {
      for (let n = range.start; n <= range.end; n += 1) {
        expect(seen.has(n)).toBe(false);
        seen.add(n);
      }
    }
    expect(seen.size).toBe(10); // 4+3+2+1
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBe(10);
  });

  it('keeps a zero-ball team addressable with an empty range', () => {
    const ranges = assignBallRanges([
      { team: 'A', balls: 2 },
      { team: 'B', balls: 0 },
      { team: 'C', balls: 1 },
    ]);
    expect(ranges[1]).toMatchObject({ team: 'B', start: 3, end: 2 });
    expect(ranges[2]).toMatchObject({ team: 'C', start: 3, end: 3 }); // numbering unaffected
  });

  it('spaces hues so adjacent rows never share a color', () => {
    const hues = assignBallRanges(ROWS).map((r) => r.hue);
    expect(new Set(hues).size).toBe(ROWS.length);
    for (let i = 1; i < hues.length; i += 1) {
      const gap = Math.abs(hues[i] - hues[i - 1]);
      expect(Math.min(gap, 360 - gap)).toBeGreaterThan(30);
    }
  });
});

describe('rangeLabel', () => {
  it('formats multi-ball, single-ball, and empty ranges', () => {
    const [ravens, , , steelers] = assignBallRanges(ROWS);
    expect(rangeLabel(ravens)).toBe('#1–4');
    expect(rangeLabel(steelers)).toBe('#10');
    expect(rangeLabel({ team: 'B', start: 3, end: 2, hue: 0 })).toBe('');
  });
});

describe('drawnBallFor', () => {
  const range = { team: 'Ravens', start: 5, end: 8, hue: 0 };

  it('is deterministic for the same commitment and pick', () => {
    const a = drawnBallFor('deadbeef', 3, range);
    expect(drawnBallFor('deadbeef', 3, range)).toBe(a);
  });

  it('always lands inside the range', () => {
    for (let pick = 1; pick <= 12; pick += 1) {
      const ball = drawnBallFor('c0ffee', pick, range);
      expect(ball).toBeGreaterThanOrEqual(range.start);
      expect(ball).toBeLessThanOrEqual(range.end);
    }
  });

  it('varies with the commitment, so a re-run draws a different-looking ball', () => {
    const picks = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = picks.map((p) => drawnBallFor('commit-one', p, range)).join(',');
    const b = picks.map((p) => drawnBallFor('commit-two', p, range)).join(',');
    expect(a).not.toBe(b);
  });

  it('degrades safely on an empty range', () => {
    expect(drawnBallFor('x', 1, { team: 'B', start: 3, end: 2, hue: 0 })).toBe(3);
  });
});

describe('ballRadius', () => {
  it('shrinks as the bag grows and respects the clamps', () => {
    const hopper = 126; // the 260px hopper's usable radius
    const four = ballRadius(4, hopper);
    const seventyEight = ballRadius(78, hopper); // 12-team standings bag: 1+2+…+12
    expect(four).toBeGreaterThan(seventyEight);
    expect(four).toBeLessThanOrEqual(17);
    expect(seventyEight).toBeGreaterThanOrEqual(6);
    expect(ballRadius(0, hopper)).toBe(0);
  });
});
