import { describe, expect, it } from 'vitest';
import {
  buildReplayTimeline,
  REPLAY_DWELL_MS,
  REPLAY_MAX_STEP_MS,
  replayStepMs,
} from '../client/replayTimeline.js';
import type { LotteryReveal, LotterySnapshot, LotteryStart } from '../lotteryStage.js';

const START: LotteryStart = {
  title: '2026 Draft Lottery',
  commitment: 'hash',
  teamCount: 3,
  totalBalls: 6,
  delayMs: 8000,
  rows: [
    { team: 'C', balls: 3, firstPct: 50, top3Pct: 100 },
    { team: 'B', balls: 2, firstPct: 33.3, top3Pct: 100 },
    { team: 'A', balls: 1, firstPct: 16.7, top3Pct: 100 },
  ],
};

// Broadcast (worst-to-first) order: pick 3, pick 2, pick 1.
const REVEALS: LotteryReveal[] = [
  { pick: 3, team: 'B', balls: 2, oddsPct: 33.3, remaining: ['A', 'C'] },
  { pick: 2, team: 'A', balls: 1, oddsPct: 25, remaining: ['C'] },
  { pick: 1, team: 'C', balls: 3, oddsPct: 100, remaining: [] },
];

const FINISHED: LotterySnapshot = {
  phase: 'finished',
  start: START,
  reveals: REVEALS,
  finish: {
    order: [
      { pick: 1, team: 'C' },
      { pick: 2, team: 'A' },
      { pick: 3, team: 'B' },
    ],
    verify: { secretSeed: 's', salt: 'm1', drawSeed: 's|m1', commitment: 'hash' },
  },
};

describe('buildReplayTimeline', () => {
  it('emits beat → reveal per pick in broadcast order, then the finish', () => {
    const steps = buildReplayTimeline(FINISHED);
    expect(steps.map((s) => s.event.type)).toEqual([
      'lottery-beat',
      'lottery-reveal',
      'lottery-beat',
      'lottery-reveal',
      'lottery-beat',
      'lottery-reveal',
      'lottery-finish',
    ]);
    const revealed = steps
      .filter((s) => s.event.type === 'lottery-reveal')
      .map((s) => (s.event.type === 'lottery-reveal' ? s.event.reveal : undefined));
    expect(revealed).toEqual(REVEALS);
    const finish = steps[steps.length - 1];
    expect(finish.event.type === 'lottery-finish' && finish.event.finish).toEqual(FINISHED.finish);
  });

  it("reconstructs each beat's remaining: all teams first, then the previous reveal's leftovers", () => {
    const beats = buildReplayTimeline(FINISHED).flatMap((s) =>
      s.event.type === 'lottery-beat' ? [s.event.beat] : [],
    );
    expect(beats.map((b) => b.pick)).toEqual([3, 2, 1]);
    expect(beats[0].remaining).toEqual(['C', 'B', 'A']); // odds-table order, everyone still in
    expect(beats[1].remaining).toEqual(['A', 'C']);
    expect(beats[2].remaining).toEqual(['C']);
  });

  it('compresses the live drum-roll window but never stretches a faster one', () => {
    const steps = buildReplayTimeline(FINISHED); // live delayMs 8000 → capped
    expect(steps[1].atMs - steps[0].atMs).toBe(REPLAY_MAX_STEP_MS);
    const fast = buildReplayTimeline({ ...FINISHED, start: { ...START, delayMs: 1200 } });
    expect(fast[1].atMs - fast[0].atMs).toBe(1200);
  });

  it('spaces picks by step + dwell and keeps the schedule monotonic', () => {
    const steps = buildReplayTimeline(FINISHED);
    const beats = steps.filter((s) => s.event.type === 'lottery-beat');
    expect(beats[1].atMs - beats[0].atMs).toBe(REPLAY_MAX_STEP_MS + REPLAY_DWELL_MS);
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i].atMs).toBeGreaterThanOrEqual(steps[i - 1].atMs);
    }
    // the finale dwells after the last drop instead of slamming straight to the board
    expect(steps[steps.length - 1].atMs - steps[steps.length - 2].atMs).toBe(REPLAY_DWELL_MS);
  });

  it('falls back without a start: first beat still includes the about-to-be-drawn team', () => {
    const noStart: LotterySnapshot = { phase: 'finished', reveals: REVEALS };
    const steps = buildReplayTimeline(noStart);
    const first = steps[0];
    expect(first.event.type === 'lottery-beat' && first.event.beat.remaining).toEqual([
      'B',
      'A',
      'C',
    ]);
    expect(replayStepMs(noStart)).toBe(REPLAY_MAX_STEP_MS);
  });

  it('replays a finish-only snapshot as a single immediate finish step', () => {
    const steps = buildReplayTimeline({ ...FINISHED, reveals: [] });
    expect(steps).toHaveLength(1);
    expect(steps[0].atMs).toBe(0);
    expect(steps[0].event.type).toBe('lottery-finish');
  });

  it('builds an empty timeline from an empty snapshot (nothing to replay)', () => {
    expect(buildReplayTimeline({ phase: 'idle', reveals: [] })).toEqual([]);
  });
});
