/**
 * Discord Activity OAuth2 token exchange (#127 Phase 2, ADR 0005).
 *
 * The browser Embedded App SDK runs `authorize` to obtain a short-lived authorization `code`, then
 * hands it to us. The browser must never hold the `client_secret`, so the exchange happens here:
 * the backend swaps the code for an access token against Discord's OAuth endpoint and returns only
 * the token; the client then calls `authenticate` with it.
 *
 * Everything is pure/injectable — `exchangeCodeForToken` takes the `fetch` implementation, so it
 * unit-tests with a stub and never opens a real socket in Vitest (the Node-24 native-teardown
 * lesson from #156). The `client_secret` is read from the environment only in the server shell.
 */

export const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';

/** Discord's "who is this token" endpoint — the `identify` scope's whole purpose. */
export const DISCORD_USER_URL = 'https://discord.com/api/users/@me';

export interface AccessToken {
  accessToken: string;
}

/** The slice of Discord's `/users/@me` the stage's authorization needs (#210). */
export interface DiscordUser {
  id: string;
  username?: string;
}

export interface TokenExchangeConfig {
  clientId: string;
  clientSecret: string;
  /** Injected so tests never hit the network; the server passes the global `fetch`. */
  fetchImpl: typeof fetch;
  /** Overridable for tests; defaults to Discord's real endpoint. */
  tokenUrl?: string;
}

/** Extract the OAuth `code` from a `POST /api/token` body. Pure and guarded against untrusted JSON. */
export function parseTokenRequest(body: string): { code: string } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(body || '{}');
  } catch {
    return { error: 'invalid JSON body' };
  }
  if (typeof data !== 'object' || data === null) {
    return { error: 'body must be { code }' };
  }
  const code = (data as Record<string, unknown>).code;
  if (typeof code !== 'string' || !code.trim()) {
    return { error: 'body must include a non-empty code' };
  }
  return { code: code.trim() };
}

/**
 * Exchange an OAuth authorization code for an access token. Throws on a non-OK response or a
 * response missing the token, so the caller can map either to a 502.
 */
export async function exchangeCodeForToken(
  code: string,
  config: TokenExchangeConfig,
): Promise<AccessToken> {
  const { clientId, clientSecret, fetchImpl, tokenUrl = DISCORD_TOKEN_URL } = config;
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
    }).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Discord token exchange failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const payload = (await res.json()) as { access_token?: unknown };
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('Discord token response had no access_token');
  }
  return { accessToken: payload.access_token };
}

/**
 * Pull the caller's Discord user id out of an `Authorization: Bearer …` header — the *only*
 * sanctioned way the backend learns who is calling (#210, ADR 0007). The Activity iframe is
 * public code, so a client-supplied `userId` field would be a self-service commissioner badge;
 * the id must always come from Discord's answer to a token we just presented.
 *
 * Injectable `fetchImpl` as everywhere else here, so this unit-tests without a socket.
 */
export async function fetchDiscordUser(
  accessToken: string,
  config: { fetchImpl: typeof fetch; userUrl?: string },
): Promise<DiscordUser> {
  const { fetchImpl, userUrl = DISCORD_USER_URL } = config;
  const res = await fetchImpl(userUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Discord identify failed (${res.status})`);
  }
  const payload = (await res.json()) as { id?: unknown; username?: unknown };
  if (typeof payload.id !== 'string' || !payload.id) {
    throw new Error('Discord identify response had no user id');
  }
  return {
    id: payload.id,
    ...(typeof payload.username === 'string' ? { username: payload.username } : {}),
  };
}

/**
 * Read the bearer token out of request headers. Case-insensitive on the scheme (Node lowercases
 * header *names* for us, but not values), and returns `undefined` for anything else — including
 * the duplicate-header array shape `node:http` produces, which is never legitimate here.
 */
export function parseBearerToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers.authorization;
  if (typeof raw !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match ? match[1] : undefined;
}
