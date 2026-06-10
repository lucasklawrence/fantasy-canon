import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { BotContext } from '../../config.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';

interface Matchup {
  homeId: number;
  awayId: number;
  homeScore: number;
  awayScore: number;
}

interface RivalryRecord {
  teamA: number;
  teamB: number;
  aWins: number;
  bWins: number;
  aPoints: number;
  bPoints: number;
}

export async function handleRivalrySubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const teamAInput = interaction.options.getString('teama', true);
  const teamBInput = interaction.options.getString('teamb', true);
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

function ensureNumber(val: unknown): number | undefined {
  const num = Number(val);
  return Number.isFinite(num) ? num : undefined;
}

function extractMatchups(payload: unknown): Matchup[] {
  const matchups: Matchup[] = [];
  if (!payload || typeof payload !== 'object') return matchups;
  const maybeSchedule = (payload as { schedule?: unknown }).schedule;
  const maybeMatchups = (payload as { matchups?: unknown }).matchups;
  const source = Array.isArray(maybeSchedule)
    ? maybeSchedule
    : Array.isArray(maybeMatchups)
      ? maybeMatchups
      : [];

  for (const m of source) {
    if (!m || typeof m !== 'object') continue;
    const home = (m as { home?: unknown }).home;
    const away = (m as { away?: unknown }).away;
    if (home && typeof home === 'object' && away && typeof away === 'object') {
      const homeId = ensureNumber((home as { teamId?: unknown }).teamId);
      const awayId = ensureNumber((away as { teamId?: unknown }).teamId);
      const homeScore = ensureNumber((home as { totalPoints?: unknown }).totalPoints) ?? 0;
      const awayScore = ensureNumber((away as { totalPoints?: unknown }).totalPoints) ?? 0;
      if (homeId !== undefined && awayId !== undefined) {
        matchups.push({ homeId, awayId, homeScore, awayScore });
      }
      continue;
    }
    const teams = (m as { teams?: unknown }).teams;
    if (Array.isArray(teams) && teams.length >= 2) {
      const t1: unknown = teams[0];
      const t2: unknown = teams[1];
      if (t1 && typeof t1 === 'object' && t2 && typeof t2 === 'object') {
        const t1Id = ensureNumber((t1 as { teamId?: unknown }).teamId);
        const t2Id = ensureNumber((t2 as { teamId?: unknown }).teamId);
        const t1Score = ensureNumber((t1 as { totalPoints?: unknown }).totalPoints) ?? 0;
        const t2Score = ensureNumber((t2 as { totalPoints?: unknown }).totalPoints) ?? 0;
        if (t1Id !== undefined && t2Id !== undefined) {
          matchups.push({ homeId: t1Id, awayId: t2Id, homeScore: t1Score, awayScore: t2Score });
        }
      }
    }
  }
  return matchups;
}

function buildRivalry(matchups: Matchup[], aId: number, bId: number): RivalryRecord | undefined {
  let aWins = 0;
  let bWins = 0;
  let aPoints = 0;
  let bPoints = 0;
  for (const m of matchups) {
    const isAB = (m.homeId === aId && m.awayId === bId) || (m.homeId === bId && m.awayId === aId);
    if (!isAB) continue;
    const aScore = m.homeId === aId ? m.homeScore : m.awayScore;
    const bScore = m.homeId === bId ? m.homeScore : m.awayScore;
    aPoints += aScore;
    bPoints += bScore;
    if (aScore > bScore) aWins += 1;
    else if (bScore > aScore) bWins += 1;
  }
  if (aWins === 0 && bWins === 0 && aPoints === 0 && bPoints === 0) return undefined;
  return { teamA: aId, teamB: bId, aWins, bWins, aPoints, bPoints };
}

function buildAllRivalries(matchups: Matchup[]): RivalryRecord[] {
  const map = new Map<string, RivalryRecord>();
  for (const m of matchups) {
    const key = m.homeId < m.awayId ? `${m.homeId}-${m.awayId}` : `${m.awayId}-${m.homeId}`;
    const rec = map.get(key) ?? {
      teamA: m.homeId < m.awayId ? m.homeId : m.awayId,
      teamB: m.homeId < m.awayId ? m.awayId : m.homeId,
      aWins: 0,
      bWins: 0,
      aPoints: 0,
      bPoints: 0,
    };
    const homeIsA = m.homeId === rec.teamA;
    const aScore = homeIsA ? m.homeScore : m.awayScore;
    const bScore = homeIsA ? m.awayScore : m.homeScore;
    rec.aPoints += aScore;
    rec.bPoints += bScore;
    if (aScore > bScore) rec.aWins += 1;
    else if (bScore > aScore) rec.bWins += 1;
    map.set(key, rec);
  }
  return Array.from(map.values());
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
