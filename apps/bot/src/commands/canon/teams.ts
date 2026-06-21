import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { BotContext } from '../../config.js';
import { resolveLeagueId } from '../../lib/leagueId.js';
import { formatTeamName } from '../../lib/teamNames.js';

interface TeamSummary {
  teamId: number;
  name: string;
  abbrev?: string;
  pointsFor?: number;
}

export async function handleTeamsSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
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
    const payload = await ensureMTeamSnapshot(context, leagueId, season);
    const teams = extractTeams(payload);
    if (teams.length === 0) {
      await interaction.editReply({
        content: 'No teams found in mTeam payload.',
      });
      return;
    }

    const lines = teams.map(
      (t) =>
        `${t.teamId}. ${t.name}${t.abbrev ? ` (${t.abbrev})` : ''}${
          t.pointsFor !== undefined ? ` — PF: ${t.pointsFor.toFixed(2)}` : ''
        }`,
    );

    await interaction.editReply({
      content: [`League ${leagueId} • Season ${season}`, ...lines].join('\n'),
    });
  } catch (error) {
    console.error('Failed to list teams', error);
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to list teams: ${message}`,
    });
  }
}

async function ensureMTeamSnapshot(
  context: BotContext,
  leagueId: string,
  season: number,
): Promise<unknown> {
  const existing = await context.snapshotsRepo.listBySeason(leagueId, season);
  const mTeam = existing.find((s) => s.view === 'mTeam');
  if (mTeam) {
    return mTeam.payload;
  }

  const res = await context.espnClient.fetchLeague({ leagueId, season, view: 'mTeam' });
  await context.snapshotsRepo.save({
    leagueId,
    season,
    view: 'mTeam',
    fetchedAt: new Date(),
    payload: res.payload,
  });
  return res.payload;
}

function extractTeams(payload: unknown): TeamSummary[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const maybeTeams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(maybeTeams)) {
    return [];
  }

  const teams: TeamSummary[] = [];
  for (const team of maybeTeams) {
    if (!team || typeof team !== 'object') continue;
    const t = team as {
      id?: unknown;
      location?: unknown;
      nickname?: unknown;
      name?: unknown;
      abbrev?: unknown;
      points?: unknown;
    };
    const teamId = Number(t.id);
    if (!Number.isFinite(teamId)) continue;
    const name = formatTeamName(t, teamId);
    const abbrev = typeof t.abbrev === 'string' ? t.abbrev : undefined;
    const points =
      t.points && typeof t.points === 'object' ? (t.points as { for?: unknown }) : undefined;
    const pointsFor = typeof points?.for === 'number' ? points.for : undefined;
    teams.push({ teamId, name, abbrev, pointsFor });
  }

  return teams.sort((a, b) => a.teamId - b.teamId);
}
