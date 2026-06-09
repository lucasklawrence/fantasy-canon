import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { BotContext } from '../../config.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import { getLeagueInfo } from '../../lib/leagueInfo.js';

type TeamLike = {
  id?: unknown;
  record?: unknown;
  transactionCounter?: unknown;
  pointsFor?: unknown;
};

interface TeamInfo {
  id: number;
  name: string;
  wins: number;
  losses: number;
  pointsFor: number;
  acquisitions: number;
  moveToActive: number;
  moveToIR: number;
  totalMoves: number;
}

/**
 * Handles `/canon legacy` for a single season, computing luck and dominant archetypes for that year.
 */
export async function handleLegacySubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
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
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload, nameMap);
    if (teams.length === 0) {
      await interaction.editReply({
        content: 'No teams found.',
      });
      return;
    }

    // Luck: points rank vs wins rank
    const pointsRank = rankBy(teams, (t) => t.pointsFor, 'desc');
    const winRank = rankBy(teams, (t) => t.wins, 'desc');
    const luckEntries = teams.map((t) => {
      const pr = pointsRank.get(t) ?? teams.length;
      const wr = winRank.get(t) ?? teams.length;
      return { team: t, luck: pr - wr };
    });
    const mostUnlucky = luckEntries.reduce(
      (min, cur) => (cur.luck < min.luck ? cur : min),
      luckEntries[0],
    );
    const mostDominant = teams.reduce(
      (best, cur) => (winPct(cur) > winPct(best) ? cur : best),
      teams[0],
    );

    // Archetype leaderboard by total moves
    const archetype = teams
      .map((t) => ({ team: t, moves: t.totalMoves }))
      .sort((a, b) => b.moves - a.moves)
      .slice(0, 3);

    const lines: string[] = [];
    lines.push(`Most unlucky: ${mostUnlucky.team.name} (luck ${mostUnlucky.luck.toFixed(2)})`);
    lines.push(
      `Most dominant: ${mostDominant.name} (${mostDominant.wins}-${mostDominant.losses}, win% ${winPct(
        mostDominant,
      ).toFixed(3)})`,
    );
    lines.push('Archetype: Wire/Activity leaders');
    lines.push(
      ...archetype.map(
        (a, idx) =>
          `${idx + 1}. ${a.team.name} — adds ${a.team.acquisitions}, total moves ${a.moves}`,
      ),
    );

    await interaction.editReply({
      content: [
        `League ${leagueInfo.name ?? leagueId} • Season ${season} • Legacy awards`,
        ...lines,
      ].join('\n'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to compute legacy awards: ${message}`,
    });
  }
}

/**
 * Handles `/canon legacy history`, aggregating team performance across multiple seasons and
 * computing franchise-level awards.
 */
export async function handleLegacyHistorySubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const seasonsText = interaction.options.getString('seasons', true);
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

  const seasons = parseSeasonList(seasonsText);
  if (seasons.length === 0) {
    await interaction.reply({
      content: 'Provide seasons as comma list or range (e.g., 2022-2025 or 2024,2025).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, seasons[0]);
    const aggregates = new Map<number, TeamInfo>();

    for (const season of seasons) {
      const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
      const nameMap = buildTeamNameMap(mTeamPayload);
      const teams = extractTeams(mTeamPayload, nameMap);
      for (const team of teams) {
        const existing = aggregates.get(team.id);
        if (existing) {
          existing.name = team.name; // keep latest name seen
          existing.wins += team.wins;
          existing.losses += team.losses;
          existing.pointsFor += team.pointsFor;
          existing.acquisitions += team.acquisitions;
          existing.moveToActive += team.moveToActive;
          existing.moveToIR += team.moveToIR;
          existing.totalMoves += team.totalMoves;
        } else {
          aggregates.set(team.id, { ...team });
        }
      }
    }

    const aggregate = Array.from(aggregates.values());

    if (aggregate.length === 0) {
      await interaction.editReply({
        content: 'No team data found for the requested seasons.',
      });
      return;
    }

    const pointsRank = rankBy(aggregate, (t) => t.pointsFor, 'desc');
    const winRank = rankBy(aggregate, (t) => t.wins, 'desc');
    const luckEntries = aggregate.map((t) => {
      const pr = pointsRank.get(t) ?? aggregate.length;
      const wr = winRank.get(t) ?? aggregate.length;
      return { team: t, luck: pr - wr };
    });
    const mostUnlucky = luckEntries.reduce(
      (min, cur) => (cur.luck < min.luck ? cur : min),
      luckEntries[0],
    );
    const mostDominant = aggregate.reduce(
      (best, cur) => (winPct(cur) > winPct(best) ? cur : best),
      aggregate[0],
    );

    const archetype = aggregate
      .map((t) => ({ team: t, moves: t.totalMoves }))
      .sort((a, b) => b.moves - a.moves)
      .slice(0, 3);

    const lines: string[] = [];
    lines.push(`Seasons: ${seasons.join(', ')}`);
    lines.push('Mode: aggregated per team across seasons');
    lines.push(
      `Most unlucky (aggregated): ${mostUnlucky.team.name} (luck ${mostUnlucky.luck.toFixed(2)})`,
    );
    lines.push(
      `Most dominant (aggregated): ${mostDominant.name} (${mostDominant.wins}-${mostDominant.losses}, win% ${winPct(
        mostDominant,
      ).toFixed(3)})`,
    );
    lines.push('Archetype: Wire/Activity leaders (aggregated)');
    lines.push(
      ...archetype.map(
        (a, idx) =>
          `${idx + 1}. ${a.team.name} — adds ${a.team.acquisitions}, total moves ${a.moves}`,
      ),
    );

    await interaction.editReply({
      content: [
        `League ${leagueInfo.name ?? leagueId} • Legacy (multi-season, aggregated)`,
        ...lines,
      ].join('\n'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to compute legacy history: ${message}`,
    });
  }
}

/**
 * Normalizes the ESPN mTeam payload into a TeamInfo list with move and scoring totals.
 */
function extractTeams(payload: unknown, nameMap: Map<number, string>): TeamInfo[] {
  if (!payload || typeof payload !== 'object') return [];
  const maybeTeams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(maybeTeams)) return [];
  const teams: TeamInfo[] = [];
  for (const team of maybeTeams) {
    if (!team || typeof team !== 'object') continue;
    const t = team as TeamLike;
    const id = Number(t.id);
    if (!Number.isFinite(id)) continue;
    const record =
      t.record && typeof t.record === 'object' ? (t.record as { overall?: unknown }) : undefined;
    const overall = record && typeof record === 'object' ? record.overall : undefined;
    const wins = Number((overall as { wins?: unknown })?.wins) || 0;
    const losses = Number((overall as { losses?: unknown })?.losses) || 0;
    const pointsFor = Number((overall as { pointsFor?: unknown })?.pointsFor) || 0;
    const tc =
      t.transactionCounter && typeof t.transactionCounter === 'object'
        ? (t.transactionCounter as {
            acquisitions?: unknown;
            moveToActive?: unknown;
            moveToIR?: unknown;
            drops?: unknown;
            trades?: unknown;
          })
        : undefined;
    const acquisitions = Number(tc?.acquisitions) || 0;
    const moveToActive = Number(tc?.moveToActive) || 0;
    const moveToIR = Number(tc?.moveToIR) || 0;
    const totalMoves =
      acquisitions + moveToActive + moveToIR + (Number(tc?.drops) || 0) + (Number(tc?.trades) || 0);

    teams.push({
      id,
      name: nameMap.get(id) ?? `Team ${id}`,
      wins,
      losses,
      pointsFor,
      acquisitions,
      moveToActive,
      moveToIR,
      totalMoves,
    });
  }
  return teams;
}

/**
 * Ranks teams by a derived value, returning a map of team entry to 1-based rank.
 */
function rankBy(
  teams: TeamInfo[],
  getter: (t: TeamInfo) => number,
  direction: 'asc' | 'desc',
): Map<TeamInfo, number> {
  const scored = teams.map((t) => ({ team: t, value: getter(t) }));
  scored.sort((a, b) => (direction === 'asc' ? a.value - b.value : b.value - a.value));
  const ranks = new Map<TeamInfo, number>();
  scored.forEach((entry, idx) => ranks.set(entry.team, idx + 1));
  return ranks;
}

/**
 * Computes win percentage, guarding against divide-by-zero for winless teams.
 */
function winPct(t: TeamInfo): number {
  const total = t.wins + t.losses;
  if (total === 0) return 0;
  return t.wins / total;
}

/**
 * Parses a comma/range season list (e.g., "2022-2024,2026") into sorted unique numbers.
 */
function parseSeasonList(text: string): number[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(',').map((p) => p.trim());
  const seasons: number[] = [];
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map((p) => Number.parseInt(p.trim(), 10));
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
 * Returns a cached league snapshot for a view and season, fetching and saving it when absent.
 */
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
