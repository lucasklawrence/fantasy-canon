import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';

export async function handleDeepSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    content: 'Fucking value',
    flags: MessageFlags.Ephemeral,
  });
}
