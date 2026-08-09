/**
 * Playback cursor (#204): pause/resume, append-while-running, and the hidden-tab policy.
 *
 * Driven by a fake clock rather than real timers, so the assertions are about *replay time* — the
 * thing a backgrounded tab distorts — and the suite stays instant and deterministic.
 */

import { describe, expect, it } from 'vitest';

import type { LotteryEvent, LotteryReveal } from '../lotteryStage.js';
import {
  createPlaybackCursor,
  onHiddenAction,
  type PlaybackClock,
  type PlaybackCursor,
} from '../client/playbackCursor.js';
import type { PendingStep } from '../client/replayTimeline.js';

/** A hand-driven clock + timer queue: `advance(ms)` fires everything due, in due order. */
function fakeClock(): PlaybackClock & { advance(ms: number): void; armed(): number } {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer(fn, ms) {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, fn });
      return handle;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    now: () => now,
    armed: () => timers.size,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [handle, timer] = due;
        timers.delete(handle);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
  };
}

function reveal(pick: number): LotteryReveal {
  return { pick, team: `T${pick}`, balls: 1, oddsPct: 10, remaining: [] };
}

function revealStep(pick: number, delayMs: number): PendingStep {
  return { delayMs, event: { type: 'lottery-reveal', reveal: reveal(pick) } };
}

/** Collect the picks a cursor actually played, in order. */
function harness(steps: PendingStep[]) {
  const clock = fakeClock();
  const played: number[] = [];
  let drained = 0;
  const cursor = createPlaybackCursor(
    steps,
    (event: LotteryEvent) => {
      if (event.type === 'lottery-reveal') played.push(event.reveal.pick);
    },
    () => {
      drained += 1;
    },
    clock,
  );
  return { clock, cursor, played, drained: () => drained };
}

describe('createPlaybackCursor', () => {
  it('plays steps at their chained delays', () => {
    const { clock, cursor, played } = harness([
      revealStep(1, 1000),
      revealStep(2, 1000),
      revealStep(3, 1000),
    ]);
    cursor.start();
    clock.advance(999);
    expect(played).toEqual([]);
    clock.advance(1);
    expect(played).toEqual([1]);
    clock.advance(2000);
    expect(played).toEqual([1, 2, 3]);
  });

  it('reports drained once the queue empties on its own', () => {
    const { clock, cursor, drained } = harness([revealStep(1, 500)]);
    cursor.start();
    expect(drained()).toBe(0);
    clock.advance(500);
    expect(drained()).toBe(1);
    expect(cursor.isRunning()).toBe(false);
  });

  it('does not start, or drain, on an empty queue', () => {
    const { cursor, drained } = harness([]);
    cursor.start();
    expect(cursor.isRunning()).toBe(false);
    expect(drained()).toBe(0);
  });

  // The bug #204 exists to fix: hidden-tab timer batching used to fire the whole queue in one wake.
  it('fires nothing while paused, however long the tab stays hidden', () => {
    const { clock, cursor, played } = harness([revealStep(1, 1000), revealStep(2, 1000)]);
    cursor.start();
    clock.advance(400);
    cursor.pause();
    clock.advance(60_000);
    expect(played).toEqual([]);
    expect(clock.armed()).toBe(0);
  });

  it('resumes on the remainder of the head step, not its full delay', () => {
    const { clock, cursor, played } = harness([revealStep(1, 1000), revealStep(2, 1000)]);
    cursor.start();
    clock.advance(700);
    cursor.pause();
    clock.advance(30_000);
    cursor.resume();
    clock.advance(299);
    expect(played).toEqual([]); // 300ms was left, not a fresh 1000
    clock.advance(1);
    expect(played).toEqual([1]);
  });

  it('keeps full pacing for the steps after the one it was paused on', () => {
    const { clock, cursor, played } = harness([revealStep(1, 1000), revealStep(2, 1000)]);
    cursor.start();
    clock.advance(700);
    cursor.pause();
    cursor.resume();
    clock.advance(300);
    expect(played).toEqual([1]);
    clock.advance(999);
    expect(played).toEqual([1]); // step 2 still owes its own full delay
    clock.advance(1);
    expect(played).toEqual([1, 2]);
  });

  it('freezes remainingMs while paused and reports it for re-arming the pull', () => {
    const { clock, cursor } = harness([revealStep(1, 1000)]);
    cursor.start();
    clock.advance(250);
    expect(cursor.remainingMs()).toBe(750);
    cursor.pause();
    clock.advance(10_000);
    expect(cursor.remainingMs()).toBe(750);
    expect(cursor.isPaused()).toBe(true);
  });

  it('survives repeated pause/resume without drift or double-firing', () => {
    const { clock, cursor, played } = harness([revealStep(1, 1000)]);
    cursor.start();
    for (let i = 0; i < 4; i += 1) {
      clock.advance(100);
      cursor.pause();
      clock.advance(5_000);
      cursor.resume();
    }
    expect(played).toEqual([]);
    clock.advance(600);
    expect(played).toEqual([1]);
    clock.advance(10_000);
    expect(played).toEqual([1]); // exactly once
  });

  it('ignores pause/resume that do not apply', () => {
    const { clock, cursor, played } = harness([revealStep(1, 1000)]);
    cursor.resume(); // never started
    cursor.pause();
    expect(cursor.isPaused()).toBe(false);
    cursor.start();
    cursor.resume(); // running, not paused
    expect(cursor.isPaused()).toBe(false);
    clock.advance(1000);
    expect(played).toEqual([1]);
  });

  it('appends onto a running queue and keeps playing through the tail', () => {
    const { clock, cursor, played, drained } = harness([revealStep(1, 1000)]);
    cursor.start();
    clock.advance(500);
    cursor.append(revealStep(2, 1000));
    clock.advance(500);
    expect(played).toEqual([1]);
    expect(drained()).toBe(0); // the tail kept it alive
    clock.advance(1000);
    expect(played).toEqual([1, 2]);
    expect(drained()).toBe(1);
  });

  it('ignores an append that lands after the queue drained', () => {
    const { clock, cursor, played } = harness([revealStep(1, 100)]);
    cursor.start();
    clock.advance(100);
    expect(played).toEqual([1]);
    expect(cursor.isRunning()).toBe(false);
    cursor.pause(); // drained already, so this is a no-op
    cursor.append(revealStep(2, 100));
    clock.advance(1000);
    expect(played).toEqual([1]); // nothing is left to fire it — the cursor stays stopped
  });

  it('holds an appended step while paused, then plays it on resume', () => {
    const { clock, cursor, played } = harness([revealStep(1, 1000), revealStep(2, 1000)]);
    cursor.start();
    clock.advance(200);
    cursor.pause();
    cursor.append(revealStep(3, 1000));
    clock.advance(10_000);
    expect(played).toEqual([]);
    cursor.resume();
    clock.advance(3000);
    expect(played).toEqual([1, 2, 3]);
  });

  // Guards the "shift only when it fires" rule: a step armed but not yet fired must still be
  // visible to a caller draining the queue, or a skip/cancel holes the board by one pick.
  it('keeps the in-flight step in pending() until its timer fires', () => {
    const { clock, cursor } = harness([revealStep(1, 1000), revealStep(2, 1000)]);
    cursor.start();
    clock.advance(500);
    expect(cursor.pending().map((s) => s.delayMs)).toEqual([1000, 1000]);
    expect(cursor.peek()?.event.type).toBe('lottery-reveal');
    clock.advance(500);
    expect(cursor.pending()).toHaveLength(1);
  });

  it('hands back a copy from pending(), so a drain-then-stop caller keeps its list', () => {
    const { cursor } = harness([revealStep(1, 1000), revealStep(2, 1000)]);
    cursor.start();
    const queued = cursor.pending();
    cursor.stop();
    expect(queued).toHaveLength(2); // still usable after the cursor cleared itself
    expect(cursor.pending()).toEqual([]);
  });

  it('stops for good — no further steps, no drain callback', () => {
    const { clock, cursor, played, drained } = harness([revealStep(1, 1000), revealStep(2, 1000)]);
    cursor.start();
    cursor.stop();
    clock.advance(10_000);
    expect(played).toEqual([]);
    expect(drained()).toBe(0);
    expect(cursor.isRunning()).toBe(false);
    expect(clock.armed()).toBe(0);
  });

  // `applyReplayStep` ends playback from inside the handler when it plays a `lottery-finish`.
  it('does not re-arm after a step whose handler stopped it', () => {
    const clock = fakeClock();
    const played: number[] = [];
    const steps = [revealStep(1, 1000), revealStep(2, 1000)];
    const cursor = createPlaybackCursor(
      steps,
      (event) => {
        if (event.type === 'lottery-reveal') {
          played.push(event.reveal.pick);
          cursor.stop(); // the finish-step pattern
        }
      },
      () => {
        throw new Error('drained should not fire after a handler stop');
      },
      clock,
    );
    cursor.start();
    clock.advance(1000);
    expect(played).toEqual([1]);
    clock.advance(10_000);
    expect(played).toEqual([1]);
  });
});

describe('scaleDelay (#207 catch-up hurry)', () => {
  function scaledHarness(steps: PendingStep[], scale: (d: number, depth: number) => number) {
    const clock = fakeClock();
    const played: number[] = [];
    const seenDepths: number[] = [];
    const cursor = createPlaybackCursor(
      steps,
      (event: LotteryEvent) => {
        if (event.type === 'lottery-reveal') played.push(event.reveal.pick);
      },
      () => {},
      clock,
      (d, depth) => {
        seenDepths.push(depth);
        return scale(d, depth);
      },
    );
    return { clock, cursor, played, seenDepths };
  }

  it('applies the scaled delay at arm time', () => {
    const { clock, cursor, played } = scaledHarness(
      [revealStep(1, 1000), revealStep(2, 1000)],
      (d) => d / 2,
    );
    cursor.start();
    clock.advance(499);
    expect(played).toEqual([]);
    clock.advance(1);
    expect(played).toEqual([1]);
    clock.advance(500);
    expect(played).toEqual([1, 2]);
  });

  it('reports the queue depth as of arming, so appends re-tighten later steps', () => {
    const { clock, cursor, seenDepths } = scaledHarness([revealStep(1, 1000)], (d, depth) =>
      depth > 1 ? d / 2 : d,
    );
    cursor.start(); // armed at depth 1 → full delay
    cursor.append(revealStep(2, 1000));
    cursor.append(revealStep(3, 1000));
    clock.advance(1000); // step 1 fires; step 2 arms at depth 2 → hurried
    clock.advance(500); // step 2 fires; step 3 arms at depth 1 → full again
    clock.advance(1000);
    expect(seenDepths).toEqual([1, 2, 1]);
  });

  it('pause banks the scaled remainder, not the unscaled one', () => {
    const { clock, cursor, played } = scaledHarness([revealStep(1, 1000)], (d) => d / 2);
    cursor.start(); // armed with 500
    clock.advance(300);
    cursor.pause();
    expect(cursor.remainingMs()).toBe(200);
    cursor.resume();
    clock.advance(200);
    expect(played).toEqual([1]);
  });
});

describe('nextDelayMs (#265 — the gap a step handler can actually read)', () => {
  /**
   * Every reading here is taken from INSIDE `onStep`, because that is the only place the client
   * ever asks: the exit planner needs to know how long this reveal has before the next event
   * supersedes it, and it is running as that reveal's handler.
   */
  function readFromInsideSteps(steps: PendingStep[], scale?: (d: number, depth: number) => number) {
    const clock = fakeClock();
    const next: number[] = [];
    const remaining: number[] = [];
    const firedAt: number[] = [];
    const cursor: PlaybackCursor = createPlaybackCursor(
      steps,
      () => {
        firedAt.push(clock.now());
        next.push(cursor.nextDelayMs());
        remaining.push(cursor.remainingMs());
      },
      () => {},
      clock,
      scale,
    );
    cursor.start();
    clock.advance(100_000);
    return { next, remaining, firedAt };
  }

  // The regression that made this method necessary: `arm` nulls the timer handle before it
  // dispatches, so `remainingMs()` short-circuits to 0 for the whole duration of a step. An
  // earlier revision of the exit planner read it there, took the 0 as "unknown", and silently
  // budgeted every replay against the LIVE pacing — a dead branch under passing tests.
  it('answers from inside a step, where remainingMs() structurally cannot', () => {
    const { next, remaining } = readFromInsideSteps([
      revealStep(1, 1000),
      revealStep(2, 700),
      revealStep(3, 400),
    ]);
    expect(remaining).toEqual([0, 0, 0]);
    expect(next).toEqual([700, 400, 0]);
  });

  // The value has to be the one `schedule` is about to arm — scale included — or the planner is
  // budgeting against a cadence the cursor is not actually playing.
  it('reports the scaled delay, and it matches the gap that then really elapses', () => {
    const { next, firedAt } = readFromInsideSteps(
      [revealStep(1, 1000), revealStep(2, 1000), revealStep(3, 1000)],
      (d, depth) => (depth > 1 ? d * 0.35 : d), // catchUpPace's sprint shape
    );
    const realGaps = firedAt.slice(1).map((at, i) => at - firedAt[i]);
    expect(next.slice(0, -1)).toEqual(realGaps);
    expect(next).toEqual([350, 1000, 0]);
  });

  // Pinning the wrinkle rather than leaving it to be rediscovered: this is a reading FOR step
  // handlers. `schedule` deliberately leaves the head in the queue until its timer fires, so
  // outside a handler the head has not been shifted and this reads the armed step itself.
  // Callers outside a step want `remainingMs`.
  it('is a step-handler reading — outside one the head has not been shifted yet', () => {
    const clock = fakeClock();
    const cursor = createPlaybackCursor(
      [revealStep(1, 1000), revealStep(2, 700)],
      () => {},
      () => {},
      clock,
    );
    expect(cursor.nextDelayMs()).toBe(0); // not running yet
    cursor.start();
    expect(cursor.nextDelayMs()).toBe(1000); // the armed head, not the 700 behind it
  });

  // A frozen cursor has no runway to report: `resume` re-arms from the banked remainder, so the
  // head's own delay would overstate it — and a planner handed that number would budget a
  // flourish into a gap the resume immediately cuts short.
  it('reports 0 while paused rather than a delay that will not be armed', () => {
    const clock = fakeClock();
    const cursor = createPlaybackCursor(
      [revealStep(1, 1000), revealStep(2, 700)],
      () => {},
      () => {},
      clock,
    );
    cursor.start();
    clock.advance(800);
    cursor.pause();
    expect(cursor.remainingMs()).toBe(200); // banked, and still the right question to ask here
    expect(cursor.nextDelayMs()).toBe(0);
    cursor.resume();
    expect(cursor.nextDelayMs()).toBe(1000);
  });
});

describe('onHiddenAction', () => {
  // A sealed re-watch loses nothing by waiting — freeze it and hand it back intact.
  it('pauses a replay', () => {
    expect(onHiddenAction('replay')).toBe('pause');
  });

  // A catch-up races a live draw; pausing it only returns the viewer further behind, so cancel and
  // let the live snapshot repaint the present on return.
  it('cancels a catch-up', () => {
    expect(onHiddenAction('catchup')).toBe('cancel');
  });

  it('does nothing when no playback is running', () => {
    expect(onHiddenAction(null)).toBe('none');
  });
});
