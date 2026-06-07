import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { EspnFetchError, summarizePayload } from "@fantasy-canon/espn-client";
import { BotContext } from "../../config.js";

export async function handleInspectSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const season = interaction.options.getInteger("season", true);
  const view = interaction.options.getString("view") ?? "mTeam";
  const leagueId = interaction.options.getString("leagueid") ?? context.env.defaultLeagueId;

  if (!leagueId) {
    await interaction.reply({
      content: "No league ID provided. Set ESPN_LEAGUE_ID or pass leagueId in the command.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const result = await context.espnClient.fetchLeague({ leagueId, season, view });
    const summary = summarizePayload(result.payload);
    const teamsCount = Array.isArray((result.payload as { teams?: unknown[] })?.teams)
      ? (result.payload as { teams: unknown[] }).teams.length
      : 0;

    await context.snapshotsRepo.save({
      leagueId,
      season,
      view,
      fetchedAt: new Date(),
      payload: result.payload
    });

    const lines = [
      `Fetched ${view} for league ${leagueId}, season ${season}.`,
      `Status: ${result.status}`,
      `Teams found: ${teamsCount}`,
      `Payload bytes: ${summary.byteSize}`,
      `Top-level keys: ${summary.topLevelKeys.join(", ") || "none"}`
    ];

    await interaction.editReply({ content: lines.join("\n") });
  } catch (error) {
    console.error("Failed to inspect ESPN view", error);
    let description =
      error instanceof Error ? error.message : "Failed to fetch or summarize the view.";
    if (error instanceof EspnFetchError) {
      description = `${error.message}${error.bodySnippet ? ` (${error.bodySnippet})` : ""}`;
    }
    await interaction.editReply({
      content:
        `Inspect failed. ${description}\n` +
        "If this is a private league, set ESPN_S2 and ESPN_SWID cookies in the bot .env."
    });
  }
}
