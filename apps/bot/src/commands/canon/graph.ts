import { AttachmentBuilder, ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { BotContext } from "../../config.js";
import { buildTeamNameMap } from "../../lib/teamNames.js";
import { getLeagueInfo } from "../../lib/leagueInfo.js";
import { renderLuckGraph, renderDraftProphecyGraph } from "@fantasy-canon/renderer";

export async function handleGraphSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const metric = interaction.options.getString("metric", true);
  const season = interaction.options.getInteger("season", true);
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

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, "mTeam");
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);

    if (metric === "luck") {
      const avgPoints = average(teams.map((t) => t.pointsFor));
      const avgWins = average(teams.map((t) => t.wins));
      const points = teams.map((t) => {
        const expectedWins =
          avgPoints > 0 ? (t.pointsFor / avgPoints) * avgWins : avgWins;
        return {
          team: nameMap.get(t.id) ?? `Team ${t.id}`,
          wins: t.wins,
          expectedWins
        };
      });
      const buffer = await renderLuckGraph({
        title: `${leagueInfo.name ?? leagueId} • Luck graph`,
        subtitle: `Season ${season}`,
        points
      });
      await sendBuffer(interaction, buffer, `${leagueId}-luck-${season}.txt`, leagueInfo.name, season, "Luck graph");
    } else if (metric === "draft-prophecy") {
      const points = teams
        .filter((t) => t.projectedRank !== undefined || t.finishRank !== undefined)
        .map((t) => ({
          team: nameMap.get(t.id) ?? `Team ${t.id}`,
          projectedRank: t.projectedRank,
          finalRank: t.finishRank
        }));
      if (points.length === 0) {
        await interaction.editReply({
          content: "No draft projection data found.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      const buffer = await renderDraftProphecyGraph({
        title: `${leagueInfo.name ?? leagueId} • Draft Prophecy`,
        subtitle: `Season ${season}`,
        points
      });
      await sendBuffer(
        interaction,
        buffer,
        `${leagueId}-draft-${season}.txt`,
        leagueInfo.name,
        season,
        "Draft Prophecy"
      );
    } else {
      await interaction.editReply({
        content: `Metric "${metric}" is not supported.`,
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to render graph: ${message}`,
      flags: MessageFlags.Ephemeral
    });
  }
}

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

interface TeamSummary {
  id: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  projectedRank?: number;
  finishRank?: number;
}

function extractTeams(payload: unknown): TeamSummary[] {
  if (!payload || typeof payload !== "object") return [];
  const maybeTeams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(maybeTeams)) return [];
  const teams: TeamSummary[] = [];
  for (const team of maybeTeams) {
    if (!team || typeof team !== "object") continue;
    const t = team as {
      id?: unknown;
      record?: unknown;
      draftDayProjectedRank?: unknown;
      rankFinal?: unknown;
      rankCalculatedFinal?: unknown;
      playoffSeed?: unknown;
    };
    const id = Number(t.id);
    if (!Number.isFinite(id)) continue;
    const record =
      t.record && typeof t.record === "object" ? (t.record as { overall?: unknown }) : undefined;
    const overall =
      record && typeof record === "object" ? (record as { overall?: unknown }).overall : undefined;
    const wins = Number((overall as { wins?: unknown })?.wins) || 0;
    const losses = Number((overall as { losses?: unknown })?.losses) || 0;
    const ties = Number((overall as { ties?: unknown })?.ties) || 0;
    const pointsFor = Number((overall as { pointsFor?: unknown })?.pointsFor) || 0;
    const projectedRank = Number(t.draftDayProjectedRank);
    const finishRank =
      Number(t.rankFinal) ||
      Number(t.rankCalculatedFinal) ||
      Number(t.playoffSeed) ||
      undefined;

    teams.push({ id, wins, losses, ties, pointsFor, projectedRank, finishRank });
  }
  return teams;
}

async function sendBuffer(
  interaction: ChatInputCommandInteraction,
  buffer: Buffer,
  filename: string,
  leagueName: string | undefined,
  season: number,
  label: string
): Promise<void> {
  const attachment = new AttachmentBuilder(buffer, { name: filename });
  await interaction.editReply({
    content: `League ${leagueName ?? ""} • Season ${season} • ${label}`,
    files: [attachment],
    flags: MessageFlags.Ephemeral
  });
}

function average(values: number[]): number {
  if (!values.length) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}
