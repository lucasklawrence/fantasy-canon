import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';

export async function handlePingSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    content: 'Pong 🏈',
    flags: MessageFlags.Ephemeral,
  });
}
