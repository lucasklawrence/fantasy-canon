import { createBotContext } from './config.js';
import { createDiscordClient, registerInteractionHandlers } from './services/discord.js';
import { startScheduledBroadcasts } from './services/scheduler.js';

async function start(): Promise<void> {
  const context = createBotContext();
  const client = createDiscordClient();

  client.once('clientReady', () => {
    console.log(`Fantasy Canon bot ready as ${client.user?.tag ?? 'unknown user'}`);
  });

  registerInteractionHandlers(client, context);

  await client.login(context.env.discordToken);

  // Hobby-scale scheduler: post weekly cards from this always-on process (see ADR 0002).
  // No-op unless BROADCAST_* env is set.
  startScheduledBroadcasts(context);
}

start().catch((error) => {
  console.error('Failed to start Fantasy Canon bot', error);
  process.exit(1);
});
