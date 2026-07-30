/**
 * Replay timeline for the lottery machine (#197): turns a finished stage snapshot into the
 * sequence of synthetic beat/reveal/finish events that re-runs the reveal animation locally.
 *
 * Fairness-safe by construction — the snapshot already carries the full *published* reveal
 * history, so a replay is a re-render of public data on a client-side timer: no server state, no
 * re-draw, no protocol change. Pure (no DOM, no timers) so it unit-tests without a browser; the
 * client in `lottery.ts` owns the actual `setTimeout` scheduling and the live-events-win rule.
 */

import type { LotteryEvent, LotterySnapshot } from '../lotteryStage.js';

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
