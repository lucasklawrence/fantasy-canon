/**
 * Head-to-head rivalry records parsed from an ESPN `mScoreboard` payload. Pure helpers shared by
 * the `/canon rivalry` command and the scheduled throwback renderer (issue #17): the command shows
 * one pairing or a leaderboard; the throwback recomputes a single pairing from its `--ref`. Mirrors
 * the pipeline's `compute_rivalries` (orchestration/dags/storylines.py).
 */

export interface Matchup {
  homeId: number;
  awayId: number;
  homeScore: number;
  awayScore: number;
}

export interface RivalryRecord {
  teamA: number;
  teamB: number;
  aWins: number;
  bWins: number;
  aPoints: number;
  bPoints: number;
}

function ensureNumber(val: unknown): number | undefined {
  const num = Number(val);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Flatten an mScoreboard payload into head-to-head matchups. Handles both the `home`/`away` shape
 * and a two-entry `teams[]` shape; a missing/invalid score counts as 0.
 */
export function extractMatchups(payload: unknown): Matchup[] {
  const matchups: Matchup[] = [];
  if (!payload || typeof payload !== 'object') return matchups;
  const maybeSchedule = (payload as { schedule?: unknown }).schedule;
  const maybeMatchups = (payload as { matchups?: unknown }).matchups;
  const source = Array.isArray(maybeSchedule)
    ? maybeSchedule
    : Array.isArray(maybeMatchups)
      ? maybeMatchups
      : [];

  for (const m of source) {
    if (!m || typeof m !== 'object') continue;
    const home = (m as { home?: unknown }).home;
    const away = (m as { away?: unknown }).away;
    if (home && typeof home === 'object' && away && typeof away === 'object') {
      const homeId = ensureNumber((home as { teamId?: unknown }).teamId);
      const awayId = ensureNumber((away as { teamId?: unknown }).teamId);
      const homeScore = ensureNumber((home as { totalPoints?: unknown }).totalPoints) ?? 0;
      const awayScore = ensureNumber((away as { totalPoints?: unknown }).totalPoints) ?? 0;
      if (homeId !== undefined && awayId !== undefined) {
        matchups.push({ homeId, awayId, homeScore, awayScore });
      }
      continue;
    }
    const teams = (m as { teams?: unknown }).teams;
    if (Array.isArray(teams) && teams.length >= 2) {
      const t1: unknown = teams[0];
      const t2: unknown = teams[1];
      if (t1 && typeof t1 === 'object' && t2 && typeof t2 === 'object') {
        const t1Id = ensureNumber((t1 as { teamId?: unknown }).teamId);
        const t2Id = ensureNumber((t2 as { teamId?: unknown }).teamId);
        const t1Score = ensureNumber((t1 as { totalPoints?: unknown }).totalPoints) ?? 0;
        const t2Score = ensureNumber((t2 as { totalPoints?: unknown }).totalPoints) ?? 0;
        if (t1Id !== undefined && t2Id !== undefined) {
          matchups.push({ homeId: t1Id, awayId: t2Id, homeScore: t1Score, awayScore: t2Score });
        }
      }
    }
  }
  return matchups;
}

/** Head-to-head record for one pairing (teamA/teamB in the given order), or undefined if none. */
export function buildRivalry(
  matchups: Matchup[],
  aId: number,
  bId: number,
): RivalryRecord | undefined {
  let aWins = 0;
  let bWins = 0;
  let aPoints = 0;
  let bPoints = 0;
  for (const m of matchups) {
    const isAB = (m.homeId === aId && m.awayId === bId) || (m.homeId === bId && m.awayId === aId);
    if (!isAB) continue;
    const aScore = m.homeId === aId ? m.homeScore : m.awayScore;
    const bScore = m.homeId === bId ? m.homeScore : m.awayScore;
    aPoints += aScore;
    bPoints += bScore;
    if (aScore > bScore) aWins += 1;
    else if (bScore > aScore) bWins += 1;
  }
  if (aWins === 0 && bWins === 0 && aPoints === 0 && bPoints === 0) return undefined;
  return { teamA: aId, teamB: bId, aWins, bWins, aPoints, bPoints };
}

/** Head-to-head records for every pairing, keyed by unordered pair (teamA = lower id). */
export function buildAllRivalries(matchups: Matchup[]): RivalryRecord[] {
  const map = new Map<string, RivalryRecord>();
  for (const m of matchups) {
    const key = m.homeId < m.awayId ? `${m.homeId}-${m.awayId}` : `${m.awayId}-${m.homeId}`;
    const rec = map.get(key) ?? {
      teamA: m.homeId < m.awayId ? m.homeId : m.awayId,
      teamB: m.homeId < m.awayId ? m.awayId : m.homeId,
      aWins: 0,
      bWins: 0,
      aPoints: 0,
      bPoints: 0,
    };
    const homeIsA = m.homeId === rec.teamA;
    const aScore = homeIsA ? m.homeScore : m.awayScore;
    const bScore = homeIsA ? m.awayScore : m.homeScore;
    rec.aPoints += aScore;
    rec.bPoints += bScore;
    if (aScore > bScore) rec.aWins += 1;
    else if (bScore > aScore) rec.bWins += 1;
    map.set(key, rec);
  }
  return Array.from(map.values());
}
