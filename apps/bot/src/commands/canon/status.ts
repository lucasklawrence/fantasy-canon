import { ChatInputCommandInteraction, MessageFlags, channelMention } from "discord.js";
import { BotContext } from "../../config.js";

export async function handleStatusSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const { env, version } = context;

  const guildConfig = interaction.guildId
    ? await context.leagueConfigRepo.getByGuildId(interaction.guildId)
    : undefined;

  const leagueSummary = guildConfig?.leagueId ?? env.defaultLeagueId ?? "not set";
  const seasonSummary =
    guildConfig?.startSeason || guildConfig?.endSeason
      ? `${guildConfig?.startSeason ?? "?"}-${guildConfig?.endSeason ?? "?"}`
      : "not set";
  const channelSummary = guildConfig?.postChannelId
    ? channelMention(guildConfig.postChannelId)
    : "not set";
  const timezoneSummary = guildConfig?.timezone ?? "not set";
  const databaseSummary = env.databaseUrl ? "configured" : "not configured";
  const authMode = env.espnS2 || env.espnSwid ? "cookies provided" : "public";

  await interaction.reply({
    content: [
      "Canon online.",
      `Version: v${version}`,
      `League: ${leagueSummary}`,
      `Seasons: ${seasonSummary}`,
      `Channel: ${channelSummary}`,
      `Timezone: ${timezoneSummary}`,
      `Database: ${databaseSummary}`,
      `ESPN auth: ${authMode}`
    ].join("\n"),
    flags: MessageFlags.Ephemeral
  });
}
