import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { DEFAULT_VIEWS, FetchLeagueParams } from "@fantasy-canon/espn-client";
import { BotContext } from "../../config.js";
import { DEFAULT_VIEWS as CORE_DEFAULT_VIEWS } from "@fantasy-canon/espn-client";

const EXTENDED_VIEWS = new Set([
  "mTeam",
  "mRoster",
  "mDraftDetail",
  "mSettings",
  "mScoreboard",
  "mStandings"
]);

export async function handleIngestSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const guildId = interaction.guildId;
  const seasonInput = interaction.options.getString("season", true);
  const viewsInput = interaction.options.getString("views") ?? "default";
  const leagueOverride = interaction.options.getString("leagueid") ?? undefined;

  const guildConfig = guildId ? await context.leagueConfigRepo.getByGuildId(guildId) : undefined;
  const leagueId = leagueOverride ?? guildConfig?.leagueId ?? context.env.defaultLeagueId;

  if (!leagueId) {
    await interaction.reply({
      content: "League ID is required. Set it via /canon config set or ESPN_LEAGUE_ID.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const seasons = resolveSeasons(seasonInput, guildConfig);
  if (seasons.length === 0) {
    await interaction.reply({
      content:
        "No seasons resolved. Provide a year (e.g., 2025) or configure start/end seasons for 'all'.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const views = resolveViews(viewsInput);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const results: string[] = [];
  for (const season of seasons) {
    for (const view of views) {
      const params: FetchLeagueParams = { leagueId, season, view };
      try {
        const res = await context.espnClient.fetchLeague(params);
        await context.snapshotsRepo.save({
          leagueId,
          season,
          view,
          fetchedAt: new Date(),
          payload: res.payload
        });
        const bytes = JSON.stringify(res.payload)?.length ?? 0;
        results.push(`✅ ${season} ${view} (${bytes} bytes)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push(`❌ ${season} ${view}: ${message}`);
      }
    }
  }

  await interaction.editReply({
    content: [
      `Ingest for league ${leagueId}`,
      `Seasons: ${seasons.join(", ")}`,
      `Views: ${views.join(", ")}`,
      ...results
    ].join("\n"),
    flags: MessageFlags.Ephemeral
  });
}

function resolveSeasons(
  input: string,
  guildConfig?: { startSeason?: number; endSeason?: number }
): number[] {
  if (input.toLowerCase() === "all") {
    if (guildConfig?.startSeason !== undefined && guildConfig?.endSeason !== undefined) {
      const seasons: number[] = [];
      for (let year = guildConfig.startSeason; year <= guildConfig.endSeason; year += 1) {
        seasons.push(year);
      }
      return seasons;
    }
    return [];
  }

  const parsed = Number.parseInt(input, 10);
  if (Number.isNaN(parsed)) {
    return [];
  }
  return [parsed];
}

function resolveViews(input: string): string[] {
  if (input === "default" || input === "all") {
    // default/all: ingest core + extended so downstream commands don't need piecemeal fetches
    const base = new Set<string>([...DEFAULT_VIEWS, ...CORE_DEFAULT_VIEWS]);
    EXTENDED_VIEWS.forEach((v) => base.add(v));
    return Array.from(base);
  }
  return input
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}
