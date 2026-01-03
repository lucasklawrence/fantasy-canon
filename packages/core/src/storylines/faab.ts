import { SeasonYear } from "@fantasy-canon/shared";

export interface FaabLeaderboardEntry {
  teamId: number;
  amount: number;
}

export interface FaabLeaderboardInput {
  season: SeasonYear;
  entries: FaabLeaderboardEntry[];
  limit?: number;
}

export function buildFaabLeaderboard({
  entries,
  limit = 12
}: FaabLeaderboardInput): FaabLeaderboardEntry[] {
  const sorted = [...entries].sort((a, b) => b.amount - a.amount);
  return sorted.slice(0, limit);
}
