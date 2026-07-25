/**
 * Browser entry for the draft dashboard (#127 Phase 2), bundled by esbuild to
 * `dist/client/activity.js` and loaded by the page shell in `board.ts`.
 *
 * Two modes, feature-detected: inside the Discord Activity iframe it runs the Embedded App SDK
 * handshake (ready → authorize → server-side token exchange via `POST /api/token` → authenticate)
 * and routes every call through the `/.proxy` prefix; standalone (dev / mock testing) it skips the
 * SDK and just drives the board with manual entry. Either way the transport + render come from the
 * same shared modules.
 *
 * The SDK handshake is the deliberately un-unit-tested shell (it can only run inside Discord, gated
 * on the manual portal work in #168 — same "thin shell, tested pure core" split as #156's CDP
 * reader). The pure pieces it leans on — `transport.ts`, the server's `token.ts`/`routes.ts` — are
 * unit-tested.
 */

import { DiscordSDK } from '@discord/embedded-app-sdk';
import { apiPath, isDiscordActivity, proxyBase, wsUrl } from './transport.js';
import { renderState, setStatus, wireControls, type BoardState } from './render.js';

declare global {
  interface Window {
    __DRAFT_CONFIG__?: { clientId?: string };
  }
}

function clientId(): string {
  return window.__DRAFT_CONFIG__?.clientId ?? '';
}

async function postJson(base: string, route: string, payload: unknown): Promise<void> {
  await fetch(apiPath(base, route), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Run the Discord OAuth handshake so the Activity is authenticated before it shows data. */
async function runHandshake(base: string): Promise<void> {
  const sdk = new DiscordSDK(clientId());
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: clientId(),
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
}

/** Poll `/api/state` once and paint it (used on connect and as the WS-drop fallback). */
function poll(base: string): void {
  fetch(apiPath(base, '/api/state'), { cache: 'no-store' })
    .then((r) => r.json())
    .then((state: BoardState) => renderState(state))
    .catch(() => setStatus('backend offline', 'err'));
}

/** Connect the state feed: WebSocket push with a polling fallback if the socket drops. */
function connect(base: string): void {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const startPolling = (): void => {
    if (!pollTimer) {
      poll(base);
      pollTimer = setInterval(() => poll(base), 2000);
    }
  };
  const stopPolling = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  poll(base); // paint immediately, don't wait for the first push
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl(window.location, base));
  } catch {
    startPolling();
    return;
  }
  ws.onopen = (): void => stopPolling();
  ws.onmessage = (ev: MessageEvent): void => {
    try {
      renderState(JSON.parse(String(ev.data)) as BoardState);
    } catch {
      /* ignore a malformed frame */
    }
  };
  ws.onclose = (): void => {
    startPolling();
    setTimeout(() => connect(base), 3000);
  };
  ws.onerror = (): void => {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  };
}

async function boot(): Promise<void> {
  const inDiscord = isDiscordActivity(window.location);
  const base = proxyBase(inDiscord);
  if (inDiscord) {
    try {
      await runHandshake(base);
    } catch (error) {
      setStatus('Discord auth failed', 'err');
      console.error('[activity] handshake failed', error);
      // Fall through: the board is read-mostly, so still show state even if auth didn't complete.
    }
  }
  const send = (route: string, payload: unknown): void => {
    postJson(base, route, payload)
      .then(() => poll(base))
      .catch(() => setStatus('could not reach the backend', 'err'));
  };
  wireControls({
    onPick: (name) => send('/api/pick', { playerName: name }),
    onReset: () => send('/api/reset', {}),
  });
  connect(base);
}

void boot();
