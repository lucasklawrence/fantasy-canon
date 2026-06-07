import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { BotContext } from "../../config.js";
import { buildTeamNameMap, formatTeamName } from "../../lib/teamNames.js";
import { getLeagueInfo } from "../../lib/leagueInfo.js";

type TeamLike = {
  id?: unknown;
  record?: unknown;
  transactionCounter?: unknown;
  owners?: unknown;
  primaryOwner?: unknown;
  owner?: unknown;
};

interface ManagerAggregate {
  managerId: string;
  displayName: string;
  latestTeamName: string;
  latestSeason: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  moves: number;
  seasons: Set<number>;
  teamNames: { season: number; name: string }[];
}

/**
 * Handles `/canon managers`, aggregating manager performance across seasons with sortable rollups.
 */
export async function handleManagersSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const seasonsText = interaction.options.getString("seasons", true);
  const sort = interaction.options.getString("sort") ?? "wins";
  const limit = interaction.options.getInteger("limit") ?? 10;
  const leagueOverride = interaction.options.getString("leagueid") ?? undefined;

  const guildId = interaction.guildId;
  const guildConfig = guildId ? await context.leagueConfigRepo.getByGuildId(guildId) : undefined;
  const leagueId = leagueOverride ?? guildConfig?.leagueId ?? context.env.defaultLeagueId;

  if (!leagueId) {
    await interaction.reply({
      content: "League ID is required. Set it via /canon config set or ESPN_LEAGUE_ID.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const seasons = parseSeasonList(seasonsText);
  if (seasons.length === 0) {
    await interaction.reply({
      content: "Provide seasons as comma list or range (e.g., 2022-2025 or 2024,2025).",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, seasons[0]);
    const aggregates = new Map<string, ManagerAggregate>();

    for (const season of seasons) {
      const payload = await ensureSnapshot(context, leagueId, season, "mTeam");
      const nameMap = buildTeamNameMap(payload);
      const ownerMap = buildOwnerDisplayMap(payload);
      const teams = extractTeams(payload, nameMap, ownerMap);
      for (const team of teams) {
        const managerId = team.managerId;
        const existing = aggregates.get(managerId);
        const agg: ManagerAggregate =
          existing ??
          {
            managerId,
            displayName: team.managerName,
            latestTeamName: team.teamName,
            latestSeason: season,
            wins: 0,
            losses: 0,
            ties: 0,
            pointsFor: 0,
            moves: 0,
            seasons: new Set<number>(),
            teamNames: []
          };

        if (!agg.displayName && team.managerName) {
          agg.displayName = team.managerName;
        }

        agg.wins += team.wins;
        agg.losses += team.losses;
        agg.ties += team.ties;
        agg.pointsFor += team.pointsFor;
        agg.moves += team.moves;
        agg.seasons.add(season);
        agg.teamNames.push({ season, name: team.teamName });
        if (season >= agg.latestSeason) {
          agg.latestSeason = season;
          agg.latestTeamName = team.teamName;
        }

        aggregates.set(managerId, agg);
      }
    }

    if (aggregates.size === 0) {
      await interaction.editReply({
        content: "No team data found for the requested seasons."
      });
      return;
    }

    const rows = Array.from(aggregates.values()).map((agg) => {
      const games = agg.wins + agg.losses + agg.ties;
      const winPct = games === 0 ? 0 : (agg.wins + 0.5 * agg.ties) / games;
      return { ...agg, winPct, seasonsList: Array.from(agg.seasons).sort((a, b) => a - b) };
    });

    rows.sort((a, b) => {
      if (sort === "winpct") {
        if (b.winPct !== a.winPct) return b.winPct - a.winPct;
        if (b.wins !== a.wins) return b.wins - a.wins;
      } else if (sort === "points") {
        if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
      } else if (sort === "moves") {
        if (b.moves !== a.moves) return b.moves - a.moves;
      } else {
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.winPct !== a.winPct) return b.winPct - a.winPct;
      }
      return a.displayName.localeCompare(b.displayName);
    });

    const header = `League ${leagueInfo.name ?? leagueId} | Seasons ${seasons.join(", ")} | Manager rollup (${sort})`;
    const body = rows.slice(0, limit).map((row, idx) => {
      const idShort = row.managerId.length > 10 ? `${row.managerId.slice(0, 10)}...` : row.managerId;
      const nameLabel =
        row.displayName && row.displayName !== row.latestTeamName
          ? `${row.displayName} (${row.latestTeamName})`
          : row.displayName || row.latestTeamName || "Manager";
      const record =
        row.ties > 0
          ? `${row.wins}-${row.losses}-${row.ties}`
          : `${row.wins}-${row.losses}`;
      const teams = summarizeTeams(row.teamNames);
      const seasonsPlayed = row.seasonsList.join(", ");
      const movesLabel = row.moves > 0 ? `, moves ${row.moves}` : "";
      return `${idx + 1}. ${nameLabel} [${idShort}] - ${record} (win% ${row.winPct.toFixed(
        3
      )}), PF ${Math.round(row.pointsFor)} | seasons: ${seasonsPlayed}${movesLabel}${
        teams ? ` | teams: ${teams}` : ""
      }`;
    });

    const lines = [header, ...body];

    // Respect Discord 2000-char limit by trimming rows if necessary.
    let dropped = 0;
    while (lines.join("\n").length > 1900 && lines.length > 1) {
      lines.pop();
      dropped += 1;
    }
    if (dropped > 0) {
      lines.push(`... ${dropped} more manager(s) truncated to fit Discord's 2000 character limit.`);
    }
    let content = lines.join("\n");
    if (content.length > 2000) {
      content = `${content.slice(0, 1990)}...`;
    }

    await interaction.editReply({
      content
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to compute manager rollup: ${message}`
    });
  }
}

/**
 * Extracts team-level stats and manager identities from an ESPN mTeam payload.
 */
function extractTeams(
  payload: unknown,
  nameMap: Map<number, string>,
  ownerMap: Map<string, string>
): Array<{
  teamName: string;
  managerId: string;
  managerName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  moves: number;
}> {
  if (!payload || typeof payload !== "object") return [];
  const maybeTeams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(maybeTeams)) return [];
  const results: Array<{
    teamName: string;
    managerId: string;
    managerName: string;
    wins: number;
    losses: number;
    ties: number;
    pointsFor: number;
    moves: number;
  }> = [];

  for (const team of maybeTeams) {
    if (!team || typeof team !== "object") continue;
    const t = team as TeamLike;
    const teamId = Number(t.id);
    if (!Number.isFinite(teamId)) continue;

    const managerId = getManagerId(t, teamId);
    const teamName = nameMap.get(teamId) ?? formatTeamName(team as unknown as Record<string, unknown>, teamId);
    const managerName = ownerMap.get(managerId) ?? getManagerName(t) ?? teamName;

    const record =
      t.record && typeof t.record === "object" ? (t.record as { overall?: unknown }).overall : undefined;
    const wins = Number((record as { wins?: unknown })?.wins) || 0;
    const losses = Number((record as { losses?: unknown })?.losses) || 0;
    const ties = Number((record as { ties?: unknown })?.ties) || 0;
    const pointsFor = Number((record as { pointsFor?: unknown })?.pointsFor) || 0;

    const tc =
      t.transactionCounter && typeof t.transactionCounter === "object"
        ? (t.transactionCounter as {
            acquisitions?: unknown;
            moveToActive?: unknown;
            moveToIR?: unknown;
            drops?: unknown;
            trades?: unknown;
          })
        : undefined;
    const moves =
      (Number(tc?.acquisitions) || 0) +
      (Number(tc?.moveToActive) || 0) +
      (Number(tc?.moveToIR) || 0) +
      (Number(tc?.drops) || 0) +
      (Number(tc?.trades) || 0);

    results.push({
      teamName,
      managerId,
      managerName,
      wins,
      losses,
      ties,
      pointsFor,
      moves
    });
  }

  return results;
}

/**
 * Builds a map of owner ID to preferred display name from the league members list.
 */
function buildOwnerDisplayMap(payload: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!payload || typeof payload !== "object") return map;
  const members = (payload as { members?: unknown }).members;
  if (!Array.isArray(members)) return map;
  for (const member of members) {
    if (!member || typeof member !== "object") continue;
    const m = member as {
      id?: unknown;
      displayName?: unknown;
      firstName?: unknown;
      lastName?: unknown;
      nickname?: unknown;
    };
    const id = typeof m.id === "string" ? m.id : undefined;
    if (!id) continue;
    const dn = typeof m.displayName === "string" ? m.displayName : undefined;
    const nick = typeof m.nickname === "string" ? m.nickname : undefined;
    const first = typeof m.firstName === "string" ? m.firstName : "";
    const last = typeof m.lastName === "string" ? m.lastName : "";
    const combo = `${first} ${last}`.trim();
    const name = dn || nick || (combo ? combo : undefined);
    if (name) map.set(id, name);
  }
  return map;
}

/**
 * Derives the best-available manager identifier, falling back to team slot when missing.
 */
function getManagerId(team: TeamLike, fallbackId: number): string {
  const primary = typeof team.primaryOwner === "string" && team.primaryOwner ? team.primaryOwner : undefined;
  if (primary) return primary;

  if (Array.isArray(team.owners)) {
    const ownerId = team.owners.find((o) => typeof o === "string" && o) as string | undefined;
    if (ownerId) return ownerId;
  }

  const owner = typeof team.owner === "string" && team.owner ? team.owner : undefined;
  if (owner) return owner;

  return `team-${fallbackId}`;
}

/**
 * Picks a displayable manager name from owners/owner metadata on the team entry.
 */
function getManagerName(team: TeamLike): string | undefined {
  if (Array.isArray(team.owners)) {
    for (const entry of team.owners) {
      if (entry && typeof entry === "object") {
        const nickname = (entry as { nickname?: unknown }).nickname;
        const first = (entry as { firstName?: unknown }).firstName;
        const last = (entry as { lastName?: unknown }).lastName;
        const combined = `${typeof first === "string" ? first : ""} ${typeof last === "string" ? last : ""}`.trim();
        if (typeof nickname === "string" && nickname) return nickname;
        if (combined) return combined;
      }
    }
  }
  return undefined;
}

/**
 * Produces a concise list of distinct team names with seasons, truncated after three entries.
 */
function summarizeTeams(entries: { season: number; name: string }[]): string {
  const unique = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.season}-${entry.name}`;
    if (!unique.has(key)) unique.set(key, entry.season);
  }
  const sorted = Array.from(unique.entries())
    .map(([key, season]) => ({ season, name: key.split("-").slice(1).join("-") }))
    .sort((a, b) => a.season - b.season);
  if (sorted.length <= 3) {
    return sorted.map((e) => `${e.name} (${e.season})`).join(", ");
  }
  const firstThree = sorted.slice(0, 3).map((e) => `${e.name} (${e.season})`).join(", ");
  return `${firstThree}, ...`;
}

/**
 * Parses a comma/range season string into sorted unique season numbers.
 */
function parseSeasonList(text: string): number[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(",").map((p) => p.trim());
  const seasons: number[] = [];
  for (const part of parts) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map((p) => Number.parseInt(p.trim(), 10));
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const [lo, hi] = start <= end ? [start, end] : [end, start];
        for (let y = lo; y <= hi; y += 1) {
          seasons.push(y);
        }
      }
    } else {
      const yr = Number.parseInt(part, 10);
      if (Number.isFinite(yr)) seasons.push(yr);
    }
  }
  return Array.from(new Set(seasons)).sort((a, b) => a - b);
}

/**
 * Returns a cached ESPN snapshot for the given league/season/view, fetching and saving if absent.
 */
async function ensureSnapshot(
  context: BotContext,
  leagueId: string,
  season: number,
  view: string
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
    payload: res.payload
  });
  return res.payload;
}
