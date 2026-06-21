import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { computeAllPlayRecord } from '@fantasy-canon/core';
import { BotContext } from '../../config.js';
import { resolveLeagueId } from '../../lib/leagueId.js';
import { ensureSnapshot } from '../../lib/snapshots.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import { extractWeeklyScores } from '../../lib/weeklyScores.js';

export async function handleAllPlaySubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
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
