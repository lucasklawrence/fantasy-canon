import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { BotContext } from "../../config.js";

export async function handleStatusSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const { env, version } = context;

  const leagueSummary = env.defaultLeagueId ?? "not set";
  const databaseSummary = env.databaseUrl ? "configured" : "not configured";
  const authMode = env.espnS2 || env.espnSwid ? "cookies provided" : "public";

  await interaction.reply({
    content: [
      "Canon online.",
      `Version: v${version}`,
      `League: ${leagueSummary}`,
      `Database: ${databaseSummary}`,
      `ESPN auth: ${authMode}`
    ].join("\n"),
    flags: MessageFlags.Ephemeral
  });
}
