import { AttachmentBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { BotContext } from '../../config.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import { getLeagueInfo } from '../../lib/leagueInfo.js';
import {
  renderBumpChartGraph,
  renderDraftProphecyGraph,
  renderFaabPaceGraph,
  renderLuckGraph,
  renderPowerRankingGraph,
} from '@fantasy-canon/renderer';
import {
  computeExpectedWins,
  computePowerRanking,
  computeWeeklyStandings,
  type PowerRankingInput,
  type WeeklyResult,
} from '@fantasy-canon/core';
import {
  ensureTransactionsPayload,
  getTransactionTeamId,
  isWaiverSpend,
} from '../../lib/transactions.js';
import { extractWeeklyMatchups, extractWeeklyScores } from '../../lib/weeklyScores.js';

export async function handleGraphSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const metric = interaction.options.getString('metric', true);
  const season = interaction.options.getInteger('season', true);
  const leagueOverride = interaction.options.getString('leagueid') ?? undefined;
  const guildId = interaction.guildId;
  const guildConfig = guildId ? await context.leagueConfigRepo.getByGuildId(guildId) : undefined;
  const leagueId = leagueOverride ?? guildConfig?.leagueId ?? context.env.defaultLeagueId;

  if (!leagueId) {
    await interaction.reply({
      content: 'League ID is required. Set it via /canon config set or ESPN_LEAGUE_ID.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);

    if (metric === 'luck') {
      const mScoreboard = await ensureSnapshot(context, leagueId, season, 'mScoreboard');
      const scores = extractWeeklyScores(mScoreboard);
      if (scores.length === 0) {
        await interaction.editReply({
          content: 'No weekly scores found for this season (mScoreboard returned no matchups).',
        });
        return;
      }
      // Monte Carlo expected wins (schedule-independent) vs actual record wins.
      const expected = new Map(computeExpectedWins(scores).map((r) => [r.teamId, r.expectedWins]));
      const points = teams.map((t) => ({
        team: nameMap.get(t.id) ?? `Team ${t.id}`,
        wins: t.wins,
        expectedWins: expected.get(t.id) ?? 0,
      }));
      const buffer = await renderLuckGraph({
        title: `${leagueInfo.name ?? leagueId} • Luck graph`,
        subtitle: `Season ${season}`,
        points,
      });
      await sendBuffer(
        interaction,
        buffer,
        `${leagueId}-luck-${season}.png`,
        leagueInfo.name,
        season,
        'Luck graph',
      );
    } else if (metric === 'draft-prophecy') {
      const points = teams
        .filter((t) => t.projectedRank !== undefined || t.finishRank !== undefined)
        .map((t) => ({
          team: nameMap.get(t.id) ?? `Team ${t.id}`,
          projectedRank: t.projectedRank,
          finalRank: t.finishRank,
        }));
      if (points.length === 0) {
        await interaction.editReply({
          content: 'No draft projection data found.',
        });
        return;
      }
      const buffer = await renderDraftProphecyGraph({
        title: `${leagueInfo.name ?? leagueId} • Draft Prophecy`,
        subtitle: `Season ${season}`,
        points,
      });
      await sendBuffer(
        interaction,
        buffer,
        `${leagueId}-draft-${season}.png`,
        leagueInfo.name,
        season,
        'Draft Prophecy',
      );
    } else if (metric === 'faab-pace') {
      const mSettingsPayload = await ensureSnapshot(context, leagueId, season, 'mSettings');
      const mTxPayload = await ensureTransactionsPayload(context, leagueId, season);
      if (!mTxPayload) {
        await interaction.editReply({
          content: 'Transactions payload not available for this league/season.',
        });
        return;
      }
      const budget = extractBudget(mSettingsPayload) ?? 100;
      const lines = buildFaabLines(mTxPayload, nameMap);
      if (lines.length === 0) {
        await interaction.editReply({
          content: 'No FAAB spend data found.',
        });
        return;
      }
      const buffer = await renderFaabPaceGraph({
        title: `${leagueInfo.name ?? leagueId} • FAAB pace`,
        subtitle: `Season ${season}`,
        budget,
        lines,
      });
      await sendBuffer(
        interaction,
        buffer,
        `${leagueId}-faabpace-${season}.png`,
        leagueInfo.name,
        season,
        'FAAB pace',
      );
    } else if (metric === 'power-ranking') {
      const mScoreboard = await ensureSnapshot(context, leagueId, season, 'mScoreboard');
      const scores = extractWeeklyScores(mScoreboard);
      if (scores.length === 0) {
        await interaction.editReply({
          content: 'No weekly scores found for this season (mScoreboard returned no matchups).',
        });
        return;
      }
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
        title: `${leagueInfo.name ?? leagueId} • Power Rankings`,
        subtitle: `Season ${season}`,
        rows,
      });
      await sendBuffer(
        interaction,
        buffer,
        `${leagueId}-power-${season}.png`,
        leagueInfo.name,
        season,
        'Power Rankings',
      );
    } else if (metric === 'standings') {
      const mScoreboard = await ensureSnapshot(context, leagueId, season, 'mScoreboard');
      const matchups = extractWeeklyMatchups(mScoreboard);
      if (matchups.length === 0) {
        await interaction.editReply({
          content: 'No weekly matchups found for this season (mScoreboard returned no matchups).',
        });
        return;
      }
      const results: WeeklyResult[] = [];
      for (const m of matchups) {
        const homeOutcome =
          m.home.score > m.away.score ? 'W' : m.home.score < m.away.score ? 'L' : 'T';
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
        title: `${leagueInfo.name ?? leagueId} • Standings by Week`,
        subtitle: `Season ${season}`,
        weeks: standings.weeks,
        lines,
      });
      await sendBuffer(
        interaction,
        buffer,
        `${leagueId}-standings-${season}.png`,
        leagueInfo.name,
        season,
        'Standings by Week',
      );
    } else {
      await interaction.editReply({
        content: `Metric "${metric}" is not supported.`,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to render graph: ${message}`,
    });
  }
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

interface TeamSummary {
  id: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  projectedRank?: number;
  finishRank?: number;
}

function extractTeams(payload: unknown): TeamSummary[] {
  if (!payload || typeof payload !== 'object') return [];
  const maybeTeams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(maybeTeams)) return [];
  const teams: TeamSummary[] = [];
  for (const team of maybeTeams) {
    if (!team || typeof team !== 'object') continue;
    const t = team as {
      id?: unknown;
      record?: unknown;
      draftDayProjectedRank?: unknown;
      rankFinal?: unknown;
      rankCalculatedFinal?: unknown;
      playoffSeed?: unknown;
    };
    const id = Number(t.id);
    if (!Number.isFinite(id)) continue;
    const record =
      t.record && typeof t.record === 'object' ? (t.record as { overall?: unknown }) : undefined;
    const overall = record && typeof record === 'object' ? record.overall : undefined;
    const wins = Number((overall as { wins?: unknown })?.wins) || 0;
    const losses = Number((overall as { losses?: unknown })?.losses) || 0;
    const ties = Number((overall as { ties?: unknown })?.ties) || 0;
    const pointsFor = Number((overall as { pointsFor?: unknown })?.pointsFor) || 0;
    const projectedRank = Number(t.draftDayProjectedRank);
    const finishRank =
      Number(t.rankFinal) || Number(t.rankCalculatedFinal) || Number(t.playoffSeed) || undefined;

    teams.push({ id, wins, losses, ties, pointsFor, projectedRank, finishRank });
  }
  return teams;
}

async function sendBuffer(
  interaction: ChatInputCommandInteraction,
  buffer: Buffer,
  filename: string,
  leagueName: string | undefined,
  season: number,
  label: string,
): Promise<void> {
  const attachment = new AttachmentBuilder(buffer, { name: filename });
  await interaction.editReply({
    content: `League ${leagueName ?? ''} • Season ${season} • ${label}`,
    files: [attachment],
  });
}

function buildFaabLines(
  mTransactionsPayload: { transactions?: unknown[] },
  nameMap: Map<number, string>,
): Array<{ team: string; weekly: number[] }> {
  const spendByTeamWeek = new Map<number, Map<number, number>>();
  if (mTransactionsPayload && Array.isArray(mTransactionsPayload.transactions)) {
    for (const tx of mTransactionsPayload.transactions) {
      if (!tx || typeof tx !== 'object') continue;
      if (!isWaiverSpend(tx)) continue;
      const t = tx as { bidAmount?: unknown; scoringPeriodId?: unknown };
      const bid = typeof t.bidAmount === 'number' ? t.bidAmount : undefined;
      if (bid === undefined) continue;
      const week = typeof t.scoringPeriodId === 'number' ? t.scoringPeriodId : undefined;
      const teamId = getTransactionTeamId(tx);
      if (teamId === undefined || week === undefined) continue;
      const weekMap = spendByTeamWeek.get(teamId) ?? new Map<number, number>();
      weekMap.set(week, (weekMap.get(week) ?? 0) + bid);
      spendByTeamWeek.set(teamId, weekMap);
    }
  }

  let maxWeek = 0;
  spendByTeamWeek.forEach((weekMap) => {
    weekMap.forEach((_, w) => {
      if (w > maxWeek) maxWeek = w;
    });
  });

  const totals: Array<{ teamId: number; total: number }> = [];
  spendByTeamWeek.forEach((weekMap, teamId) => {
    let total = 0;
    for (const v of weekMap.values()) total += v;
    totals.push({ teamId, total });
  });

  const lines: Array<{ team: string; weekly: number[] }> = [];
  const topTotals = totals.sort((a, b) => b.total - a.total).slice(0, 8);
  for (const { teamId } of topTotals) {
    const weekMap = spendByTeamWeek.get(teamId);
    if (!weekMap) continue;
    const cumulative: number[] = [];
    let running = 0;
    for (let w = 1; w <= maxWeek; w += 1) {
      running += weekMap.get(w) ?? 0;
      cumulative.push(running);
    }
    lines.push({
      team: nameMap.get(teamId) ?? `Team ${teamId}`,
      weekly: cumulative,
    });
  }
  return lines;
}

function extractBudget(settingsPayload: unknown): number | undefined {
  if (!settingsPayload || typeof settingsPayload !== 'object') return undefined;
  const settings = (settingsPayload as { settings?: unknown }).settings;
  const acquisition =
    settings && typeof settings === 'object'
      ? (settings as { acquisitionSettings?: unknown }).acquisitionSettings
      : undefined;
  const budget =
    acquisition && typeof acquisition === 'object'
      ? (acquisition as { acquisitionBudget?: unknown }).acquisitionBudget
      : undefined;
  return typeof budget === 'number' && Number.isFinite(budget) ? budget : undefined;
}
