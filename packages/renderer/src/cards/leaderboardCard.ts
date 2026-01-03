import { RenderOptions, renderCard } from "../render.js";

export interface LeaderboardEntry {
  label: string;
  value: number | string;
}

export interface LeaderboardCardOptions extends RenderOptions {
  entries: LeaderboardEntry[];
}

export async function renderLeaderboardCard(
  options: LeaderboardCardOptions
): Promise<Buffer> {
  return renderCard(options);
}
