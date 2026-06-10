import { AutocompleteInteraction, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { BotContext } from '../../config.js';
import { buildTeamNameMap, formatTeamName } from '../../lib/teamNames.js';
import { cacheTeamsFromPayload, searchCachedTeams } from '../../lib/teamCache.js';

export interface TeamProfile {
  id: number;
  name: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  projectedRank?: number;
  finishRank?: number;
  playoffSeed?: number;
  faabSpent?: number;
}

function num(val: unknown): number | undefined {
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pull one team's scouting profile out of an mTeam payload: record, points for,
 * projected vs final rank, playoff seed, and FAAB spent. Pure and defensive —
 * mirrors the field paths used by graph.ts / legacy.ts / leaderboard.ts. Returns
 * undefined if the team id isn't present.
 */
export function extractTeamProfile(payload: unknown, teamId: number): TeamProfile | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const teams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(teams)) return undefined;

  for (const team of teams as unknown[]) {
    if (!team || typeof team !== 'object') continue;
    const t = team as {
      id?: unknown;
      record?: unknown;
      draftDayProjectedRank?: unknown;
      rankFinal?: unknown;
      rankCalculatedFinal?: unknown;
      playoffSeed?: unknown;
      transactionCounter?: unknown;
    };
    if (num(t.id) !== teamId) continue;

    const overall =
      t.record && typeof t.record === 'object'
        ? (t.record as { overall?: unknown }).overall
        : undefined;
    const o = overall && typeof overall === 'object' ? (overall as Record<string, unknown>) : {};

    const tc =
      t.transactionCounter && typeof t.transactionCounter === 'object'
        ? (t.transactionCounter as { acquisitionBudgetSpent?: unknown })
        : undefined;

    return {
      id: teamId,
      name: formatTeamName(t as Record<string, unknown>, teamId),
      wins: num(o.wins) ?? 0,
      losses: num(o.losses) ?? 0,
      ties: num(o.ties) ?? 0,
      pointsFor: num(o.pointsFor) ?? 0,
      projectedRank: num(t.draftDayProjectedRank),
      finishRank: num(t.rankFinal) ?? num(t.rankCalculatedFinal),
      playoffSeed: num(t.playoffSeed),
      faabSpent:
        typeof tc?.acquisitionBudgetSpent === 'number' ? tc.acquisitionBudgetSpent : undefined,
    };
  }
  return undefined;
}

/** Resolve an opponent option (a team id from autocomplete, or a typed name) to a team id. */
function resolveTeamId(nameMap: Map<number, string>, input: string): number | undefined {
  const lc = input.trim().toLowerCase();
  if (!lc) return undefined;
  if (Number.isFinite(Number(lc)) && nameMap.has(Number(lc))) return Number(lc);
  const entries = Array.from(nameMap.entries());
  const exact = entries.find(([, name]) => name.toLowerCase() === lc);
  if (exact) return exact[0];
  const partial = entries.find(([, name]) => name.toLowerCase().includes(lc));
  return partial?.[0];
}

function resolveLeagueId(
  context: BotContext,
  guildLeagueId: string | undefined,
  override: string | undefined,
): string | undefined {
  return override ?? guildLeagueId ?? context.env.defaultLeagueId;
}

export async function handleScoutSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const opponentInput = interaction.options.getString('opponent', true);
  const leagueOverride = interaction.options.getString('leagueid') ?? undefined;
  const guildId = interaction.guildId;
  const guildConfig = guildId ? await context.leagueConfigRepo.getByGuildId(guildId) : undefined;
  const leagueId = resolveLeagueId(context, guildConfig?.leagueId, leagueOverride);

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
    cacheTeamsFromPayload(leagueId, season, mTeamPayload);
    const nameMap = buildTeamNameMap(mTeamPayload);

    const teamId = resolveTeamId(nameMap, opponentInput);
    if (teamId === undefined) {
      await interaction.editReply({
        content:
          'Unable to resolve that team. Pick one from the autocomplete or use an exact name from /canon admin teams.',
      });
      return;
    }

    const profile = extractTeamProfile(mTeamPayload, teamId);
    if (!profile) {
      await interaction.editReply({ content: 'No data found for that team this season.' });
      return;
    }

    await interaction.editReply({ content: formatProfile(leagueId, season, profile) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ content: `Failed to scout team: ${message}` });
  }
}

function formatProfile(leagueId: string, season: number, p: TeamProfile): string {
  const record = p.ties > 0 ? `${p.wins}-${p.losses}-${p.ties}` : `${p.wins}-${p.losses}`;
  const lines = [
    `League ${leagueId} • Season ${season} • Scouting ${p.name}`,
    `Record: ${record} • Points for: ${p.pointsFor.toFixed(1)}`,
  ];
  const ranks: string[] = [];
  if (p.projectedRank !== undefined) ranks.push(`projected #${p.projectedRank}`);
  if (p.finishRank !== undefined) ranks.push(`finished #${p.finishRank}`);
  if (p.playoffSeed !== undefined && p.playoffSeed > 0)
    ranks.push(`playoff seed #${p.playoffSeed}`);
  if (ranks.length) lines.push(`Rank: ${ranks.join(' • ')}`);
  if (p.faabSpent !== undefined) lines.push(`FAAB spent: $${p.faabSpent}`);
  return lines.join('\n');
}

// Guards against firing overlapping warm fetches for the same league/season.
const warming = new Set<string>();

/**
 * Autocomplete for the `opponent` option. Serves matches from the in-memory team
 * cache only — never blocks on ESPN (3s hard limit, no defer). On a cache miss it
 * kicks off a non-blocking warm fetch so later keystrokes have data.
 */
export async function handleScoutAutocomplete(
  interaction: AutocompleteInteraction,
  context: BotContext,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'opponent') {
    await interaction.respond([]);
    return;
  }

  const season = interaction.options.getInteger('season');
  const leagueOverride = interaction.options.getString('leagueid') ?? undefined;
  const guildId = interaction.guildId;
  const guildConfig = guildId ? await context.leagueConfigRepo.getByGuildId(guildId) : undefined;
  const leagueId = resolveLeagueId(context, guildConfig?.leagueId, leagueOverride);

  if (!leagueId || typeof season !== 'number') {
    await interaction.respond([]);
    return;
  }

  const matches = searchCachedTeams(leagueId, season, String(focused.value), 25);
  await interaction.respond(matches.map((t) => ({ name: t.name, value: String(t.id) })));

  if (matches.length === 0) {
    warmTeamCache(context, leagueId, season);
  }
}

/** Fire-and-forget: populate the team cache for next time. Errors are swallowed. */
function warmTeamCache(context: BotContext, leagueId: string, season: number): void {
  const key = `${leagueId}:${season}`;
  if (warming.has(key)) return;
  warming.add(key);
  void ensureSnapshot(context, leagueId, season, 'mTeam')
    .then((payload) => {
      cacheTeamsFromPayload(leagueId, season, payload);
    })
    .catch(() => {
      // Best-effort warm; autocomplete just stays empty until data is available.
    })
    .finally(() => {
      warming.delete(key);
    });
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
