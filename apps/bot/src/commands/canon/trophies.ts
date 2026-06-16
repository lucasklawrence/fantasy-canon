import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { computeWeeklyTrophies } from '@fantasy-canon/core';
import { BotContext } from '../../config.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import { extractWeeklyMatchups } from '../../lib/weeklyScores.js';

/**
 * `/canon trophies` — the weekly banter awards for one week. Surfaces the six
 * score-based categories (👑 high, 💩 low, 😱 blowout, 😅 closest, 🍀 luckiest,
 * 😡 unluckiest); the projected- and optimal-lineup-based trophies light up once
 * those extractors exist (the core engine already supports them).
 */
export async function handleTrophiesSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const week = interaction.options.getInteger('week', true);
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
    const matchups = extractWeeklyMatchups(mScoreboard).filter((m) => m.week === week);

    if (matchups.length === 0) {
      await interaction.editReply({
        content: `No matchups found for week ${week} of ${season}.`,
      });
      return;
    }

    const trophies = computeWeeklyTrophies(matchups);
    const lines = trophies.map(
      (t) => `${t.emoji} ${t.label}: ${nameMap.get(t.teamId) ?? `Team ${t.teamId}`} — ${t.detail}`,
    );

    await interaction.editReply({
      content: [`League ${leagueId} • Season ${season} • Week ${week} Trophies`, ...lines].join(
        '\n',
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to compute trophies: ${message}`,
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
