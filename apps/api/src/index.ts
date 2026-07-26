/**
 * Draft dashboard backend (`pnpm -C apps/api run dev`).
 *
 * Serves the best-available draft board as a real-time web dashboard — the surface behind #127,
 * built to run as a Discord Activity (ADR 0005) with `apps/api` as the Activity's mapped backend +
 * static host. It loads an ADP-only pool, holds a live draft session, and pushes the same VBD
 * projection the Discord `/canon draft` commands use over a WebSocket as picks are entered.
 *
 * This scaffold runs in dev mode against a local browser (open the printed URL and enter picks). The
 * Discord Embedded App SDK handshake + proxy wiring + portal registration are the next phases,
 * enumerated in ADR 0005; none of them change this backend's shape.
 */

import 'dotenv/config';
import type { AdpProvenance, PlayerTier } from '@fantasy-canon/core';
import { createDraftHub } from './hub.js';
import { loadAdpPool } from './pool.js';
import { startApiServer } from './server.js';

/** Starting lineup + bench for our standing 12-team league (mirrors the bot's ROSTER_SLOTS). */
const ROSTER_SLOTS: Record<string, number> = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  K: 1,
  DST: 1,
  BENCH: 6,
};

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  const leagueSize = envInt('FANTASY_LEAGUE_SIZE', 12);
  const mySlot = envInt('FANTASY_MY_SLOT', 1);
  const port = envInt('FANTASY_API_PORT', 4610);

  console.log('Fantasy Canon — draft dashboard backend');
  console.log(`  league ${leagueSize} · your slot ${mySlot}`);

  let players: PlayerTier[] = [];
  let adp: AdpProvenance | undefined;
  try {
    const loaded = await loadAdpPool();
    players = loaded.players;
    adp = loaded.adp;
    console.log(`  pool: ${players.length} players${adp ? ` (ADP as of ${adp.asOf})` : ''}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  ⚠ ADP feed unavailable, starting with an empty pool: ${message}`);
  }

  const hub = createDraftHub({ leagueSize, mySlot, rosterSlots: ROSTER_SLOTS, pool: players, adp });
  // The Activity SDK needs the app (client) id in the browser; the token exchange needs the secret
  // server-side. Both are absent in plain dev — the board still runs, it just skips the SDK handshake.
  // FANTASY_STAGE_KEY guards the bot-paced lottery POSTs (#169); empty = open on the loopback bind.
  const server = await startApiServer(hub, {
    port,
    clientId: process.env.DISCORD_APP_ID ?? '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET ?? '',
    stageKey: process.env.FANTASY_STAGE_KEY ?? '',
  });

  console.log(`\n▶ Dashboard: ${server.url}`);
  console.log('  Enter picks in the page, or POST /api/pick { "playerName": "…" }.');
  console.log('  State pushes over the /api/ws WebSocket. Ctrl+C to stop.\n');

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
