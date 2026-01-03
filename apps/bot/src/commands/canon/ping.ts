import { ChatInputCommandInteraction } from "discord.js";

export async function handlePingSubcommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.reply({
    content: "Pong 🏈",
    ephemeral: true
  });
}
