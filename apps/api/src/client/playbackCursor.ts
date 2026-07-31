/**
 * Pausable playback cursor for the lottery machine (#204).
 *
 * #197 scheduled a replay up front — one `setTimeout` per step at an absolute offset. Chrome
 * throttles and batches timers in a hidden tab, so alt-tabbing mid-replay fired the whole queue in
 * a single wake on return and the replay burst straight to the sealed board: the viewer lost
 * exactly the re-watch they had asked for.
 *
 * #203 then replaced that batch with a chained cursor, because a catch-up appends to a schedule
 * that is already running. This module keeps the chained shape and gives it the pause/resume the
 * batch scheduler was going to provide: on hide, bank whatever is left of the head step's delay and
 * drop the timer; on show, re-arm from the banked remainder.
 *
 * Timers and the clock are injected, so this unit-tests headless in the node-env vitest setup — no
 * browser, no jsdom. The queue and the "when" live here; `lottery.ts` owns the "what" (the DOM).
 */

import type { LotteryEvent } from '../lotteryStage.js';
import type { PendingStep } from './replayTimeline.js';

/** The two things a local playback can be; they differ in what live news and a hidden tab mean. */
export type PlaybackMode = 'replay' | 'catchup';

/** Injected timer/clock seam — `window` in the browser, a fake clock in tests. */
export interface PlaybackClock {
  setTimer(fn: () => void, ms: number): number;
  clearTimer(handle: number): void;
  /** Monotonic-enough milliseconds; `Date.now` and `performance.now` both work. */
  now(): number;
}

export interface PlaybackCursor {
  /** Arm the first step. No-op once started, or if there is nothing queued. */
  start(): void;
  /**
   * Queue a step onto the tail (a catch-up splicing live news). It is armed only while the cursor
   * is running and un-paused: an append onto a paused cursor waits for the resume, and one onto a
   * stopped or already-drained cursor is inert — queued, but nothing is left to fire it.
   */
  append(step: PendingStep): void;
  /** Freeze: bank what is left of the head step's delay and drop the timer. */
  pause(): void;
  /** Unfreeze: re-arm the head step against the banked remainder, not its full delay. */
  resume(): void;
  /** Cancel for good — timer dropped, queue emptied, no further steps fire. */
  stop(): void;
  /** A copy of what has not played yet, for callers that drain it (skip, cancel-flush). */
  pending(): PendingStep[];
  /** The step whose timer is armed (or banked while paused), or `undefined` once drained. */
  peek(): PendingStep | undefined;
  /** Milliseconds left before the head step fires. Frozen while paused. */
  remainingMs(): number;
  /** True between `start()` and the queue draining (or `stop()`), paused or not. */
  isRunning(): boolean;
  /** True while frozen by {@link pause}. */
  isPaused(): boolean;
}

/**
 * Build a cursor over `steps` (relative per-step delays, as {@link toPendingSteps} emits).
 *
 * `onStep` applies one event and may itself stop the cursor — a `lottery-finish` step ends playback
 * from inside the client's handler — so nothing is re-armed after a step that stopped us.
 * `onDrained` fires once the queue empties on its own, which is how a catch-up learns it has
 * reached the present.
 */
export function createPlaybackCursor(
  steps: PendingStep[],
  onStep: (event: LotteryEvent) => void,
  onDrained: () => void,
  clock: PlaybackClock,
): PlaybackCursor {
  const queue: PendingStep[] = [...steps];
  let timer: number | null = null;
  let running = false;
  let paused = false;
  /** The delay the live timer was armed with, and when — together they give the pause remainder. */
  let armedDelayMs = 0;
  let armedAt = 0;
  /** What is left of the head step's delay, banked at the last pause. */
  let bankedMs = 0;

  function remainingMs(): number {
    if (!running) return 0;
    if (paused) return bankedMs;
    if (timer === null) return 0;
    return Math.max(0, armedDelayMs - (clock.now() - armedAt));
  }

  function arm(delayMs: number): void {
    armedDelayMs = delayMs;
    armedAt = clock.now();
    timer = clock.setTimer(() => {
      timer = null;
      // Consumed now that it is actually being applied — see the note in `schedule`.
      const step = queue.shift();
      if (!step) return;
      onStep(step.event);
      schedule(); // guarded: a step that stopped the cursor does not re-arm
    }, delayMs);
  }

  /**
   * Arm the head step, or finish.
   *
   * The step stays at the head of the queue until its timer actually fires. Shifting it out at
   * schedule time would leave one step living only inside the closure, and a caller draining
   * `pending()` — a skip, or the cancel-flush — would silently drop it, holing the board by exactly
   * one pick.
   */
  function schedule(): void {
    if (!running || paused || timer !== null) return;
    const next = queue[0];
    if (!next) {
      running = false;
      onDrained();
      return;
    }
    arm(next.delayMs);
  }

  function clearTimer(): void {
    if (timer !== null) {
      clock.clearTimer(timer);
      timer = null;
    }
  }

  return {
    start(): void {
      // An empty timeline never becomes a playback — the client checks that before building one,
      // and starting empty here would fire `onDrained` for a playback that never showed anything.
      if (running || queue.length === 0) return;
      running = true;
      paused = false;
      bankedMs = 0;
      schedule();
    },
    append(step: PendingStep): void {
      queue.push(step);
      schedule(); // no-op if a step is already in flight, while paused, or once drained/stopped
    },
    pause(): void {
      if (!running || paused) return;
      bankedMs = remainingMs();
      paused = true;
      clearTimer();
    },
    resume(): void {
      if (!running || !paused) return;
      paused = false;
      const next = queue[0];
      if (!next) {
        running = false;
        onDrained();
        return;
      }
      // Re-arm against the banked remainder rather than the step's full delay: a viewer who
      // alt-tabbed 200ms before a drop should get that drop 200ms after coming back, not a fresh
      // full drum-roll.
      arm(bankedMs);
      bankedMs = 0;
    },
    stop(): void {
      clearTimer();
      running = false;
      paused = false;
      bankedMs = 0;
      queue.length = 0;
    },
    // A copy: callers drain this and then `stop()` us, and mutating the live queue underneath them
    // would empty the very list they are iterating.
    pending: () => [...queue],
    peek: () => queue[0],
    remainingMs,
    isRunning: () => running,
    isPaused: () => paused,
  };
}

/**
 * What backgrounding the tab means for a running playback (#204).
 *
 * A **replay** re-watches a sealed ceremony: nothing moves on while the viewer is away, so freezing
 * and resuming hands back exactly the re-watch they asked for.
 *
 * A **catch-up** races a ceremony that keeps drawing picks while the tab is hidden, so pausing it
 * would only compound the lag — the viewer returns strictly further behind than they left, and
 * catch-up already has little convergence headroom at short reveal delays (#207). Cancelling
 * instead lets the live snapshot repaint the true present on return, with the catch-up re-offered
 * if the draw is still running. Nobody is watching a hidden tab; the honest state beats a stale
 * animation that can no longer win its race.
 */
export function onHiddenAction(mode: PlaybackMode | null): 'pause' | 'cancel' | 'none' {
  if (mode === 'replay') return 'pause';
  if (mode === 'catchup') return 'cancel';
  return 'none';
}
