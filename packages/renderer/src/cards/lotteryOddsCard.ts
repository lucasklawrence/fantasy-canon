import { RenderOptions, renderImage } from '../render.js';

export interface LotteryOddsRow {
  team: string;
  /** Balls this team holds in the hopper. */
  balls: number;
  /** Chance at the #1 overall pick, percent 0–100. */
  firstPct: number;
  /** Chance of landing a top-3 pick, percent 0–100. */
  top3Pct: number;
}

export interface LotteryOddsCardOptions extends RenderOptions {
  /** Card title, e.g. "Draft Lottery Odds". */
  title: string;
  /** Optional line under the title, e.g. "2026 season • 120 balls in the hopper". */
  subtitle?: string;
  /** One row per team, in the order they should be listed (caller sorts). */
  rows: LotteryOddsRow[];
}

/**
 * Pre-draw lottery odds table — each team with its ball count and headline odds (#1-pick
 * chance + top-3 chance). Deliberately headline odds rather than a full N×N pick matrix:
 * the card is viewed as a Discord inline image, and a 12×12 grid is illegible at that
 * scale. Square canvas so 12 rows breathe; callers can override via RenderOptions. Props
 * are plain local types — the ceremony orchestration maps engine output onto them, and
 * the renderer never touches randomness (commit-reveal fairness lives bot-side).
 */
export function renderLotteryOddsCard(options: LotteryOddsCardOptions): Promise<Buffer> {
  const { title, subtitle, rows, ...renderOptions } = options;
  return renderImage(
    { kind: 'graph', title, subtitle, payload: { type: 'lottery-odds', rows } },
    { size: { width: 1080, height: 1080 }, ...renderOptions },
  );
}
