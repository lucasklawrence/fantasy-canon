import { renderImage, RenderSpec } from '../render.js';

export interface FaabPaceLine {
  team: string;
  weekly: number[]; // cumulative spend per week
}

export interface FaabPaceGraphOptions {
  title: string;
  subtitle?: string;
  budget: number;
  lines: FaabPaceLine[];
}

export function renderFaabPaceGraph(options: FaabPaceGraphOptions): Promise<Buffer> {
  const spec: RenderSpec = {
    kind: 'graph',
    title: options.title,
    subtitle: options.subtitle,
    payload: {
      type: 'faab-pace',
      budget: options.budget,
      lines: options.lines,
      axes: { x: 'Week', y: 'Cumulative FAAB' },
    },
  };
  return renderImage(spec);
}
