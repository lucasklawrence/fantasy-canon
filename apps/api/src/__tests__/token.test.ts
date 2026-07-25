import { describe, expect, it, vi } from 'vitest';
import { exchangeCodeForToken, parseTokenRequest } from '../token.js';

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
