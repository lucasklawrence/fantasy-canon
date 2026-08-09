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
 * Extra beat before the overlay opens, per visual. The keys are measured from different places,
 * which is why they differ by an order of magnitude:
 *
 * - `machine` is a settle **after** the payoff has landed. `runExitChoreography` waits out the
 *   drop ball's FLIP before resolving (#269), and this is added on top. It used to be measured
 *   from the spring's *start*, which put the dim at roughly 90% opacity over the ball-#N face it
 *   exists to showcase.
 * - `race` and `wheel` are timers that have to **cover** their payoff: the winning cross/fall park
 *   (~900ms lock) and the landing ease plus its rest on the winner have no promise to wait on, so
 *   the lead spans the payoff rather than following it.
 *
 * None of them is free to grow. On the last reveal the whole gap is {@link FINISH_LEAD_MS}, past
 * which the finish has already sealed the board and the overlay dims a finale nobody is looking at
 * any more; `envelopePlan.test.ts` pins that over the whole key set, because naming visuals one at
 * a time is how the wheel shipped at 2400ms against an 1800ms gap.
 *
 * The machine is tighter still, because it is the composition of two independently-tuned things:
 * the exit budget is sized to consume nearly the whole gap, so `exitBudget(FINISH_LEAD_MS).totalMs
 * + machine` must ALSO stay inside it. That is the same mis-timed handoff, just inverted, and it
 * has its own assertion.
 */
export const ENVELOPE_LEAD_MS = { machine: 100, race: 1100, wheel: 1500 } as const;

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
