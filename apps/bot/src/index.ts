import { recoverInterruptedCeremonies, watchActivityEdits } from './commands/canon/draftOrder.js';
import { createBotContext } from './config.js';
import { createDiscordClient, registerInteractionHandlers } from './services/discord.js';
import { startScheduledBroadcasts } from './services/scheduler.js';

async function start(): Promise<void> {
  const context = createBotContext();
  const client = createDiscordClient();

  client.once('clientReady', () => {
    console.log(`Fantasy Canon bot ready as ${client.user?.tag ?? 'unknown user'}`);
    // Disclose the seed for any lottery that committed but never finalized before a restart (#176).
    void recoverInterruptedCeremonies(client).catch((error) => {
      console.error('[draftorder] ceremony recovery failed:', error);
    });
    // Mirror in-Activity commissioner edits into the league's channel as they happen (#220).
    // Outbound socket with backoff; the ceremony never depends on it.
    watchActivityEdits(client);
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
