import { renderImage, RenderOptions, RenderSpec } from '../render.js';

export interface PowerRankingRow {
  /** 1-based rank. */
  rank: number;
  /** Resolved team name (the renderer stays decoupled from core/ESPN types). */
  team: string;
  /** Composite power-ranking score. */
  score: number;
  /** Score gap to the team ranked immediately above (0 for #1). */
  gap: number;
}

export interface PowerRankingGraphOptions {
  title: string;
  subtitle?: string;
  rows: PowerRankingRow[];
}

/**
 * A ranked power-ranking card: one bar per team (length ∝ score), top to bottom,
 * with the gap to the team above annotated — the research point is to read the gap
 * between teams, not the absolute number (docs/14 §2-3).
 */
export function renderPowerRankingGraph(
  options: PowerRankingGraphOptions,
  renderOptions?: RenderOptions,
): Promise<Buffer> {
  const spec: RenderSpec = {
    kind: 'graph',
    title: options.title,
    subtitle: options.subtitle,
    payload: {
      type: 'power-ranking',
      rows: options.rows,
    },
  };
  return renderImage(spec, renderOptions);
}
