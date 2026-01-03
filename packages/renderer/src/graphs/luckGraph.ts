import { renderImage, RenderSpec } from "../render.js";

export interface LuckGraphPoint {
  team: string;
  wins: number;
  expectedWins: number;
}

export interface LuckGraphOptions {
  title: string;
  subtitle?: string;
  points: LuckGraphPoint[];
}

export function renderLuckGraph(options: LuckGraphOptions): Promise<Buffer> {
  const enriched = options.points.map((p) => ({
    ...p,
    luck: p.wins - p.expectedWins
  }));
  const outliers = findOutliers(enriched, 3);
  const spec: RenderSpec = {
    kind: "graph",
    title: options.title,
    subtitle: options.subtitle,
    payload: {
      type: "luck-scatter",
      axes: { x: "Expected wins", y: "Actual wins" },
      expectedLine: { slope: 1, intercept: 0 },
      points: enriched,
      outliers
    }
  };
  return renderImage(spec);
}

function findOutliers(
  points: Array<LuckGraphPoint & { luck: number }>,
  limit: number
): Array<{ team: string; luck: number }> {
  return [...points]
    .sort((a, b) => Math.abs(b.luck) - Math.abs(a.luck))
    .slice(0, limit)
    .map((p) => ({ team: p.team, luck: p.luck }));
}
