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

export interface AccessToken {
  accessToken: string;
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
