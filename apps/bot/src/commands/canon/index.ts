import { ChannelType, ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { BotContext } from "../../config.js";
import { handleStatusSubcommand } from "./status.js";
import { handlePingSubcommand } from "./ping.js";
import { handleInspectSubcommand } from "./inspect.js";
import { handleConfigSubcommand } from "./leagueConfig.js";
import { handleIngestSubcommand } from "./ingest.js";
import { handleTeamsSubcommand } from "./teams.js";
import { handleLeaderboardSubcommand } from "./leaderboard.js";
import { handleTransactionsSubcommand } from "./transactions.js";
import { handleFaabPaceSubcommand } from "./faabPace.js";
import { handleBidsSubcommand } from "./bids.js";

export const canonCommand = new SlashCommandBuilder()
  .setName("canon")
  .setDescription("Fantasy Canon commands")
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Check bot status and config")
  )
  .addSubcommand((sub) =>
    sub
      .setName("teams")
      .setDescription("List teams for a season")
      .addIntegerOption((opt) =>
        opt.setName("season").setDescription("Season year (e.g., 2025)").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("leagueid").setDescription("Override league ID (defaults to config/env)")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("leaderboard")
      .setDescription("Show season leaderboard for a metric")
      .addStringOption((opt) =>
        opt
          .setName("metric")
          .setDescription("Metric to rank")
          .setRequired(true)
          .addChoices({ name: "faab", value: "faab" })
      )
      .addIntegerOption((opt) =>
        opt.setName("season").setDescription("Season year (e.g., 2025)").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("limit").setDescription("Number of teams to show (default 12)").setMinValue(1)
      )
      .addStringOption((opt) =>
        opt.setName("leagueid").setDescription("Override league ID (defaults to config/env)")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("transactions")
      .setDescription("Show latest transactions")
      .addIntegerOption((opt) =>
        opt.setName("season").setDescription("Season year (e.g., 2025)").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("limit").setDescription("Number of rows (default 10)").setMinValue(1)
      )
      .addStringOption((opt) =>
        opt.setName("leagueid").setDescription("Override league ID (defaults to config/env)")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("faabpace")
      .setDescription("FAAB spend/left pacing by week")
      .addIntegerOption((opt) =>
        opt.setName("season").setDescription("Season year (e.g., 2025)").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("mode")
          .setDescription("Show spent or left")
          .addChoices(
            { name: "spent", value: "spent" },
            { name: "left", value: "left" }
          )
      )
      .addIntegerOption((opt) =>
        opt
          .setName("budget")
          .setDescription("FAAB budget to compute remaining (default 100)")
          .setMinValue(1)
      )
      .addStringOption((opt) =>
        opt.setName("leagueid").setDescription("Override league ID (defaults to config/env)")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("bids")
      .setDescription("Find close or lopsided FAAB bids on the same player")
      .addIntegerOption((opt) =>
        opt.setName("season").setDescription("Season year (e.g., 2025)").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("mode")
          .setDescription("Close or lopsided")
          .addChoices(
            { name: "close", value: "close" },
            { name: "lopsided", value: "lopsided" }
          )
      )
      .addIntegerOption((opt) =>
        opt
          .setName("threshold")
          .setDescription("For close: max spread ($). For lopsided: min ratio.")
          .setMinValue(1)
      )
      .addIntegerOption((opt) =>
        opt.setName("limit").setDescription("Number of rows to show (default 5)").setMinValue(1)
      )
      .addStringOption((opt) =>
        opt.setName("leagueid").setDescription("Override league ID (defaults to config/env)")
      )
  )
  .addSubcommand((sub) =>
    sub.setName("ping").setDescription("Simple health check (pong)")
  )
  .addSubcommand((sub) =>
    sub
      .setName("inspect")
      .setDescription("Fetch an ESPN view and summarize it")
      .addIntegerOption((opt) =>
        opt
          .setName("season")
          .setDescription("Season year (e.g., 2025)")
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("view")
          .setDescription("ESPN view to fetch")
          .addChoices(
            { name: "mTeam", value: "mTeam" },
            { name: "mRoster", value: "mRoster" },
            { name: "mTransactions", value: "mTransactions" },
            { name: "mDraftDetail", value: "mDraftDetail" }
          )
      )
      .addStringOption((opt) =>
        opt.setName("leagueid").setDescription("Override league ID (defaults to env)")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("ingest")
      .setDescription("Fetch and store ESPN snapshots")
      .addStringOption((opt) =>
        opt
          .setName("season")
          .setDescription("Season year (e.g., 2025) or 'all' to use configured range")
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("views")
          .setDescription("View set: default|all|comma list (e.g., mTeam,mRoster)")
          .addChoices(
            { name: "default", value: "default" },
            { name: "all", value: "all" }
          )
      )
      .addStringOption((opt) =>
        opt.setName("leagueid").setDescription("Override league ID (defaults to config/env)")
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("config")
      .setDescription("Configure league defaults")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Set league, season range, channel, and timezone")
          .addStringOption((opt) =>
            opt.setName("leagueid").setDescription("League ID to use by default")
          )
          .addIntegerOption((opt) =>
            opt
              .setName("startseason")
              .setDescription("Start season (e.g., 2020)")
              .setMinValue(2000)
              .setMaxValue(2100)
          )
          .addIntegerOption((opt) =>
            opt
              .setName("endseason")
              .setDescription("End season (e.g., 2025)")
              .setMinValue(2000)
              .setMaxValue(2100)
          )
          .addChannelOption((opt) =>
            opt
              .setName("channel")
              .setDescription("Channel for scheduled posts")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          )
          .addStringOption((opt) =>
            opt
              .setName("timezone")
              .setDescription("IANA timezone (e.g., America/Los_Angeles)")
          )
      )
      .addSubcommand((sub) =>
        sub.setName("show").setDescription("Show current league configuration for this server")
      )
  );

export async function handleCanonInteraction(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (group === "config") {
    await handleConfigSubcommand(interaction, context);
    return;
  }

  if (subcommand === "status") {
    await handleStatusSubcommand(interaction, context);
  } else if (subcommand === "ping") {
    await handlePingSubcommand(interaction);
  } else if (subcommand === "inspect") {
    await handleInspectSubcommand(interaction, context);
  } else if (subcommand === "ingest") {
    await handleIngestSubcommand(interaction, context);
  } else if (subcommand === "teams") {
    await handleTeamsSubcommand(interaction, context);
  } else if (subcommand === "leaderboard") {
    await handleLeaderboardSubcommand(interaction, context);
  } else if (subcommand === "transactions") {
    await handleTransactionsSubcommand(interaction, context);
  } else if (subcommand === "faabpace") {
    await handleFaabPaceSubcommand(interaction, context);
  } else if (subcommand === "bids") {
    await handleBidsSubcommand(interaction, context);
  } else {
    await interaction.reply({
      content: `Subcommand "${subcommand}" is not implemented yet.`,
      ephemeral: true
    });
  }
}
