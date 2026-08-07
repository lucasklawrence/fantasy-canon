/**
 * The Discord Embedded App SDK handshake, shared by both Activity entries (the draft board and
 * the lottery machine, #169): `ready → authorize → server-side token exchange → authenticate`.
 * Browser-only glue over the unit-tested pure pieces (`transport.ts` client-side, `token.ts`
 * server-side); unvalidated until the Activity is registered in the portal (#168).
 */

import { DiscordSDK } from '@discord/embedded-app-sdk';
import { apiPath } from './transport.js';

declare global {
  interface Window {
    __DRAFT_CONFIG__?: { clientId?: string; maxTeamBalls?: number };
  }
}

/** The Discord application (client) id the server injected into the page (`''` in dev). */
export function configuredClientId(): string {
  return window.__DRAFT_CONFIG__?.clientId ?? '';
}

/**
 * The per-team ball cap, injected by the page shell from core's `MAX_TEAM_BALLS` (#219). The
 * bundle cannot import core (it reaches `node:crypto`), and a hand-copied literal would silently
 * drift from the value the server enforces — so the server states it and the client reads it.
 */
export function configuredMaxTeamBalls(): number {
  const value = window.__DRAFT_CONFIG__?.maxTeamBalls;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 30;
}

/**
 * Run the Discord OAuth handshake so the Activity is authenticated before it shows data, and
 * return the access token. The token is the client's proof of identity for the backend's own
 * authorized routes (#210): it goes back as `Authorization: Bearer …`, and the backend re-verifies
 * it with Discord rather than trusting anything the page says about who is using it.
 */
export async function runHandshake(
  base: string,
): Promise<{ accessToken: string; guildId?: string }> {
  const clientId = configuredClientId();
  const sdk = new DiscordSDK(clientId);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });
  const res = await fetch(apiPath(base, '/api/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const { access_token: accessToken } = (await res.json()) as { access_token: string };
  await sdk.commands.authenticate({ access_token: accessToken });
  // Which guild this Activity instance lives in (#253) — the setup doorbell names it, and the
  // bot then verifies the presser holds Manage Server THERE, so a forged value buys nothing.
  return { accessToken, ...(sdk.guildId ? { guildId: sdk.guildId } : {}) };
}
