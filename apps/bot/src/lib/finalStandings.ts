/**
 * Standings-derived default ball weights for the draft-order lottery (#165).
 *
 * Worst finish → most balls, by the simplest explainable rule: a team's base balls equal its
 * final rank from last season (champion 1, last place N), clamped to the roster size. Teams
 * with no last-season rank (new managers) get the mid-pack default `ceil(N / 2)` — neither
 * champion-punished nor tank-rewarded — and are surfaced to the commissioner for override.
 *
 * Pure parsing/derivation; the caller fetches the `mTeam` payload through `ensureSnapshot`.
 */
import { extractTeams } from './teamStats.js';

/** teamId (stringified ESPN id) → final rank, from an `mTeam` payload. Unranked teams are absent. */
export function extractFinalRanks(payload: unknown): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const team of extractTeams(payload)) {
    if (team.finishRank !== undefined) {
      ranks.set(String(team.id), team.finishRank);
    }
  }
  return ranks;
}

export interface StandingsWeights {
  /** teamId → derived base balls for this year's roster. */
  baseBallsByTeam: Map<string, number>;
  /** Roster teams that had no last-season rank and got the mid-pack default. */
  missingRank: string[];
}

/**
 * Map last season's final ranks onto this year's roster as base ball counts. Ranks outside
 * `[1, roster size]` (division quirks, mid-season roster changes) clamp into range so the bag
 * always stays explainable as "your finish = your ball count".
 */
export function deriveStandingsBaseBalls(
  rosterTeamIds: string[],
  finalRanks: Map<string, number>,
): StandingsWeights {
  const teamCount = rosterTeamIds.length;
  const midPack = Math.ceil(teamCount / 2);
  const baseBallsByTeam = new Map<string, number>();
  const missingRank: string[] = [];

  for (const teamId of rosterTeamIds) {
    const rank = finalRanks.get(teamId);
    if (rank === undefined) {
      baseBallsByTeam.set(teamId, midPack);
      missingRank.push(teamId);
    } else {
      baseBallsByTeam.set(teamId, Math.min(Math.max(Math.round(rank), 1), teamCount));
    }
  }
  return { baseBallsByTeam, missingRank };
}
