import { describe, expect, it } from 'vitest';
import {
  createLotteryStage,
  parseLotteryBeat,
  parseLotteryFinish,
  parseLotteryReveal,
  parseLotteryStart,
  type LotteryEvent,
  type LotteryStart,
} from '../lotteryStage.js';

const START: LotteryStart = {
  title: '2026 Draft Lottery',
  commitment: 'hash',
  teamCount: 3,
  totalBalls: 6,
  delayMs: 5000,
  rows: [
    { team: 'C', balls: 3, firstPct: 50, top3Pct: 100 },
    { team: 'B', balls: 2, firstPct: 33.3, top3Pct: 100 },
    { team: 'A', balls: 1, firstPct: 16.7, top3Pct: 100 },
  ],
};

describe('createLotteryStage', () => {
  it('walks waiting → revealing → finished, emitting each event once', () => {
    const stage = createLotteryStage();
    const events: LotteryEvent[] = [];
    stage.subscribe((e) => events.push(e));

    stage.start(START);
    stage.beat({ pick: 3, remaining: ['A', 'B', 'C'] });
    stage.reveal({ pick: 3, team: 'B', balls: 2, oddsPct: 33.3, remaining: ['A', 'C'] });
    stage.finish({
      order: [
        { pick: 1, team: 'C' },
        { pick: 2, team: 'A' },
        { pick: 3, team: 'B' },
      ],
      verify: { secretSeed: 's', salt: 'm1', drawSeed: 's|m1', commitment: 'hash' },
    });

    expect(events.map((e) => e.type)).toEqual([
      'lottery-start',
      'lottery-beat',
      'lottery-reveal',
      'lottery-finish',
    ]);
    const snap = stage.snapshot();
    expect(snap.phase).toBe('finished');
    expect(snap.reveals).toHaveLength(1);
    expect(snap.pendingBeat).toBeUndefined();
    expect(snap.finish?.verify.secretSeed).toBe('s');
  });

  it('keeps full reveal history for late joiners, including a pending drum-roll', () => {
    const stage = createLotteryStage();
    stage.start(START);
    stage.beat({ pick: 3, remaining: ['A', 'B', 'C'] });
    stage.reveal({ pick: 3, team: 'B', balls: 2, oddsPct: 33.3, remaining: ['A', 'C'] });
    stage.beat({ pick: 2, remaining: ['A', 'C'] });

    const snap = stage.snapshot();
    expect(snap.phase).toBe('revealing');
    expect(snap.reveals.map((r) => r.team)).toEqual(['B']);
    expect(snap.pendingBeat?.pick).toBe(2);
  });

  it('a new start clears the previous run entirely', () => {
    const stage = createLotteryStage();
    stage.start(START);
    stage.abort({ reason: 'commissioner aborted' });
    expect(stage.snapshot().phase).toBe('aborted');

    stage.start({ ...START, title: 'Re-run' });
    const snap = stage.snapshot();
    expect(snap.phase).toBe('waiting');
    expect(snap.abort).toBeUndefined();
    expect(snap.reveals).toEqual([]);
    expect(snap.start?.title).toBe('Re-run');
  });
});

describe('lottery payload guards', () => {
  it('parseLotteryStart accepts a full payload and rejects partial ones', () => {
    const ok = parseLotteryStart(JSON.stringify(START));
    expect('value' in ok && ok.value.rows).toHaveLength(3);
    expect('error' in parseLotteryStart('{bad')).toBe(true);
    expect('error' in parseLotteryStart(JSON.stringify({ ...START, rows: [] }))).toBe(true);
    expect('error' in parseLotteryStart(JSON.stringify({ ...START, title: '' }))).toBe(true);
    expect('error' in parseLotteryStart(JSON.stringify({ ...START, rows: [{ team: 'X' }] }))).toBe(
      true,
    );
  });

  it('parseLotteryBeat / parseLotteryReveal enforce their shapes', () => {
    expect('value' in parseLotteryBeat(JSON.stringify({ pick: 3, remaining: ['A'] }))).toBe(true);
    expect('error' in parseLotteryBeat(JSON.stringify({ pick: 'x', remaining: ['A'] }))).toBe(true);
    expect(
      'value' in
        parseLotteryReveal(
          JSON.stringify({ pick: 3, team: 'B', balls: 2, oddsPct: 33.3, remaining: [] }),
        ),
    ).toBe(true);
    expect('error' in parseLotteryReveal(JSON.stringify({ pick: 3, team: 'B' }))).toBe(true);
  });

  it('parseLotteryFinish requires the full order and verify block', () => {
    const good = {
      order: [{ pick: 1, team: 'C' }],
      verify: { secretSeed: 's', salt: 'm', drawSeed: 's|m', commitment: 'h' },
    };
    expect('value' in parseLotteryFinish(JSON.stringify(good))).toBe(true);
    expect('error' in parseLotteryFinish(JSON.stringify({ ...good, verify: {} }))).toBe(true);
    expect('error' in parseLotteryFinish(JSON.stringify({ ...good, order: [{ pick: 1 }] }))).toBe(
      true,
    );
  });
});
