import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { BotContext } from '../../config.js';
import { resolveLeagueId } from '../../lib/leagueId.js';
import { ensureSnapshot } from '../../lib/snapshots.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import { buildAllRivalries, buildRivalry, extractMatchups } from '../../lib/rivalry.js';

export async function handleRivalrySubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const teamAInput = interaction.options.getString('teama', true);
  const teamBInput = interaction.options.getString('teamb', true);
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
    const resolver = buildTeamResolver(nameMap);
    const teamAId = resolver(teamAInput);
    const teamBId = resolver(teamBInput);
    if (teamAId === undefined || teamBId === undefined) {
      await interaction.editReply({
        content:
          'Unable to resolve one or both team names. Use exact team names from /canon admin teams.',
      });
      return;
    }

    const mScoreboard = await ensureSnapshot(context, leagueId, season, 'mScoreboard');
    const matchups = extractMatchups(mScoreboard);
    const record = buildRivalry(matchups, teamAId, teamBId);

    if (!record) {
      await interaction.editReply({
        content: 'No head-to-head matchups found for those teams in this season.',
      });
      return;
    }

    const aName = nameMap.get(teamAId) ?? `Team ${teamAId}`;
    const bName = nameMap.get(teamBId) ?? `Team ${teamBId}`;
    const summary = `${aName} vs ${bName}`;
    const recordLine = `${record.aWins}-${record.bWins} | Points ${record.aPoints.toFixed(2)} - ${record.bPoints.toFixed(2)}`;
    const diff = record.aWins - record.bWins;
    const descriptor =
      diff > 0
        ? `${aName} lead by ${diff}`
        : diff < 0
          ? `${bName} lead by ${Math.abs(diff)}`
          : 'Series tied';

    await interaction.editReply({
      content: [
        `League ${leagueId} • Season ${season} • Rivalry`,
        summary,
        recordLine,
        descriptor,
      ].join('\n'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to compute rivalry: ${message}`,
    });
  }
}

export async function handleRivalriesSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const limit = interaction.options.getInteger('limit') ?? 5;
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
    const matchups = extractMatchups(mScoreboard);
    const rivalries = buildAllRivalries(matchups);
    if (rivalries.length === 0) {
      await interaction.editReply({
        content: 'No head-to-head matchups found.',
      });
      return;
    }
    const sorted = rivalries
      .sort((a, b) => Math.abs(b.aWins - b.bWins) - Math.abs(a.aWins - a.bWins))
      .slice(0, limit);
    const lines = sorted.map((r) => {
      const aName = nameMap.get(r.teamA) ?? `Team ${r.teamA}`;
      const bName = nameMap.get(r.teamB) ?? `Team ${r.teamB}`;
      const diff = r.aWins - r.bWins;
      const leader = diff === 0 ? 'tied' : diff > 0 ? `${aName} +${diff}` : `${bName} +${-diff}`;
      return `${aName} vs ${bName} — ${r.aWins}-${r.bWins} (pts ${r.aPoints.toFixed(
        1,
      )}-${r.bPoints.toFixed(1)}), ${leader}`;
    });
    await interaction.editReply({
      content: [
        `League ${leagueId} • Season ${season} • Rivalries (top ${sorted.length})`,
        ...lines,
      ].join('\n'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to list rivalries: ${message}`,
    });
  }
}

function buildTeamResolver(nameMap: Map<number, string>): (input: string) => number | undefined {
  const entries = Array.from(nameMap.entries());
  return (input: string) => {
    const lc = input.trim().toLowerCase();
    if (!lc) return undefined;
    if (Number.isFinite(Number(lc))) {
      return Number(lc);
    }
    const exact = entries.find(([, name]) => name.toLowerCase() === lc);
    if (exact) return exact[0];
    const partial = entries.find(([, name]) => name.toLowerCase().includes(lc));
    return partial?.[0];
  };
}
