import { AutocompleteInteraction, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { BotContext } from '../../config.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import { buildManagerNameMap } from '../../lib/managerNames.js';
import { getLeagueInfo } from '../../lib/leagueInfo.js';
import { ensureSnapshot } from '../../lib/snapshots.js';
import { extractTeams } from '../../lib/teamStats.js';
import { extractRoster } from '../../lib/roster.js';
import { buildScoutProfile } from '../../lib/scoutProfile.js';
import { filterTeamChoices } from '../../lib/teamNameCache.js';

const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_CHOICE_NAME_LIMIT = 100;

async function resolveLeagueId(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction,
  context: BotContext,
): Promise<string | undefined> {
  const override = interaction.options.getString('leagueid') ?? undefined;
  const guildId = interaction.guildId;
  const guildConfig = guildId ? await context.leagueConfigRepo.getByGuildId(guildId) : undefined;
  return override ?? guildConfig?.leagueId ?? context.env.defaultLeagueId;
}

/**
 * Resolve the opponent option (either a team id from autocomplete, or a free-typed name)
 * to a team id, matching team or manager name case-insensitively.
 */
function resolveOpponent(
  input: string,
  nameMap: Map<number, string>,
  managerMap: Map<number, string>,
): number | undefined {
  const lc = input.trim().toLowerCase();
  if (!lc) return undefined;
  if (/^\d+$/.test(lc)) {
    const id = Number(lc);
    if (nameMap.has(id)) return id;
  }
  const teamEntries = Array.from(nameMap.entries());
  const exactTeam = teamEntries.find(([, name]) => name.toLowerCase() === lc);
  if (exactTeam) return exactTeam[0];
  const exactManager = Array.from(managerMap.entries()).find(
    ([, name]) => name.toLowerCase() === lc,
  );
  if (exactManager) return exactManager[0];
  const partialTeam = teamEntries.find(([, name]) => name.toLowerCase().includes(lc));
  if (partialTeam) return partialTeam[0];
  const partialManager = Array.from(managerMap.entries()).find(([, name]) =>
    name.toLowerCase().includes(lc),
  );
  return partialManager?.[0];
}

/**
 * `/canon scout` — ephemeral opponent scouting report: record, home/away split, streak,
 * manager archetype, trade block, and a current roster snapshot.
 */
export async function handleScoutSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const opponentInput = interaction.options.getString('opponent', true);
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
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
    const nameMap = buildTeamNameMap(mTeamPayload);
    const managerMap = buildManagerNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);

    if (teams.length === 0) {
      await interaction.editReply({ content: 'No teams found for that league and season.' });
      return;
    }

    const teamId = resolveOpponent(opponentInput, nameMap, managerMap);
    const team = teamId === undefined ? undefined : teams.find((t) => t.id === teamId);
    if (teamId === undefined || !team) {
      await interaction.editReply({
        content: `Unable to resolve opponent "${opponentInput}". Pick from the autocomplete suggestions.`,
      });
      return;
    }

    const mRosterPayload = await ensureSnapshot(context, leagueId, season, 'mRoster');
    const roster = extractRoster(mRosterPayload, teamId);

    const lines = buildScoutProfile({
      team,
      allTeams: teams,
      teamName: nameMap.get(teamId) ?? `Team ${teamId}`,
      managerName: managerMap.get(teamId),
      roster,
      season,
      leagueLabel,
    });

    let content = lines.join('\n');
    if (content.length > DISCORD_MESSAGE_LIMIT) {
      content = `${content.slice(0, DISCORD_MESSAGE_LIMIT - 3)}...`;
    }

    await interaction.editReply({ content });
  } catch (error) {
    console.error('Failed to compute scout', error);
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ content: `Failed to scout opponent: ${message}` });
  }
}

/**
 * Autocomplete for `/canon scout opponent:`. Reads team names only from the in-memory cache —
 * Discord requires a response within 3s and forbids deferral, so this never calls ESPN. A cold
 * cache (nothing ingested for this league yet) simply yields no suggestions.
 */
export async function handleScoutAutocomplete(
  interaction: AutocompleteInteraction,
  context: BotContext,
): Promise<void> {
  try {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'opponent') {
      await interaction.respond([]);
      return;
    }
    const leagueId = await resolveLeagueId(interaction, context);
    if (!leagueId) {
      await interaction.respond([]);
      return;
    }
    const season = interaction.options.getInteger('season');
    // When a season is chosen, respect it as a hard boundary — never suggest opponents from
    // other seasons. Only fall back to the league-wide union when no season is picked yet.
    const choices =
      season === null
        ? context.teamNameCache.getAllForLeague(leagueId)
        : context.teamNameCache.get(leagueId, season);
    const filtered = filterTeamChoices(choices, String(focused.value ?? ''));
    await interaction.respond(
      filtered.map((c) => ({
        name: c.label.slice(0, DISCORD_CHOICE_NAME_LIMIT),
        value: String(c.teamId),
      })),
    );
  } catch (error) {
    console.error('Failed to handle scout autocomplete', error);
    // Autocomplete must never throw unhandled; fall back to an empty menu.
    try {
      await interaction.respond([]);
    } catch {
      // Interaction may have expired; nothing more to do.
    }
  }
}
