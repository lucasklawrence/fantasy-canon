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

import type { LotteryEvent, LotteryFinish, LotterySnapshot } from '../lotteryStage.js';

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

/** What the catch-up is currently replaying, for the echo check. */
export interface CatchUpContext {
  /** Reveal count the running catch-up already knows about (source + everything buffered). */
  known: number;
  /** The finish it has already buffered, if the ceremony ended mid-catch-up. */
  finish?: LotteryFinish;
}

function sameFinishOrder(a: LotteryFinish | undefined, b: LotteryFinish | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.verify.commitment === b.verify.commitment &&
    JSON.stringify(a.order) === JSON.stringify(b.order)
  );
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
      // Otherwise it describes the same run. It carries no new picks and no new finish ⇒ pure
      // echo from the polling fallback. If it *has* advanced past us, the incremental events are
      // still coming over the same transport, so let those carry it rather than repainting —
      // repainting mid-catch-up would blow the board away and defeat the whole feature.
      if (snapshot.reveals.length > context.known) return 'buffer';
      if (snapshot.finish && !sameFinishOrder(snapshot.finish, context.finish)) return 'buffer';
      return 'ignore';
    }
    default:
      return 'cancel';
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
  for (const reveal of snapshot.reveals.slice(context.known)) {
    tail.push({ type: 'lottery-reveal', reveal });
  }
  if (snapshot.finish && !sameFinishOrder(snapshot.finish, context.finish)) {
    tail.push({ type: 'lottery-finish', finish: snapshot.finish });
  }
  return tail;
}
