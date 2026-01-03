import { renderImage, RenderSpec } from "../render.js";

export interface DraftProphecyPoint {
  team: string;
  projectedRank?: number;
  finalRank?: number;
}

export interface DraftProphecyGraphOptions {
  title: string;
  subtitle?: string;
  points: DraftProphecyPoint[];
}

export function renderDraftProphecyGraph(options: DraftProphecyGraphOptions): Promise<Buffer> {
  const spec: RenderSpec = {
    kind: "graph",
    title: options.title,
    subtitle: options.subtitle,
    payload: {
      type: "draft-prophecy",
      points: options.points.map((p) => ({
        team: p.team,
        projectedRank: p.projectedRank ?? null,
        finalRank: p.finalRank ?? null,
        delta:
          p.projectedRank !== undefined && p.finalRank !== undefined
            ? p.projectedRank - p.finalRank
            : null
      }))
    }
  };
  return renderImage(spec);
}
