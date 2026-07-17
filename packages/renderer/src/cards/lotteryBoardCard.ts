import { RenderOptions, renderImage } from '../render.js';

export interface LotteryBoardEntry {
  /** Pick number (1-based). */
  pick: number;
  team: string;
  /** Balls the team held during the draw — optional annotation. */
  balls?: number;
  /** Pre-draw odds of landing this exact pick, percent 0–100 — optional annotation. */
  oddsPct?: number;
}

export interface LotteryBoardCardOptions extends RenderOptions {
  /** Card title, e.g. "2026 Draft Order". */
  title: string;
  /** Optional line under the title, e.g. "Sealed by the lottery • seed a1b2c3". */
  subtitle?: string;
  /** The full draft order, in pick order (caller sorts). */
  entries: LotteryBoardEntry[];
}

/**
 * Final draft-order board — the full 1–N order once every pick has been revealed, built
 * for pinning/sharing in the league channel. Each row can carry the balls/odds the team
 * had so upsets stay part of the story. Square canvas so 12 rows stay legible inline;
 * callers can override via RenderOptions.
 */
export function renderLotteryBoardCard(options: LotteryBoardCardOptions): Promise<Buffer> {
  const { title, subtitle, entries, ...renderOptions } = options;
  return renderImage(
    { kind: 'graph', title, subtitle, payload: { type: 'lottery-board', entries } },
    { size: { width: 1080, height: 1080 }, ...renderOptions },
  );
}
