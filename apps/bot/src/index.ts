import { createBotContext } from "./config.js";
import {
  createDiscordClient,
  registerInteractionHandlers
} from "./services/discord.js";

async function start(): Promise<void> {
  const context = createBotContext();
  const client = createDiscordClient();

  client.once("ready", () => {
    console.log(`Fantasy Canon bot ready as ${client.user?.tag ?? "unknown user"}`);
  });

  registerInteractionHandlers(client, context);

  await client.login(context.env.discordToken);
}

start().catch((error) => {
  console.error("Failed to start Fantasy Canon bot", error);
  process.exit(1);
});
