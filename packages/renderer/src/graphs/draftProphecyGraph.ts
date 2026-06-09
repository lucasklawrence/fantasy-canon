import { renderImage, RenderSpec } from '../render.js';

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
  const enriched = options.points.map((p) => ({
    ...p,
    delta:
      p.projectedRank !== undefined && p.finalRank !== undefined
        ? p.projectedRank - p.finalRank
        : null,
  }));
  const miss = findBiggestMiss(enriched);
  const spec: RenderSpec = {
    kind: 'graph',
    title: options.title,
    subtitle: options.subtitle,
    payload: {
      type: 'draft-prophecy',
      axes: { x: 'Projected rank', y: 'Final rank' },
      lines: enriched,
      highlight: miss,
    },
  };
  return renderImage(spec);
}

function findBiggestMiss(
  points: Array<DraftProphecyPoint & { delta: number | null }>,
): { team: string; delta: number | null } | undefined {
  return [...points]
    .filter((p) => p.delta !== null)
    .sort((a, b) => Math.abs((b.delta as number) ?? 0) - Math.abs((a.delta as number) ?? 0))
    .map((p) => ({ team: p.team, delta: p.delta }))
    .at(0);
}
