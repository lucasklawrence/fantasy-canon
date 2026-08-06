/**
 * The pick-#1 envelope moment (#243) — the pure, DOM-free half of the finale overlay, following
 * the `rollPlan.ts` split: decisions and timings live here where Vitest can reach them, the
 * overlay's DOM/CSS lives in `lottery.ts`/`lotteryPage.ts` and is verified live.
 *
 * The rule mirrors ADR 0008's derivation discipline: nothing new rides the wire — the client
 * plays the envelope on the reveal event whose `pick === 1`, whenever it occurs, which is
 * direction-agnostic by construction (worst-to-first ends on it, first-to-last opens with it).
 */

/** How long the overlay owns the screen before dismissing itself. */
export const ENVELOPE_MS = 3600;

/**
 * Extra beat before the overlay opens, per visual: the machine waits for the exit choreography's
 * FLIP separately (a promise, not a timer), then this small settle; the race needs the winning
 * cross/fall park (~900ms lock) to land on screen before the dim swallows it.
 */
export const ENVELOPE_LEAD_MS = { machine: 250, race: 1100 } as const;

export type PlaybackKind = 'catchup' | 'replay' | null;

/**
 * Should this reveal get the envelope? Pick #1 only; a catch-up sprint skips it (compressed pace
 * — the viewer asked to reach the present, not to be held); a hidden tab skips it (CSS animations
 * are frozen there, and the underlying reveal state below the overlay is already correct — #207's
 * rule); reduced motion skips it (it is nothing BUT motion).
 */
export function envelopeEligible(
  pick: number,
  playback: PlaybackKind,
  hidden: boolean,
  reducedMotion: boolean,
): boolean {
  return pick === 1 && playback !== 'catchup' && !hidden && !reducedMotion;
}
