import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { BotContext } from "../../config.js";
import { handleStatusSubcommand } from "./status.js";
import { handlePingSubcommand } from "./ping.js";

export const canonCommand = new SlashCommandBuilder()
  .setName("canon")
  .setDescription("Fantasy Canon commands")
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Check bot status and config")
  )
  .addSubcommand((sub) =>
    sub.setName("ping").setDescription("Simple health check (pong)")
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
  } else {
    await interaction.reply({
      content: `Subcommand "${subcommand}" is not implemented yet.`,
      ephemeral: true
    });
  }
}
