import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { BotContext } from "../../config.js";
import { handleStatusSubcommand } from "./status.js";
import { handlePingSubcommand } from "./ping.js";
import { handleInspectSubcommand } from "./inspect.js";

export const canonCommand = new SlashCommandBuilder()
  .setName("canon")
  .setDescription("Fantasy Canon commands")
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Check bot status and config")
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
  );

export async function handleCanonInteraction(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "status") {
    await handleStatusSubcommand(interaction, context);
  } else if (subcommand === "ping") {
    await handlePingSubcommand(interaction);
  } else if (subcommand === "inspect") {
    await handleInspectSubcommand(interaction, context);
  } else {
    await interaction.reply({
      content: `Subcommand "${subcommand}" is not implemented yet.`,
      ephemeral: true
    });
  }
}
