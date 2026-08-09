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
 * which is why they differ:
 *
 * - `machine` is a settle **after** the payoff has landed. `runExitChoreography` waits out the
 *   drop ball's FLIP before resolving (#269), and this is added on top. It used to be measured
 *   from the spring's *start*, which put the dim at roughly 90% opacity over the ball-#N face it
 *   exists to showcase.
 * - `race` and `wheel` are timers that have to **cover** their payoff: the winning cross/fall park
 *   (~900ms lock) and the landing ease plus its rest on the winner have no promise to wait on, so
 *   the lead spans the payoff rather than following it.
 *
 * The machine's value used to be boxed in at 100ms, because the exit chain's 1640ms floor plus the
 * lead had to finish inside the 1800ms {@link FINISH_LEAD_MS} gap or the overlay dimmed a board the
 * ball had already left. Live feedback was that 100ms reads as no pause at all — the card lands and
 * the screen is dimming in the same glance. The finish now WAITS for the finale instead of racing
 * it ({@link finaleHoldMs}), which takes the ceiling off and lets this be a real beat.
 *
 * The bound that remains is hygiene rather than correctness: a lead longer than a natural reveal
 * gap means the ceremony is sitting on its hands. `envelopePlan.test.ts` pins it over the whole key
 * set, because naming visuals one at a time is how the wheel shipped at 2400ms against 1800.
 */
export const ENVELOPE_LEAD_MS = { machine: 500, race: 1100, wheel: 1500 } as const;

/**
 * How long the pick-#1 finale may hold the finish off the screen, measured from the reveal that
 * triggers it (#243 live feedback).
 *
 * The board used to sweep in behind the overlay: the bot posts the finish as soon as its PNG
 * renders, which lands mid-ceremony, so the finale played over a stage that had already moved on.
 * The client defers the sweep instead — it is the only side that knows an envelope is coming, since
 * per ADR 0008 nothing about the visual rides the wire.
 *
 * A DEADLINE rather than an open-ended latch, deliberately. A finale can fail to open after it has
 * been promised — the tab goes hidden between the queue and the open, a superseded choreography
 * never resolves — and an un-cleared latch would strand the final board for the life of the page.
 * Late is recoverable; never is not.
 */
export function finaleHoldMs(leadMs: number, exitMs: number): number {
  return Math.max(0, exitMs) + Math.max(0, leadMs) + ENVELOPE_MS;
}

/**
 * Who the finale is about — the team holding pick #1, or null if the draw has not produced one.
 *
 * The overlay is re-openable from the sealed board, so this has to answer for a viewer who never
 * saw the ceremony at all: a late joiner landing straight on 'finished' has the order but no
 * reveal history. Reads whichever list the caller has, and refuses to guess from an incomplete one
 * — a board mid-draw simply has no pick #1 yet, and offering to re-open an envelope that was never
 * sealed would be a button that lies.
 */
export function finaleSubject(entries: readonly { pick: number; team: string }[]): string | null {
  return entries.find((entry) => entry.pick === 1)?.team ?? null;
}

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
