import {
  Client,
  GatewayIntentBits,
  Interaction,
  Partials
} from "discord.js";
import { BotContext } from "../config.js";
import { handleCanonInteraction } from "../commands/canon/index.js";

export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel]
  });
}

export function registerInteractionHandlers(client: Client, context: BotContext): void {
  client.on("interactionCreate", (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === "canon") {
      void (async () => {
        try {
          await handleCanonInteraction(interaction, context);
        } catch (error) {
          console.error("Failed to handle /canon interaction", error);
          if (interaction.isRepliable()) {
            const alreadyReplied = interaction.replied || interaction.deferred;
            const content =
              "Sorry, something went wrong handling that command. Please try again.";
            if (alreadyReplied) {
              await interaction.followUp({ content, ephemeral: true });
            } else {
              await interaction.reply({ content, ephemeral: true });
            }
          }
        }
      })();
    }
  });
}
