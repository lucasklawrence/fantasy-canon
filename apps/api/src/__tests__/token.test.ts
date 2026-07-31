import { describe, expect, it, vi } from 'vitest';
import {
  exchangeCodeForToken,
  fetchDiscordUser,
  parseBearerToken,
  parseTokenRequest,
} from '../token.js';

/** A minimal `Response` stand-in — enough for the exchange, no real socket (the Node-24 lesson). */
function fakeResponse(init: {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: () => Promise.resolve(init.json),
    text: () => Promise.resolve(init.text ?? ''),
  } as unknown as Response;
}

describe('parseTokenRequest', () => {
  it('reads a non-empty code', () => {
    expect(parseTokenRequest(JSON.stringify({ code: '  abc  ' }))).toEqual({ code: 'abc' });
  });

  it('rejects invalid JSON, empty bodies, and a missing/blank code', () => {
    expect('error' in parseTokenRequest('{bad')).toBe(true);
    expect('error' in parseTokenRequest('{}')).toBe(true);
    expect('error' in parseTokenRequest(JSON.stringify({ code: '' }))).toBe(true);
    expect('error' in parseTokenRequest(JSON.stringify({ code: 123 }))).toBe(true);
  });
});

describe('exchangeCodeForToken', () => {
  it('posts the code + credentials as form-encoded and returns the access token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(fakeResponse({ ok: true, status: 200, json: { access_token: 'tok' } }));

    const res = await exchangeCodeForToken('code123', {
      clientId: 'app-id',
      clientSecret: 'sh',
      fetchImpl,
      tokenUrl: 'https://mock/token',
    });

    expect(res).toEqual({ accessToken: 'tok' });
    const [url, opts] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mock/token');
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = opts.body as string;
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=code123');
    expect(body).toContain('client_id=app-id');
    expect(body).toContain('client_secret=sh');
  });

  it('throws with the status on a non-OK response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(fakeResponse({ ok: false, status: 401, text: 'nope' }));
    await expect(
      exchangeCodeForToken('c', {
        clientId: 'a',
        clientSecret: 's',
        fetchImpl,
      }),
    ).rejects.toThrow('401');
  });

  it('throws when the response carries no access_token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 200, json: {} }));
    await expect(
      exchangeCodeForToken('c', {
        clientId: 'a',
        clientSecret: 's',
        fetchImpl,
      }),
    ).rejects.toThrow('no access_token');
  });
});

describe('fetchDiscordUser (#210)', () => {
  it('presents the token as a bearer and returns the id Discord answers with', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: true, status: 200, json: { id: '42', username: 'commish' } }),
      );

    const user = await fetchDiscordUser('tok', { fetchImpl, userUrl: 'https://mock/me' });

    expect(user).toEqual({ id: '42', username: 'commish' });
    const [url, opts] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mock/me');
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('throws on a rejected token or a response with no id — never a silent anonymous caller', async () => {
    const rejected = vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 401 }));
    await expect(fetchDiscordUser('tok', { fetchImpl: rejected })).rejects.toThrow('401');

    const idless = vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 200, json: {} }));
    await expect(fetchDiscordUser('tok', { fetchImpl: idless })).rejects.toThrow('no user id');
  });
});

describe('parseBearerToken (#210)', () => {
  it('reads the token, case-insensitively on the scheme', () => {
    expect(parseBearerToken({ authorization: 'Bearer abc' })).toBe('abc');
    expect(parseBearerToken({ authorization: '  bearer   abc  ' })).toBe('abc');
  });

  it('returns undefined for anything that is not a single bearer header', () => {
    expect(parseBearerToken({})).toBeUndefined();
    expect(parseBearerToken({ authorization: 'Basic abc' })).toBeUndefined();
    expect(parseBearerToken({ authorization: 'Bearer' })).toBeUndefined();
    expect(parseBearerToken({ authorization: 'Bearer a b' })).toBeUndefined();
    // node:http's duplicate-header array shape is never a legitimate credential here.
    expect(parseBearerToken({ authorization: ['Bearer a', 'Bearer b'] })).toBeUndefined();
  });
});
