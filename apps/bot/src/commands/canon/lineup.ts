import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import {
  computeLineupEfficiency,
  aggregateLineupEfficiency,
  type LineupEfficiency,
} from '@fantasy-canon/core';
import { BotContext } from '../../config.js';
import { resolveLeagueId } from '../../lib/leagueId.js';
import { ensureSnapshot } from '../../lib/snapshots.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import {
  parseStarterSlots,
  parseWeekLineups,
  regularSeasonWeeks,
} from '../../lib/lineupEfficiency.js';

/**
 * /canon lineup — season optimal-lineup % leaderboard ("points left on the bench").
 *
 * For each regular-season scoring period we fetch the boxscore (`mMatchup`), compare each
 * team's started lineup against the best legal lineup from the same roster, then aggregate
 * across the season (points-based, so a 0-point/未-played week doesn't count as 100%). This
 * is the input to the Best/Worst Manager trophies. Ephemeral — it's a private analytics peek.
 *
 * Note: per-week lineups only come back per `scoringPeriodId`, so this fans out one fetch per
 * week. Snapshots are cached in-process, so a re-run in the same bot session is cheap.
 */
export async function handleLineupSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const weeksOverride = interaction.options.getInteger('weeks') ?? undefined;
  const limit = interaction.options.getInteger('limit') ?? undefined;
  const leagueId = await resolveLeagueId(interaction, context);

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

    const mSettingsPayload = await ensureSnapshot(context, leagueId, season, 'mSettings');
    const starterSlots = parseStarterSlots(mSettingsPayload);
    if (starterSlots.length === 0) {
      await interaction.editReply({
        content: 'Could not read this league’s lineup slots (mSettings had no lineupSlotCounts).',
      });
      return;
    }

    const weeks = weeksOverride ?? regularSeasonWeeks(mSettingsPayload);

    // teamId -> per-week efficiencies (only weeks the team actually scored in).
    const byTeam = new Map<number, LineupEfficiency[]>();
    for (let spId = 1; spId <= weeks; spId += 1) {
      const payload = await ensureWeekSnapshot(context, leagueId, season, spId);
      for (const { teamId, players } of parseWeekLineups(payload)) {
        const eff = computeLineupEfficiency(players, starterSlots);
        // Skip weeks with no points (byes, not-yet-played) — they'd read as 100%.
        if (eff.optimalPoints <= 0) continue;
        const list = byTeam.get(teamId) ?? [];
        list.push(eff);
        byTeam.set(teamId, list);
      }
    }

    if (byTeam.size === 0) {
      await interaction.editReply({
        content: `No boxscore data found for season ${season} (weeks 1–${weeks}).`,
      });
      return;
    }

    const ranked = [...byTeam.entries()]
      .map(([teamId, weekly]) => ({ teamId, season: aggregateLineupEfficiency(weekly) }))
      .sort((a, b) => b.season.efficiency - a.season.efficiency);

    const shown = typeof limit === 'number' ? ranked.slice(0, limit) : ranked;
    const rows = shown.map((r, idx) => {
      const name = nameMap.get(r.teamId) ?? `Team ${r.teamId}`;
      const pct = (r.season.efficiency * 100).toFixed(1);
      const left = r.season.pointsLeftOnBench.toFixed(1);
      return `${idx + 1}. ${name} — ${pct}% optimal (${left} pts left on bench)`;
    });

    await interaction.editReply({
      content: [
        `League ${leagueId} • Season ${season} • Optimal-Lineup % (weeks 1–${weeks})`,
        'Best legal lineup each week vs what was actually started. Higher = fewer points benched. 🤖 Best / 🤡 Worst Manager.',
        ...rows,
      ].join('\n'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to compute lineup efficiency: ${message}`,
    });
  }
}

/**
 * Like {@link ensureSnapshot} but for the per-week boxscore. ESPN returns rosters only for
 * the requested `scoringPeriodId`, so each week is cached under its own composite view key.
 */
async function ensureWeekSnapshot(
  context: BotContext,
  leagueId: string,
  season: number,
  scoringPeriodId: number,
): Promise<unknown> {
  const view = `mMatchup:wk${scoringPeriodId}`;
  const existing = await context.snapshotsRepo.listBySeason(leagueId, season);
  const match = existing.find((s) => s.view === view);
  if (match) return match.payload;
  const res = await context.espnClient.fetchLeague({
    leagueId,
    season,
    view: 'mMatchup',
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
