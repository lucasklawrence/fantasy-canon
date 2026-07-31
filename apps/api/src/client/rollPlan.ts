/**
 * Drum-roll timing (#216) — the pure, DOM-free half of the ceremony sound, split from
 * `ceremonyAudio.ts` the same way `ballAssignments` sits beside `hopperSim`: the repo's root
 * typecheck is deliberately DOM-less, so anything a test imports must not mention WebAudio types.
 */

export interface RollPlan {
  /** Fade-in so the roll doesn't click on. */
  attackMs: number;
  /** When the crescendo peaks — just before the reveal is due. */
  crescendoEndMs: number;
  /** Hard stop if no reveal ever lands (an abort mid-roll); keeps a roll from droning forever. */
  autoStopMs: number;
}

/**
 * Timing plan for a roll spanning `windowMs` — the bot's live pacing, or the compressed
 * replay/catch-up window. Clamped so degenerate windows still produce an ordered plan.
 */
export function rollPlan(windowMs: number): RollPlan {
  const span = Math.max(800, windowMs);
  return {
    attackMs: Math.min(300, span * 0.1),
    // Peak slightly early: the reveal usually lands right at the window's end, and the hit reads
    // better against an already-peaked roll than one still climbing.
    crescendoEndMs: Math.max(500, span - 200),
    autoStopMs: span + 1500,
  };
}
