import { getLeagueInfo } from './leagueInfo.js';
import { ensureSnapshot } from './snapshots.js';
import { buildTeamNameMap } from './teamNames.js';
import { extractTeams } from './teamStats.js';
import { extractWeeklyScores } from './weeklyScores.js';
import { buildRivalry, extractMatchups } from './rivalry.js';
import { ensureTransactionsPayload, getTransactionTeamId, isWaiverSpend } from './transactions.js';
import { computeExpectedWins, computeLuckIndex } from '@fantasy-canon/core';
import { renderThrowbackCard } from '@fantasy-canon/renderer';
import { BotContext } from '../config.js';

/**
 * The bot side of the weekly throwback (issue #17). The Airflow DAG (`weekly_throwback`) picks
 * *what* to post — a post type on a weekly rotation plus a compact `--ref` identifying the row —
 * and shells out to this via the `throwback` CLI; here we recompute the storyline item from ESPN
 * snapshots (mirroring `orchestration/dags/storylines.py`) and render a card. Selection stays in
 * the sidecar, rendering stays in the bot (ADR 0002).
 */

/** Post types the scheduled rotation can render (mirrors `THROWBACK_POST_TYPES` in throwback.py). */
export const THROWBACK_POST_TYPES = ['rivalry', 'waiver_legend', 'luck', 'churn'] as const;
export type ThrowbackPostType = (typeof THROWBACK_POST_TYPES)[number];

export function isThrowbackPostType(value: string): value is ThrowbackPostType {
  return (THROWBACK_POST_TYPES as readonly string[]).includes(value);
}

/** A rendered throwback card ready to post to Discord (same shape as a rendered broadcast). */
export interface RenderedThrowback {
  buffer: Buffer;
  filename: string;
  label: string;
}

/** The `--ref` parsed into the ids each post type needs. The DAG's ref formats fix these shapes. */
export type ParsedThrowbackRef =
  | { postType: 'rivalry'; teamA: number; teamB: number }
  | { postType: 'waiver_legend'; week: number; teamId: number }
  | { postType: 'luck'; teamId: number }
  | { postType: 'churn'; teamId: number };

/**
 * Parse a throwback `--ref` for a post type. Formats (set by `throwback.py`'s selectors):
 * rivalry `"teamA:teamB"`, waiver_legend `"week:teamId"`, luck `"teamId"`, churn `"teamId"`.
 * Throws on a malformed ref so a misconfigured invocation fails loudly rather than posting junk.
 */
export function parseThrowbackRef(postType: ThrowbackPostType, ref: string): ParsedThrowbackRef {
  const parts = ref.split(':').map((p) => p.trim());
  const ints = parts.map((p) => {
    if (p === '') return NaN;
    const n = Number(p);
    return Number.isInteger(n) ? n : NaN;
  });
  const ensureIds = (count: number): void => {
    if (parts.length !== count || ints.some((n) => Number.isNaN(n))) {
      throw new Error(
        `Invalid --ref "${ref}" for post type "${postType}" (expected ${count} id(s)).`,
      );
    }
  };
  switch (postType) {
    case 'rivalry':
      ensureIds(2);
      return { postType, teamA: ints[0], teamB: ints[1] };
    case 'waiver_legend':
      ensureIds(2);
      return { postType, week: ints[0], teamId: ints[1] };
    case 'luck':
      ensureIds(1);
      return { postType, teamId: ints[0] };
    case 'churn':
      ensureIds(1);
      return { postType, teamId: ints[0] };
  }
}

/**
 * Recompute the storyline item named by (`postType`, `ref`) from snapshots and render it to a PNG
 * card. Pulls snapshots through the context (cache-then-fetch), like `renderBroadcast`. Returns
 * null when the referenced row has no data to show (e.g. no head-to-head, no waiver spend, an
 * unknown team) so the caller can skip cleanly.
 */
export async function renderThrowback(
  context: BotContext,
  leagueId: string,
  season: number,
  postType: ThrowbackPostType,
  ref: string,
): Promise<RenderedThrowback | null> {
  const parsed = parseThrowbackRef(postType, ref);
  const leagueInfo = await getLeagueInfo(context, leagueId, season);
  const leagueLabel = leagueInfo.name ?? leagueId;
  const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
  const nameMap = buildTeamNameMap(mTeamPayload);
  const teamName = (id: number): string => nameMap.get(id) ?? `Team ${id}`;
  const base = { title: `${leagueLabel} • Throwback`, subtitle: `Season ${season}` };

  switch (parsed.postType) {
    case 'rivalry': {
      const mScoreboard = await ensureSnapshot(context, leagueId, season, 'mScoreboard');
      const record = buildRivalry(extractMatchups(mScoreboard), parsed.teamA, parsed.teamB);
      if (!record) return null;
      const aName = teamName(record.teamA);
      const bName = teamName(record.teamB);
      const diff = record.aWins - record.bWins;
      const edge = diff > 0 ? `${aName} +${diff}` : diff < 0 ? `${bName} +${-diff}` : 'Series tied';
      const buffer = await renderThrowbackCard({
        ...base,
        badge: '⚔️ Biggest Rivalry',
        headline: `${aName} vs ${bName}`,
        stats: [
          { label: 'Head-to-head', value: `${record.aWins}–${record.bWins}` },
          { label: `${aName} points`, value: record.aPoints.toFixed(1) },
          { label: `${bName} points`, value: record.bPoints.toFixed(1) },
          { label: 'Series', value: edge },
        ],
      });
      return {
        buffer,
        filename: `${leagueId}-throwback-rivalry-${season}.png`,
        label: 'Rivalry Throwback',
      };
    }
    case 'waiver_legend': {
      const txPayload = await ensureTransactionsPayload(context, leagueId, season);
      const spend = sumWeekTeamSpend(txPayload, parsed.week, parsed.teamId);
      if (spend <= 0) return null;
      const buffer = await renderThrowbackCard({
        ...base,
        badge: '💰 Waiver Legend',
        headline: teamName(parsed.teamId),
        stats: [
          { label: `Week ${parsed.week} FAAB`, value: `$${formatMoney(spend)}` },
          { label: 'Week', value: String(parsed.week) },
        ],
      });
      return {
        buffer,
        filename: `${leagueId}-throwback-waiver-${season}.png`,
        label: 'Waiver Legend',
      };
    }
    case 'luck': {
      const mScoreboard = await ensureSnapshot(context, leagueId, season, 'mScoreboard');
      const record = computeExpectedWins(extractWeeklyScores(mScoreboard)).find(
        (r) => r.teamId === parsed.teamId,
      );
      const team = extractTeams(mTeamPayload).find((t) => t.id === parsed.teamId);
      if (!record || !team) return null;
      const luck = computeLuckIndex({ wins: team.wins, expectedWins: record.expectedWins });
      const buffer = await renderThrowbackCard({
        ...base,
        badge: luck >= 0 ? '🍀 Luckiest Team' : '🌧️ Unluckiest Team',
        headline: teamName(parsed.teamId),
        stats: [
          { label: 'Actual wins', value: String(team.wins) },
          { label: 'Expected wins', value: record.expectedWins.toFixed(2) },
          { label: 'Wins vs expected', value: `${luck >= 0 ? '+' : ''}${luck.toFixed(2)}` },
        ],
      });
      return {
        buffer,
        filename: `${leagueId}-throwback-luck-${season}.png`,
        label: 'Luck Throwback',
      };
    }
    case 'churn': {
      const team = extractTeams(mTeamPayload).find((t) => t.id === parsed.teamId);
      if (!team) return null;
      const buffer = await renderThrowbackCard({
        ...base,
        badge: '🔄 Most Active Roster',
        headline: teamName(parsed.teamId),
        stats: [
          { label: 'Roster moves', value: String(team.totalMoves) },
          { label: 'Acquisitions', value: String(team.acquisitions) },
          { label: 'Moves to IR', value: String(team.movesToIr) },
        ],
      });
      return {
        buffer,
        filename: `${leagueId}-throwback-churn-${season}.png`,
        label: 'Roster Churn',
      };
    }
  }
}

/** Total executed FAAB spend for one (week, team), mirroring faabPace's per-week accounting. */
function sumWeekTeamSpend(
  txPayload: { transactions?: unknown[] } | undefined,
  week: number,
  teamId: number,
): number {
  if (!txPayload || !Array.isArray(txPayload.transactions)) return 0;
  let total = 0;
  for (const tx of txPayload.transactions) {
    if (!isWaiverSpend(tx)) continue;
    const t = tx as { bidAmount?: unknown; scoringPeriodId?: unknown };
    const txWeek = typeof t.scoringPeriodId === 'number' ? t.scoringPeriodId : undefined;
    if (txWeek !== week) continue;
    if (getTransactionTeamId(tx) !== teamId) continue;
    const bid = typeof t.bidAmount === 'number' ? t.bidAmount : Number(t.bidAmount);
    if (Number.isFinite(bid)) total += bid;
  }
  return total;
}

/** Compact currency: drop trailing zeros (40 → "40", 40.5 → "40.5"), matching the DAG's `:g`. */
function formatMoney(value: number): string {
  return String(Math.round(value * 100) / 100);
}
