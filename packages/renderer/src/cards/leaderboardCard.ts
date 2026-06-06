import { RenderOptions, renderImage } from '../render.js';

export interface LeaderboardEntry {
  label: string;
  value: number | string;
}

export interface LeaderboardCardOptions extends RenderOptions {
  title: string;
  subtitle?: string;
  entries: LeaderboardEntry[];
}

export async function renderLeaderboardCard(options: LeaderboardCardOptions): Promise<Buffer> {
  const { title, subtitle, entries, ...renderOptions } = options;
  return renderImage({ kind: 'card', title, subtitle, payload: { entries } }, renderOptions);
}
