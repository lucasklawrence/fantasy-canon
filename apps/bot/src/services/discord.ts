import {
  Client,
  GatewayIntentBits,
  Interaction,
  InteractionReplyOptions,
  MessageFlags,
  Partials,
} from 'discord.js';
import { BotContext } from '../config.js';
import { handleCanonInteraction, handleCanonAutocomplete } from '../commands/canon/index.js';

export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  });
}

export function registerInteractionHandlers(client: Client, context: BotContext): void {
  client.on('interactionCreate', (interaction: Interaction) => {
    // Autocomplete must answer within 3s and cannot be deferred — handle it first
    // and keep the handler cache-only (no live ESPN fetch on the response path).
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'canon') {
        void (async () => {
          try {
            await handleCanonAutocomplete(interaction, context);
          } catch (error) {
            console.error('Failed to handle /canon autocomplete', error);
            try {
              if (!interaction.responded) {
                await interaction.respond([]);
              }
            } catch {
              // Nothing more we can do if the response window has closed.
            }
          }
        })();
      }
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === 'canon') {
      void (async () => {
        try {
          await handleCanonInteraction(interaction, context);
        } catch (error) {
          console.error('Failed to handle /canon interaction', error);
          if (interaction.isRepliable()) {
            const alreadyReplied = interaction.replied || interaction.deferred;
            const content = 'Sorry, something went wrong handling that command. Please try again.';
            const payload: InteractionReplyOptions = {
              content,
              flags: MessageFlags.Ephemeral,
            };
            if (alreadyReplied) {
              await interaction.followUp(payload);
            } else {
              await interaction.reply(payload);
            }
          }
        }
      })();
    }
  });
}
