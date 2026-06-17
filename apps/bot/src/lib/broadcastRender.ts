import { buildTeamNameMap } from './teamNames.js';
import { getLeagueInfo } from './leagueInfo.js';
import { extractTeams } from './teamStats.js';
import { extractWeeklyMatchups, extractWeeklyScores } from './weeklyScores.js';
import {
  computePowerRanking,
  computeWeeklyStandings,
  type PowerRankingInput,
  type WeeklyResult,
} from '@fantasy-canon/core';
import { renderBumpChartGraph, renderPowerRankingGraph } from '@fantasy-canon/renderer';
import { BotContext } from '../config.js';

/** Content types the scheduled broadcaster can render today. */
export const BROADCAST_METRICS = ['power-ranking', 'standings'] as const;
export type BroadcastMetric = (typeof BROADCAST_METRICS)[number];

export function isBroadcastMetric(value: string): value is BroadcastMetric {
  return (BROADCAST_METRICS as readonly string[]).includes(value);
}

export interface RenderedBroadcast {
  buffer: Buffer;
  filename: string;
  label: string;
}

/**
 * Render a weekly broadcast card to a PNG buffer, decoupled from any Discord interaction
 * so both the scheduled broadcaster (Airflow → CLI) and on-demand paths can use it. Pulls
 * snapshots through the context (cache-then-fetch). Returns null if there's no data.
 *
 * Mirrors the assembly in the /canon graph command for these metrics; see ADR 0002.
 */
export async function renderBroadcast(
  context: BotContext,
  leagueId: string,
  season: number,
  metric: BroadcastMetric,
): Promise<RenderedBroadcast | null> {
  const leagueInfo = await getLeagueInfo(context, leagueId, season);
  const title = leagueInfo.name ?? leagueId;
  const mScoreboard = await ensureSnapshot(context, leagueId, season, 'mScoreboard');

  if (metric === 'power-ranking') {
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);
    const scores = extractWeeklyScores(mScoreboard);
    if (scores.length === 0) return null;

    const scoresByTeam = new Map<number, number[]>();
    for (const s of scores) {
      const arr = scoresByTeam.get(s.teamId) ?? [];
      arr.push(s.score);
      scoresByTeam.set(s.teamId, arr);
    }
    const inputs: PowerRankingInput[] = teams.map((t) => ({
      teamId: t.id,
      weeklyScores: scoresByTeam.get(t.id) ?? [],
      wins: t.wins,
      losses: t.losses,
      ties: t.ties,
    }));
    const rows = computePowerRanking(inputs).map((e) => ({
      rank: e.rank,
      team: nameMap.get(e.teamId) ?? `Team ${e.teamId}`,
      score: e.score,
      gap: e.gap,
    }));
    const buffer = await renderPowerRankingGraph({
      title: `${title} • Power Rankings`,
      subtitle: `Season ${season}`,
      rows,
    });
    return { buffer, filename: `${leagueId}-power-${season}.png`, label: 'Power Rankings' };
  }

  // standings
  const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
  const nameMap = buildTeamNameMap(mTeamPayload);
  const matchups = extractWeeklyMatchups(mScoreboard);
  if (matchups.length === 0) return null;

  const results: WeeklyResult[] = [];
  for (const m of matchups) {
    const homeOutcome = m.home.score > m.away.score ? 'W' : m.home.score < m.away.score ? 'L' : 'T';
    const awayOutcome = homeOutcome === 'W' ? 'L' : homeOutcome === 'L' ? 'W' : 'T';
    results.push({
      week: m.week,
      teamId: m.home.teamId,
      outcome: homeOutcome,
      points: m.home.score,
    });
    results.push({
      week: m.week,
      teamId: m.away.teamId,
      outcome: awayOutcome,
      points: m.away.score,
    });
  }
  const standings = computeWeeklyStandings(results);
  const lines = standings.lines.map((l) => ({
    team: nameMap.get(l.teamId) ?? `Team ${l.teamId}`,
    ranks: l.ranks,
  }));
  const buffer = await renderBumpChartGraph({
    title: `${title} • Standings by Week`,
    subtitle: `Season ${season}`,
    weeks: standings.weeks,
    lines,
  });
  return { buffer, filename: `${leagueId}-standings-${season}.png`, label: 'Standings by Week' };
}

async function ensureSnapshot(
  context: BotContext,
  leagueId: string,
  season: number,
  view: string,
): Promise<unknown> {
  const existing = await context.snapshotsRepo.listBySeason(leagueId, season);
  const match = existing.find((s) => s.view === view);
  if (match) return match.payload;
  const res = await context.espnClient.fetchLeague({ leagueId, season, view });
  await context.snapshotsRepo.save({
    leagueId,
    season,
    view,
    fetchedAt: new Date(),
    payload: res.payload,
  });
  return res.payload;
}
