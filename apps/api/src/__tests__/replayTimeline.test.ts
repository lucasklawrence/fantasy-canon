import { describe, expect, it } from 'vitest';
import {
  buildReplayTimeline,
  catchUpPace,
  catchUpTailFromSnapshot,
  classifyDuringCatchUp,
  toPendingSteps,
  REPLAY_DWELL_MS,
  REPLAY_MAX_STEP_MS,
  replayStepMs,
} from '../client/replayTimeline.js';
import type {
  LotteryFinish,
  LotteryReveal,
  LotterySnapshot,
  LotteryStart,
} from '../lotteryStage.js';

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

const FINISH: LotteryFinish = FINISHED.finish as LotteryFinish;
/** The catch-up has played the first pick and nothing else. */
const MID: { known: number } = { known: 1 };

describe('classifyDuringCatchUp (#203)', () => {
  it('buffers the ceremony own beats and reveals instead of cancelling', () => {
    // The whole point: the old live-wins rule cancelled on the first live beat, which made a
    // mid-reveal catch-up impossible. These extend the tail.
    expect(
      classifyDuringCatchUp(
        { type: 'lottery-beat', beat: { pick: 2, remaining: ['A', 'C'] } },
        MID,
      ),
    ).toBe('buffer');
    expect(classifyDuringCatchUp({ type: 'lottery-reveal', reveal: REVEALS[1] }, MID)).toBe(
      'buffer',
    );
  });

  it('buffers a finish so the catch-up plays through to the finale, not a jump cut', () => {
    expect(classifyDuringCatchUp({ type: 'lottery-finish', finish: FINISH }, MID)).toBe('buffer');
  });

  it('ignores a re-broadcast of a finish it already queued', () => {
    expect(
      classifyDuringCatchUp({ type: 'lottery-finish', finish: FINISH }, { ...MID, finish: FINISH }),
    ).toBe('ignore');
  });

  it('cancels on an abort — never keep animating a draw that was thrown out', () => {
    expect(classifyDuringCatchUp({ type: 'lottery-abort', abort: { reason: 'nope' } }, MID)).toBe(
      'cancel',
    );
  });

  it('cancels when a different ceremony opens', () => {
    expect(classifyDuringCatchUp({ type: 'lottery-start', start: START }, MID)).toBe('cancel');
    expect(
      classifyDuringCatchUp(
        {
          type: 'lottery-lobby',
          lobby: { title: 'next', teamCount: 3, totalBalls: 6, rows: START.rows },
        },
        MID,
      ),
    ).toBe('cancel');
  });

  describe('lottery-state snapshots', () => {
    const snap = (over: Partial<LotterySnapshot>): LotterySnapshot => ({
      phase: 'revealing',
      start: START,
      reveals: REVEALS.slice(0, 1),
      ...over,
    });

    it('ignores a snapshot that has not moved past what the catch-up knows', () => {
      expect(classifyDuringCatchUp({ type: 'lottery-state', snapshot: snap({}) }, MID)).toBe(
        'ignore',
      );
    });

    it('buffers a snapshot that ran ahead, so a poll-only client can still merge', () => {
      expect(
        classifyDuringCatchUp({ type: 'lottery-state', snapshot: snap({ reveals: REVEALS }) }, MID),
      ).toBe('buffer');
    });

    it('buffers a snapshot carrying a finish it has not seen', () => {
      expect(
        classifyDuringCatchUp(
          { type: 'lottery-state', snapshot: snap({ phase: 'finished', finish: FINISH }) },
          MID,
        ),
      ).toBe('buffer');
    });

    it('cancels on a snapshot for a phase that is no longer this running draw', () => {
      for (const phase of ['idle', 'lobby', 'waiting', 'aborted'] as const) {
        expect(
          classifyDuringCatchUp({ type: 'lottery-state', snapshot: snap({ phase }) }, MID),
        ).toBe('cancel');
      }
    });
  });
});

describe('catchUpTailFromSnapshot (#203)', () => {
  it('emits only the picks the catch-up has not accounted for', () => {
    const tail = catchUpTailFromSnapshot({ phase: 'revealing', reveals: REVEALS }, MID);
    // Picks 2 and 1 only — pick 3 is already known. Each carries its drum-roll (see the
    // drum-rolls describe below for why the beat matters).
    expect(tail.flatMap((e) => (e.type === 'lottery-reveal' ? [e.reveal] : []))).toEqual([
      REVEALS[1],
      REVEALS[2],
    ]);
  });

  it('appends the finish when the ceremony ended while catching up', () => {
    const tail = catchUpTailFromSnapshot(FINISHED, MID);
    expect(tail[tail.length - 1]).toEqual({ type: 'lottery-finish', finish: FINISH });
  });

  it('is empty when the snapshot matches what the catch-up already has', () => {
    expect(
      catchUpTailFromSnapshot({ phase: 'revealing', reveals: REVEALS }, { known: REVEALS.length }),
    ).toEqual([]);
    expect(catchUpTailFromSnapshot(FINISHED, { known: REVEALS.length, finish: FINISH })).toEqual(
      [],
    );
  });
});

describe('toPendingSteps (#203 pacing conversion)', () => {
  it('reproduces the absolute schedule exactly as per-step gaps', () => {
    // The #197 replay moved from absolute setTimeout(atMs) to a chained cursor so a catch-up can
    // append to a running schedule. This pins that the observable pacing did not change.
    const timeline = buildReplayTimeline(FINISHED);
    const steps = toPendingSteps(timeline);
    expect(steps.map((s) => s.delayMs)).toEqual([
      0, // first step fires immediately, as setTimeout(fn, 0) did
      REPLAY_MAX_STEP_MS, // beat → reveal: the drum-roll window
      REPLAY_DWELL_MS, // reveal → next beat: the dwell
      REPLAY_MAX_STEP_MS,
      REPLAY_DWELL_MS,
      REPLAY_MAX_STEP_MS,
      REPLAY_DWELL_MS, // last drop → finale
    ]);
    // Cumulative gaps must land back on the original absolute times.
    let t = 0;
    steps.forEach((step, i) => {
      t += step.delayMs;
      expect(t).toBe(timeline[i].atMs);
    });
    expect(steps.map((s) => s.event)).toEqual(timeline.map((s) => s.event));
  });

  it('is empty for an empty timeline', () => {
    expect(toPendingSteps([])).toEqual([]);
  });
});

describe('catch-up ceremony identity (#203)', () => {
  const RERUN_START: LotteryStart = { ...START, commitment: 'different-hash' };

  it('cancels when a revealing snapshot belongs to a different ceremony', () => {
    // A re-run reports `revealing` with its own history, so reveal counts cannot tell it apart —
    // only the commitment can. Without this the new run's picks splice onto the old replay.
    const snapshot: LotterySnapshot = {
      phase: 'revealing',
      start: RERUN_START,
      reveals: REVEALS,
    };
    expect(
      classifyDuringCatchUp({ type: 'lottery-state', snapshot }, { known: 1, commitment: 'hash' }),
    ).toBe('cancel');
  });

  it('still buffers when the commitment matches', () => {
    const snapshot: LotterySnapshot = { phase: 'revealing', start: START, reveals: REVEALS };
    expect(
      classifyDuringCatchUp({ type: 'lottery-state', snapshot }, { known: 1, commitment: 'hash' }),
    ).toBe('buffer');
  });

  it('cancels when history goes backwards, even with no commitment to compare', () => {
    const snapshot: LotterySnapshot = { phase: 'revealing', reveals: REVEALS.slice(0, 1) };
    expect(classifyDuringCatchUp({ type: 'lottery-state', snapshot }, { known: 3 })).toBe('cancel');
  });
});

describe('catchUpTailFromSnapshot drum-rolls (#203)', () => {
  it('pairs every tail reveal with its beat, so the fallback keeps the full animation', () => {
    // Reveal-only tails would stop the hopper spinning and skip the pull — a visible fidelity
    // cliff the moment playback crossed from the built timeline into the tail.
    const tail = catchUpTailFromSnapshot({ phase: 'revealing', reveals: REVEALS }, { known: 1 });
    expect(tail.map((e) => e.type)).toEqual([
      'lottery-beat',
      'lottery-reveal',
      'lottery-beat',
      'lottery-reveal',
    ]);
  });

  it("reconstructs each tail beat's remaining from the previous reveal", () => {
    const tail = catchUpTailFromSnapshot({ phase: 'revealing', reveals: REVEALS }, { known: 1 });
    const beats = tail.flatMap((e) => (e.type === 'lottery-beat' ? [e.beat] : []));
    expect(beats[0]).toEqual({ pick: 2, remaining: REVEALS[0].remaining });
    expect(beats[1]).toEqual({ pick: 1, remaining: REVEALS[1].remaining });
  });

  it('from known:0 the first beat still includes the team about to be drawn', () => {
    const tail = catchUpTailFromSnapshot({ phase: 'revealing', reveals: REVEALS }, { known: 0 });
    const first = tail[0];
    expect(first.type === 'lottery-beat' && first.beat.remaining).toEqual([
      REVEALS[0].team,
      ...REVEALS[0].remaining,
    ]);
  });

  it('yields nothing when the snapshot is shorter than what the catch-up knows', () => {
    expect(
      catchUpTailFromSnapshot({ phase: 'revealing', reveals: REVEALS.slice(0, 1) }, { known: 3 }),
    ).toEqual([]);
  });
});

describe('catch-up stale vs different-run disambiguation (#203)', () => {
  const shorter: LotterySnapshot = {
    phase: 'revealing',
    start: START,
    reveals: REVEALS.slice(0, 1),
  };

  it('ignores a shorter snapshot when the commitment proves it is our own run', () => {
    // Overlapping polls are routine on the fallback transport: a later response can land before
    // an earlier one. Cancelling would discard the catch-up and repaint the board backwards.
    expect(
      classifyDuringCatchUp(
        { type: 'lottery-state', snapshot: shorter },
        { known: 3, commitment: 'hash' },
      ),
    ).toBe('ignore');
  });

  it('cancels a shorter snapshot that carries no start to identify it', () => {
    // Half-identified: we know our own commitment, but the snapshot has nothing to compare it to.
    // Identity is unproven, so the conservative branch must win.
    expect(
      classifyDuringCatchUp(
        { type: 'lottery-state', snapshot: { phase: 'revealing', reveals: REVEALS.slice(0, 1) } },
        { known: 3, commitment: 'hash' },
      ),
    ).toBe('cancel');
  });

  it('cancels a shorter snapshot when we never recorded a commitment of our own', () => {
    expect(
      classifyDuringCatchUp(
        { type: 'lottery-state', snapshot: { phase: 'revealing', start: START, reveals: [] } },
        { known: 2 },
      ),
    ).toBe('cancel');
  });
});

describe('pending-beat carry (#207)', () => {
  const PENDING = { pick: 1, remaining: ['C'] };
  const MID: LotterySnapshot = {
    phase: 'revealing',
    start: START,
    reveals: REVEALS.slice(0, 2),
    pendingBeat: PENDING,
  };

  it('buildReplayTimeline ends on the in-flight beat, so the merge pick keeps its drum-roll', () => {
    const steps = buildReplayTimeline(MID);
    const last = steps[steps.length - 1];
    expect(last.event.type).toBe('lottery-beat');
    expect(last.event.type === 'lottery-beat' && last.event.beat.pick).toBe(1);
    // Scheduled where the next pick's beat would go — after the previous reveal's dwell.
    const stepMs = replayStepMs(MID);
    expect(last.atMs).toBe(2 * (stepMs + REPLAY_DWELL_MS));
  });

  it('buildReplayTimeline never emits a pending beat on a sealed snapshot', () => {
    const steps = buildReplayTimeline({ ...FINISHED, pendingBeat: PENDING });
    expect(steps[steps.length - 1].event.type).toBe('lottery-finish');
  });

  it('classifyDuringCatchUp buffers a snapshot whose only news is a fresh drum-roll', () => {
    expect(classifyDuringCatchUp({ type: 'lottery-state', snapshot: MID }, { known: 2 })).toBe(
      'buffer',
    );
  });

  it('classifyDuringCatchUp ignores a re-served pending beat it already queued', () => {
    expect(
      classifyDuringCatchUp({ type: 'lottery-state', snapshot: MID }, { known: 2, beatPick: 1 }),
    ).toBe('ignore');
  });

  it('catchUpTailFromSnapshot splices a new pending beat after the reveal tail', () => {
    const tail = catchUpTailFromSnapshot(MID, { known: 1 });
    expect(tail.map((e) => e.type)).toEqual(['lottery-beat', 'lottery-reveal', 'lottery-beat']);
    const last = tail[tail.length - 1];
    expect(last.type === 'lottery-beat' && last.beat.pick).toBe(1);
  });

  it('catchUpTailFromSnapshot skips a pending beat the catch-up already has', () => {
    expect(catchUpTailFromSnapshot(MID, { known: 2, beatPick: 1 })).toEqual([]);
  });

  it('catchUpTailFromSnapshot never queues a beat past a finish', () => {
    const tail = catchUpTailFromSnapshot({ ...FINISHED, pendingBeat: PENDING }, { known: 3 });
    expect(tail.map((e) => e.type)).toEqual(['lottery-finish']);
  });
});

describe('catchUpPace (#207 convergence)', () => {
  it('keeps full pacing near the merge and hurries while behind', () => {
    expect(catchUpPace(2500, 1)).toBe(2500);
    expect(catchUpPace(2500, 2)).toBe(2500);
    expect(catchUpPace(2500, 4)).toBe(1500);
    expect(catchUpPace(2500, 7)).toBe(875);
  });

  it('converges at the bot delay floor: a hurried pick costs less than 5s of live time', () => {
    // Per pick the catch-up pays one beat window + one dwell. At full pacing that is
    // 2500 + 1800 = 4300ms against a 5000ms live cadence — 700ms/pick of headroom, which is
    // the non-convergence #207 reports. Hurried, the same pick must cost decisively less.
    const hurried = catchUpPace(2500, 4) + catchUpPace(1800, 4);
    expect(hurried).toBeLessThanOrEqual(3000);
    const sprint = catchUpPace(2500, 8) + catchUpPace(1800, 8);
    expect(sprint).toBeLessThanOrEqual(1600);
  });

  it('floors a hurried delay so a step is never instantaneous, but keeps zero at zero', () => {
    expect(catchUpPace(300, 10)).toBe(250);
    expect(catchUpPace(0, 10)).toBe(0);
  });
});
