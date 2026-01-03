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
  const spec: RenderSpec = {
    kind: "graph",
    title: options.title,
    subtitle: options.subtitle,
    payload: {
      type: "luck-scatter",
      points: options.points.map((p) => ({
        team: p.team,
        wins: p.wins,
        expectedWins: p.expectedWins,
        luck: p.wins - p.expectedWins
      }))
    }
  };
  return renderImage(spec);
}
