import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { computeAllPlayRecord, type WeeklyScore } from '@fantasy-canon/core';
import { BotContext } from '../../config.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';

export async function handleAllPlaySubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const limit = interaction.options.getInteger('limit') ?? undefined;
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
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
    const nameMap = buildTeamNameMap(mTeamPayload);

    const mScoreboard = await ensureSnapshot(context, leagueId, season, 'mScoreboard');
    const scores = extractWeeklyScores(mScoreboard);

    if (scores.length === 0) {
      await interaction.editReply({
        content: 'No weekly scores found for this season (mScoreboard returned no matchups).',
      });
      return;
    }

    const records = computeAllPlayRecord(scores);
    const shown = typeof limit === 'number' ? records.slice(0, limit) : records;

    const rows = shown.map((rec, idx) => {
      const name = nameMap.get(rec.teamId) ?? `Team ${rec.teamId}`;
      const pct = (rec.winPct * 100).toFixed(1);
      const tie = rec.ties > 0 ? `-${rec.ties}` : '';
      return `${idx + 1}. ${name} — ${rec.wins}-${rec.losses}${tie} (${pct}% vs all)`;
    });

    await interaction.editReply({
      content: [
        `League ${leagueId} • Season ${season} • All-Play (Wins vs. All %)`,
        'Each week every team is scored against every other team. Schedule-independent.',
        ...rows,
      ].join('\n'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to compute all-play record: ${message}`,
    });
  }
}

function ensureNumber(val: unknown): number | undefined {
  const num = Number(val);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Flatten an mScoreboard payload into per-team weekly scores. Handles both the
 * `home`/`away` matchup shape and the `teams[]` shape, mirroring rivalries.ts.
 * The week is taken from matchupPeriodId (falling back to scoringPeriodId); a
 * missing/invalid score is treated as 0 so the team still counts that week.
 */
export function extractWeeklyScores(payload: unknown): WeeklyScore[] {
  const out: WeeklyScore[] = [];
  if (!payload || typeof payload !== 'object') return out;
  const maybeSchedule = (payload as { schedule?: unknown }).schedule;
  const maybeMatchups = (payload as { matchups?: unknown }).matchups;
  const source = Array.isArray(maybeSchedule)
    ? maybeSchedule
    : Array.isArray(maybeMatchups)
      ? maybeMatchups
      : [];

  for (const m of source) {
    if (!m || typeof m !== 'object') continue;
    const week =
      ensureNumber((m as { matchupPeriodId?: unknown }).matchupPeriodId) ??
      ensureNumber((m as { scoringPeriodId?: unknown }).scoringPeriodId);
    if (week === undefined) continue;

    const home = (m as { home?: unknown }).home;
    const away = (m as { away?: unknown }).away;
    if (home && typeof home === 'object' && away && typeof away === 'object') {
      pushSide(out, week, home);
      pushSide(out, week, away);
      continue;
    }
    const teams = (m as { teams?: unknown }).teams;
    if (Array.isArray(teams)) {
      for (const t of teams as unknown[]) {
        if (t && typeof t === 'object') pushSide(out, week, t);
      }
    }
  }
  return out;
}

function pushSide(out: WeeklyScore[], week: number, side: object): void {
  const teamId = ensureNumber((side as { teamId?: unknown }).teamId);
  if (teamId === undefined) return;
  const score = ensureNumber((side as { totalPoints?: unknown }).totalPoints) ?? 0;
  out.push({ week, teamId, score });
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
