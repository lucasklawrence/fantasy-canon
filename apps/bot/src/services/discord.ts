import {
  Client,
  GatewayIntentBits,
  Interaction,
  InteractionReplyOptions,
  MessageFlags,
  Partials,
} from 'discord.js';
import { BotContext } from '../config.js';
import {
  handleCanonInteraction,
  handleCanonAutocomplete,
  handleCanonComponent,
} from '../commands/canon/index.js';

export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  });
}

export function registerInteractionHandlers(client: Client, context: BotContext): void {
  client.on('interactionCreate', (interaction: Interaction) => {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'canon') {
        void handleCanonAutocomplete(interaction, context).catch((error) => {
          console.error('Failed to handle /canon autocomplete', error);
        });
      }
      return;
    }

    // Message components (buttons, select menus). Namespaced customIds let each command own its
    // slice; today the interactive draft grade is the only consumer.
    if (interaction.isMessageComponent()) {
      if (interaction.customId.startsWith('canon:')) {
        void handleCanonComponent(interaction).catch((error) => {
          console.error('Failed to handle /canon component interaction', error);
        });
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
