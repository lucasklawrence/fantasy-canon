/**
 * Replay timeline for the lottery machine (#197): turns a stage snapshot into the sequence of
 * synthetic beat/reveal/finish events that re-runs the reveal animation locally.
 *
 * Fairness-safe by construction — the snapshot already carries the full *published* reveal
 * history, so a replay is a re-render of public data on a client-side timer: no server state, no
 * re-draw, no protocol change. Pure (no DOM, no timers) so it unit-tests without a browser; the
 * client in `lottery.ts` owns the actual `setTimeout` scheduling.
 *
 * Two modes share the timeline builder (#203):
 *   - **replay** (finished phase) — re-watch a sealed ceremony. Any real live news cancels it.
 *   - **catch-up** (mid-reveal) — a late joiner watches from pick one while the draw is still
 *     running. Live beats/reveals cannot cancel it (they *are* the thing being caught up to), so
 *     they buffer and splice onto the tail; {@link classifyDuringCatchUp} is that policy, kept
 *     here and pure so the merge rules are testable without a DOM.
 */

import type { LotteryEvent, LotteryFinish, LotterySnapshot } from '../lotteryTypes.js';

/**
 * Replay pacing cap per drum-roll. The live window (`start.delayMs`) is sized for first-watch
 * suspense — often 5–10s a pick — which drags on a re-watch; replay keeps the full pull + drop
 * animation but tightens the wait (#197 decision: compressed, ~2.5s/pick).
 */
export const REPLAY_MAX_STEP_MS = 2500;

/** Pause after each drop (and before the finale) so the revealed ball gets its moment. */
export const REPLAY_DWELL_MS = 1800;

/** One scheduled step: fire `event` `atMs` after the replay starts. */
export interface ReplayStep {
  atMs: number;
  event: LotteryEvent;
}

/** The compressed drum-roll window — also the pull window the client passes to `renderDrum`. */
export function replayStepMs(snapshot: LotterySnapshot): number {
  const live = snapshot.start?.delayMs;
  return typeof live === 'number' && live > 0
    ? Math.min(live, REPLAY_MAX_STEP_MS)
    : REPLAY_MAX_STEP_MS;
}

/**
 * Build the full timeline: for each recorded reveal a beat (drum-roll) then the reveal itself,
 * `replayStepMs` apart, with a dwell between picks; the finish (final board + confetti) closes it
 * out. Reveals are replayed in recorded broadcast order — the builder is direction-agnostic, so a
 * future first-to-last ceremony (#196) replays correctly with no change here.
 */
export function buildReplayTimeline(snapshot: LotterySnapshot): ReplayStep[] {
  const stepMs = replayStepMs(snapshot);
  const steps: ReplayStep[] = [];
  const reveals = snapshot.reveals;
  let t = 0;
  for (let i = 0; i < reveals.length; i += 1) {
    const reveal = reveals[i];
    // A beat's `remaining` includes the team about to be drawn: at the first pick that is every
    // team (odds-table order); afterwards it is whatever the previous reveal left in the hopper.
    const remaining =
      i === 0
        ? (snapshot.start?.rows.map((row) => row.team) ?? [reveal.team, ...reveal.remaining])
        : reveals[i - 1].remaining;
    steps.push({
      atMs: t,
      event: { type: 'lottery-beat', beat: { pick: reveal.pick, remaining } },
    });
    t += stepMs;
    steps.push({ atMs: t, event: { type: 'lottery-reveal', reveal } });
    t += REPLAY_DWELL_MS;
  }
  if (snapshot.finish) {
    steps.push({ atMs: t, event: { type: 'lottery-finish', finish: snapshot.finish } });
  } else if (snapshot.pendingBeat) {
    // The draw was mid-drum-roll when this snapshot was taken (#207): the pick in flight has a
    // beat but no reveal yet. Without this step a catch-up started during a drum-roll plays that
    // pick as a bare drop — stopped hopper, no pull — because nothing ever re-arms the suspense.
    steps.push({ atMs: t, event: { type: 'lottery-beat', beat: snapshot.pendingBeat } });
  }
  return steps;
}

/**
 * What a live event means while a **catch-up** is running (#203).
 *
 *   - `buffer` — same ceremony, still unfolding. Queue it and splice it onto the tail so the
 *     catch-up plays right through into the present instead of being cut short.
 *   - `ignore` — an echo of what the catch-up is already replaying (the polling fallback or a WS
 *     reconnect re-serving a snapshot we've seen). Drop it; the catch-up runs on.
 *   - `cancel` — real news about a *different* situation. Stop and show live state.
 */
export type CatchUpVerdict = 'buffer' | 'ignore' | 'cancel';

/** What the catch-up is currently replaying, for the echo and identity checks. */
export interface CatchUpContext {
  /** Reveal count the running catch-up already knows about (source + everything buffered). */
  known: number;
  /** The finish it has already buffered, if the ceremony ended mid-catch-up. */
  finish?: LotteryFinish;
  /**
   * The commitment of the ceremony being caught up on. Reveal counts alone cannot tell a re-run
   * apart from the original — a restarted draw reports `revealing` with its own (possibly shorter)
   * history — so a mismatch here is the only reliable "this is a different ceremony" signal.
   */
  commitment?: string;
  /**
   * The pick of the last drum-roll beat the catch-up has queued or played (#207). Polling re-serves
   * the same `pendingBeat` every couple of seconds, so without this the fallback transport would
   * queue the same drum-roll over and over.
   */
  beatPick?: number;
}

/** Two finishes describe the same sealed result. Shared so both modes' echo rules cannot drift. */
export function sameFinishOrder(
  a: LotteryFinish | undefined,
  b: LotteryFinish | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.verify.commitment === b.verify.commitment &&
    JSON.stringify(a.order) === JSON.stringify(b.order)
  );
}

/** One queued step of a chained playback: fire `event` `delayMs` after the previous one. */
export interface PendingStep {
  delayMs: number;
  event: LotteryEvent;
}

/**
 * Catch-up pacing (#207): how much of a step's delay to actually wait, given how deep the queue
 * is. At the bot's 5s delay floor, full catch-up pacing costs 4.3s a pick — 700ms/pick of
 * headroom — so a catch-up started several picks in could never reach the present; it trailed
 * until the buffered finish played. Hurry while far behind, breathe near the merge:
 *
 *   depth > 6 — sprint (35%): the viewer is way back; picks flash by, the gap closes fast.
 *   depth > 2 — hurry (60%): 60% of 4.3s = 2.6s/pick, decisively under the 5s floor.
 *   otherwise — full pacing: the last pick or two before the merge get their whole drum-roll.
 *
 * Nonzero delays are floored so a hurried step is never instantaneous — the reveal still needs
 * its drop animation. A zero delay stays zero: the timeline's first step fires immediately.
 */
export function catchUpPace(delayMs: number, queueDepth: number): number {
  if (delayMs <= 0) return 0;
  const factor = queueDepth > 6 ? 0.35 : queueDepth > 2 ? 0.6 : 1;
  return Math.max(250, Math.round(delayMs * factor));
}

/** Absolute `atMs` schedule → per-step gaps, for a chained playback cursor. */
export function toPendingSteps(timeline: ReplayStep[]): PendingStep[] {
  let prev = 0;
  return timeline.map((step) => {
    const delayMs = Math.max(0, step.atMs - prev);
    prev = step.atMs;
    return { delayMs, event: step.event };
  });
}

/**
 * The cancel-vs-buffer policy. Unlike a finished-phase replay — where *any* live event is news and
 * wins — a catch-up is by definition running alongside the ceremony it is replaying, so the
 * ceremony's own beats and reveals must never kill it (the old live-wins rule would cancel on the
 * very first beat, which is exactly the bug that kept #197 from shipping this).
 *
 * A `lottery-finish` buffers rather than cancels: the ceremony ending is the finale the late
 * joiner is being caught up *to*, so it becomes the tail step instead of a jump cut.
 *
 * An abort, or any event that opens a different ceremony (`start`/`lobby`), cancels — continuing
 * to animate a draw that was aborted or superseded would misrepresent the live state.
 */
export function classifyDuringCatchUp(
  event: LotteryEvent,
  context: CatchUpContext,
): CatchUpVerdict {
  switch (event.type) {
    case 'lottery-beat':
      return 'buffer';
    case 'lottery-reveal':
      return 'buffer';
    case 'lottery-finish':
      // A re-broadcast of a finish already queued is an echo, not a second finale.
      return sameFinishOrder(event.finish, context.finish) ? 'ignore' : 'buffer';
    case 'lottery-abort':
      return 'cancel';
    case 'lottery-start':
      return 'cancel';
    case 'lottery-lobby':
      return 'cancel';
    case 'lottery-state': {
      const snapshot = event.snapshot;
      // A snapshot that opens a different ceremony, or reports one that ended badly, is news.
      if (snapshot.phase !== 'revealing' && snapshot.phase !== 'finished') return 'cancel';
      // A re-run reports `revealing` too, and its history can be shorter than ours — so counts
      // cannot distinguish it. The commitment can: a mismatch means we are animating a ceremony
      // that no longer exists, and must stop rather than splice its picks onto ours.
      const identified = context.commitment !== undefined && snapshot.start !== undefined;
      if (identified && snapshot.start?.commitment !== context.commitment) return 'cancel';
      if (snapshot.reveals.length < context.known) {
        // Shorter history: a different (shorter) run if we cannot prove otherwise — but when the
        // commitment matches it is our own run, and this is just a stale or out-of-order delivery.
        // Overlapping polls make that routine on the fallback transport, and cancelling on one
        // would throw away the catch-up and repaint the board a pick backwards.
        return identified ? 'ignore' : 'cancel';
      }
      // Otherwise it describes the same run. If it *has* advanced past us — new picks, a new
      // finish, or a drum-roll we haven't queued (#207) — buffer the remainder so a poll-only
      // client still merges; repainting mid-catch-up would blow the board away instead. With
      // nothing new it is a pure echo from the polling fallback.
      if (snapshot.reveals.length > context.known) return 'buffer';
      if (snapshot.finish && !sameFinishOrder(snapshot.finish, context.finish)) return 'buffer';
      if (snapshot.pendingBeat && snapshot.pendingBeat.pick !== context.beatPick) return 'buffer';
      return 'ignore';
    }
    default: {
      // Exhaustive today; the `never` binding turns a future 8th event variant into a compile
      // error rather than a silent 'cancel'.
      const unreachable: never = event;
      void unreachable;
      return 'cancel';
    }
  }
}

/**
 * Turn a `lottery-state` snapshot that ran ahead of the catch-up into the tail events it implies.
 * The polling fallback only ever hands us whole snapshots, so without this a poll-only client
 * (no WebSocket) could never merge back into the present.
 */
export function catchUpTailFromSnapshot(
  snapshot: LotterySnapshot,
  context: CatchUpContext,
): LotteryEvent[] {
  const tail: LotteryEvent[] = [];
  // Each reveal gets its drum-roll, exactly as `buildReplayTimeline` pairs them. Without the beat
  // the hopper stops spinning and the pull animation never fires, so the fallback transport would
  // visibly degrade the moment playback crossed from the built timeline into this tail.
  for (let i = context.known; i < snapshot.reveals.length; i += 1) {
    const reveal = snapshot.reveals[i];
    const previous = snapshot.reveals[i - 1];
    // A beat's `remaining` includes the team about to be drawn — that's whatever the previous
    // reveal left in the hopper, or (no previous) this reveal's leftovers plus its own team.
    const remaining = previous ? previous.remaining : [reveal.team, ...reveal.remaining];
    tail.push({ type: 'lottery-beat', beat: { pick: reveal.pick, remaining } });
    tail.push({ type: 'lottery-reveal', reveal });
  }
  if (snapshot.finish && !sameFinishOrder(snapshot.finish, context.finish)) {
    tail.push({ type: 'lottery-finish', finish: snapshot.finish });
  } else if (snapshot.pendingBeat && snapshot.pendingBeat.pick !== context.beatPick) {
    // The live draw is mid-drum-roll for a pick we haven't queued (#207): splice its beat onto
    // the tail so the poll-only path re-arms the suspense — and so the queue drains right after
    // a *beat*, which is what lets the handoff keep the pull for the pick the merge lands on.
    tail.push({ type: 'lottery-beat', beat: snapshot.pendingBeat });
  }
  return tail;
}
