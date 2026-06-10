/**
 * Team-level stats extracted from an ESPN `mTeam` payload: record, points, streak, home/away
 * splits, transaction counters, and trade-block counts. Pure parsing of unofficial ESPN fields
 * (all optional). Shared by `/canon` storyline commands and the opponent scout.
 */

type TeamLike = {
  id?: unknown;
  name?: unknown;
  abbrev?: unknown;
  location?: unknown;
  nickname?: unknown;
  record?: unknown;
  transactionCounter?: unknown;
  tradeBlock?: unknown;
  draftDayProjectedRank?: unknown;
  rankFinal?: unknown;
  rankCalculatedFinal?: unknown;
  playoffSeed?: unknown;
};

export interface TeamInfo {
  id: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  streakType?: string;
  streakLength: number;
  acquisitions: number;
  moves: number;
  movesToIr: number;
  totalMoves: number;
  tradeBlockOn: number;
  tradeBlockUntouchable: number;
  projectedRank?: number;
  finishRank?: number;
  homeWins: number;
  homeLosses: number;
  awayWins: number;
  awayLosses: number;
  acquisitionBudgetSpent?: number;
}

export function extractTeams(payload: unknown): TeamInfo[] {
  if (!payload || typeof payload !== 'object') return [];
  const maybeTeams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(maybeTeams)) return [];
  const teams: TeamInfo[] = [];
  for (const team of maybeTeams) {
    if (!team || typeof team !== 'object') continue;
    const t = team as TeamLike;
    const id = Number(t.id);
    if (!Number.isFinite(id)) continue;
    const record =
      t.record && typeof t.record === 'object'
        ? (t.record as { overall?: unknown; home?: unknown; away?: unknown })
        : {};
    const overall =
      record && typeof record === 'object' ? (record as { overall?: unknown }).overall : undefined;
    const home =
      record && typeof record === 'object' ? (record as { home?: unknown }).home : undefined;
    const away =
      record && typeof record === 'object' ? (record as { away?: unknown }).away : undefined;
    const tc =
      t.transactionCounter && typeof t.transactionCounter === 'object'
        ? (t.transactionCounter as {
            acquisitionBudgetSpent?: unknown;
            acquisitions?: unknown;
            drops?: unknown;
            moveToActive?: unknown;
            moveToIR?: unknown;
            trades?: unknown;
          })
        : undefined;
    const tradeBlock =
      t.tradeBlock && typeof t.tradeBlock === 'object'
        ? (t.tradeBlock as { players?: unknown[] })
        : undefined;
    const players = Array.isArray(tradeBlock?.players) ? tradeBlock?.players : [];
    const onBlock = players.filter(
      (p) => p && typeof p === 'object' && (p as { status?: unknown }).status === 'ON_THE_BLOCK',
    ).length;
    const untouchable = players.filter(
      (p) => p && typeof p === 'object' && (p as { status?: unknown }).status === 'UNTOUCHABLE',
    ).length;

    teams.push({
      id,
      wins: Number((overall as { wins?: unknown })?.wins) || 0,
      losses: Number((overall as { losses?: unknown })?.losses) || 0,
      ties: Number((overall as { ties?: unknown })?.ties) || 0,
      pointsFor: Number((overall as { pointsFor?: unknown })?.pointsFor) || 0,
      pointsAgainst: Number((overall as { pointsAgainst?: unknown })?.pointsAgainst) || 0,
      streakType:
        typeof (overall as { streakType?: unknown })?.streakType === 'string'
          ? ((overall as { streakType?: unknown }).streakType as string)
          : undefined,
      streakLength: Number((overall as { streakLength?: unknown })?.streakLength) || 0,
      acquisitions: Number(tc?.acquisitions) || 0,
      moves: Number(tc?.moveToActive) || 0,
      movesToIr: Number(tc?.moveToIR) || 0,
      totalMoves:
        (Number(tc?.acquisitions) || 0) +
        (Number(tc?.drops) || 0) +
        (Number(tc?.moveToActive) || 0) +
        (Number(tc?.moveToIR) || 0) +
        (Number(tc?.trades) || 0),
      tradeBlockOn: onBlock,
      tradeBlockUntouchable: untouchable,
      projectedRank: Number.isFinite(Number(t.draftDayProjectedRank))
        ? Number(t.draftDayProjectedRank)
        : undefined,
      finishRank:
        Number(t.rankFinal) || Number(t.rankCalculatedFinal) || Number(t.playoffSeed) || undefined,
      homeWins: Number((home as { wins?: unknown })?.wins) || 0,
      homeLosses: Number((home as { losses?: unknown })?.losses) || 0,
      awayWins: Number((away as { wins?: unknown })?.wins) || 0,
      awayLosses: Number((away as { losses?: unknown })?.losses) || 0,
      acquisitionBudgetSpent:
        typeof tc?.acquisitionBudgetSpent === 'number' ? tc.acquisitionBudgetSpent : undefined,
    });
  }
  return teams;
}
