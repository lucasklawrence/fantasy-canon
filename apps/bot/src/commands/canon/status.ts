import { ChatInputCommandInteraction } from "discord.js";
import { BotContext } from "../../config.js";

export async function handleStatusSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const { env, version } = context;

  const leagueSummary = env.defaultLeagueId ?? "not set";
  const databaseSummary = env.databaseUrl ? "configured" : "not configured";

  await interaction.reply({
    ephemeral: true,
    content: [
      "Canon online.",
      `Version: v${version}`,
      `League: ${leagueSummary}`,
      `Database: ${databaseSummary}`
    ].join("\n")
  });
}
