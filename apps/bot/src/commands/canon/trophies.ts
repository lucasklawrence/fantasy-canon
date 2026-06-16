import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { computeWeeklyTrophies } from '@fantasy-canon/core';
import { BotContext } from '../../config.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import { extractWeeklyMatchups } from '../../lib/weeklyScores.js';
import { parseStarterSlots } from '../../lib/lineupEfficiency.js';
import { extractTrophyExtras, type TrophyExtras } from '../../lib/trophyExtras.js';

/**
 * `/canon trophies` — the weekly banter awards for one week. Surfaces the six
 * score-based categories (👑 high, 💩 low, 😱 blowout, 😅 closest, 🍀 luckiest,
 * 😡 unluckiest) plus, when the boxscore is available, the four data-dependent ones
 * (📈/📉 over/underachiever vs projection, 🤖/🤡 best/worst manager by optimal-lineup %).
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

    // mMatchupScore (not mScoreboard) carries per-week home/away totals for completed
    // seasons; mScoreboard returns the schedule without resolvable per-week matchups here.
    const mMatchupScore = await ensureSnapshot(context, leagueId, season, 'mMatchupScore');
    const matchups = extractWeeklyMatchups(mMatchupScore).filter((m) => m.week === week);

    if (matchups.length === 0) {
      await interaction.editReply({
        content: `No matchups found for week ${week} of ${season}.`,
      });
      return;
    }

    const extras = await loadTrophyExtras(context, leagueId, season, week);
    const trophies = computeWeeklyTrophies(matchups, extras);
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

/**
 * Best-effort build of the projected / optimal-lineup-% extras that light up the four
 * data-dependent trophies. Needs `mSettings` (starter slots) and the week's `mBoxscore`;
 * if either is unavailable it returns `{}` so the six score-based trophies still post.
 */
async function loadTrophyExtras(
  context: BotContext,
  leagueId: string,
  season: number,
  week: number,
): Promise<TrophyExtras> {
  try {
    const mSettings = await ensureSnapshot(context, leagueId, season, 'mSettings');
    const starterSlots = parseStarterSlots(mSettings);
    if (starterSlots.length === 0) return {};
    const boxscore = await ensureWeekSnapshot(context, leagueId, season, week);
    return extractTrophyExtras(boxscore, starterSlots, week);
  } catch {
    return {};
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

/** Per-week `mBoxscore` snapshot — rosters + projections come back per `scoringPeriodId`. */
async function ensureWeekSnapshot(
  context: BotContext,
  leagueId: string,
  season: number,
  scoringPeriodId: number,
): Promise<unknown> {
  const view = `mBoxscore:wk${scoringPeriodId}`;
  const existing = await context.snapshotsRepo.listBySeason(leagueId, season);
  const match = existing.find((s) => s.view === view);
  if (match) return match.payload;
  const res = await context.espnClient.fetchLeague({
    leagueId,
    season,
    view: 'mBoxscore',
    scoringPeriodId,
  });
  await context.snapshotsRepo.save({
    leagueId,
    season,
    view,
    fetchedAt: new Date(),
    payload: res.payload,
  });
  return res.payload;
}
