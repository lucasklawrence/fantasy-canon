import { REST, Routes } from 'discord.js';
import type { RenderedBroadcast } from './broadcastRender.js';

/**
 * Post a rendered broadcast card to a Discord channel via REST (no gateway needed).
 * Shared by the one-shot CLI (broadcast.ts) and the in-process weekly scheduler.
 */
export async function postBroadcast(
  token: string,
  channelId: string,
  season: number,
  rendered: RenderedBroadcast,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.post(Routes.channelMessages(channelId), {
    body: { content: `${rendered.label} • Season ${season}` },
    files: [{ name: rendered.filename, data: rendered.buffer }],
  });
}
