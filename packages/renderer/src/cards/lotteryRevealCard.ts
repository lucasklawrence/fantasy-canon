import { RenderOptions, renderImage } from '../render.js';

interface LotteryRevealBase extends RenderOptions {
  /** Card title, e.g. "Draft Lottery 2026". */
  title: string;
  /** Optional line under the title, e.g. "The Ceremony • live from the hopper". */
  subtitle?: string;
  /** Pick number this frame is about (1-based). */
  pick: number;
  /** Teams still waiting on a pick — rendered as the tension strip along the bottom. */
  remaining: string[];
}

/** Drum-roll frame — "Revealing pick N…" posted before the reveal to build suspense. */
export interface LotteryBeatCardOptions extends LotteryRevealBase {
  phase: 'beat';
}

/** Reveal frame — the pick lands: team, the balls they held, and the odds they had. */
export interface LotteryPickRevealCardOptions extends LotteryRevealBase {
  phase: 'reveal';
  team: string;
  /** Balls the team held in the hopper. */
  balls: number;
  /** The odds they had of landing this pick, percent 0–100. */
  oddsPct: number;
}

export type LotteryRevealCardOptions = LotteryBeatCardOptions | LotteryPickRevealCardOptions;

/**
 * Two-beat pick reveal for the lottery ceremony: post the `beat` frame ("Revealing pick
 * N…"), pause for effect, then post the `reveal` frame with the same props plus the
 * landed team — the orchestrator flips `phase` and fills in the result. Both frames
 * carry the remaining-teams strip so tension visibly rises as the board empties.
 * Landscape canvas (theme hd) so the reveal reads big inline in Discord.
 */
export function renderLotteryRevealCard(options: LotteryRevealCardOptions): Promise<Buffer> {
  if (options.phase === 'reveal') {
    const { title, subtitle, pick, remaining, phase, team, balls, oddsPct, ...renderOptions } =
      options;
    return renderImage(
      {
        kind: 'graph',
        title,
        subtitle,
        payload: { type: 'lottery-reveal', phase, pick, remaining, team, balls, oddsPct },
      },
      renderOptions,
    );
  }
  const { title, subtitle, pick, remaining, phase, ...renderOptions } = options;
  return renderImage(
    { kind: 'graph', title, subtitle, payload: { type: 'lottery-reveal', phase, pick, remaining } },
    renderOptions,
  );
}
