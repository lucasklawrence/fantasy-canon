import { renderImage, RenderOptions, RenderSpec } from '../render.js';

export interface BumpChartLine {
  /** Resolved team name (renderer stays decoupled from core/ESPN types). */
  team: string;
  /** Standings rank after each week; ranks[i] aligns with weeks[i]. 1 = first place. */
  ranks: number[];
}

export interface BumpChartGraphOptions {
  title: string;
  subtitle?: string;
  weeks: number[];
  lines: BumpChartLine[];
}

/**
 * Season-long bump chart: standings rank over the weeks, drawn on an inverted y-axis
 * (rank 1 at the top) with direct line-end labels rather than a side legend — the
 * recommended design for rank-movement charts (docs/14 §3). Pairs with the #57 power
 * ranking; this one shows table position week to week.
 */
export function renderBumpChartGraph(
  options: BumpChartGraphOptions,
  renderOptions?: RenderOptions,
): Promise<Buffer> {
  const spec: RenderSpec = {
    kind: 'graph',
    title: options.title,
    subtitle: options.subtitle,
    payload: {
      type: 'bump-chart',
      weeks: options.weeks,
      lines: options.lines,
    },
  };
  return renderImage(spec, renderOptions);
}
