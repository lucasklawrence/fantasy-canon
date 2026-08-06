import { describe, expect, it } from 'vitest';
import { fetchLogoForPush, isEspnHost, pushTeamLogos, LOGO_MAX_BYTES } from '../logoPush.js';
import type { InspectableRevealStage } from '../lotteryStageClient.js';

/** A fetch double that records what was asked and answers with a canned streaming response. */
function fakeFetch(
  responses: Record<
    string,
    {
      status?: number;
      contentType?: string;
      body?: Buffer;
      contentLength?: string;
      /** Simulates a redirect chain: what `res.url` reports the response actually came from. */
      finalUrl?: string;
    }
  >,
) {
  const calls: { url: string; cookie: string | undefined }[] = [];
  const impl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, cookie: headers.Cookie });
    const spec = responses[url] ?? { status: 404 };
    const body = spec.body ?? Buffer.alloc(0);
    let sent = false;
    return Promise.resolve({
      ok: (spec.status ?? 200) < 300,
      status: spec.status ?? 200,
      url: spec.finalUrl ?? url,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type'
            ? (spec.contentType ?? null)
            : name.toLowerCase() === 'content-length'
              ? (spec.contentLength ?? null)
              : null,
      },
      body: {
        getReader: () => ({
          read: () => {
            if (!sent && body.byteLength > 0) {
              sent = true;
              return Promise.resolve({ done: false, value: new Uint8Array(body) });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
          cancel: () => Promise.resolve(),
        }),
      },
    } as unknown as Response);
  }) as typeof fetch;
  return { impl, calls };
}

const COOKIES = { espnS2: 's2-secret', espnSwid: '{swid}' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('isEspnHost (#249)', () => {
  it('matches espn.com and subdomains only — cookie-luring lookalikes stay cold', () => {
    expect(isEspnHost('mystique-api.fantasy.espn.com')).toBe(true);
    expect(isEspnHost('espn.com')).toBe(true);
    expect(isEspnHost('i.imgur.com')).toBe(false);
    expect(isEspnHost('g.espncdn.com')).toBe(false); // the CDN is public — no cookies needed
    expect(isEspnHost('espn.com.attacker.net')).toBe(false);
    expect(isEspnHost('notespn.com')).toBe(false);
  });
});

describe('fetchLogoForPush (#249)', () => {
  it('sends the league cookies to ESPN hosts and never anywhere else', async () => {
    const { impl, calls } = fakeFetch({
      'https://mystique-api.fantasy.espn.com/img/1': { contentType: 'image/jpeg', body: PNG },
      'https://i.imgur.com/x.jpg': { contentType: 'image/jpeg', body: PNG },
    });
    await fetchLogoForPush('https://mystique-api.fantasy.espn.com/img/1', COOKIES, {
      fetchImpl: impl,
    });
    await fetchLogoForPush('https://i.imgur.com/x.jpg', COOKIES, { fetchImpl: impl });

    expect(calls[0].cookie).toBe('espn_s2=s2-secret; SWID={swid}');
    expect(calls[1].cookie).toBeUndefined();
  });

  it('flattens SVG to PNG via the injected rasterizer, passes raster through untouched', async () => {
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
    const { impl } = fakeFetch({
      'https://g.espncdn.com/logo.svg': { contentType: 'image/svg+xml', body: svgBytes },
      'https://i.imgur.com/x.jpg': { contentType: 'image/jpeg', body: PNG },
    });
    const rasterized = Buffer.from([1, 1, 1]);
    const svg = await fetchLogoForPush(
      'https://g.espncdn.com/logo.svg',
      {},
      {
        fetchImpl: impl,
        rasterize: () => rasterized,
      },
    );
    expect(svg).toEqual({ contentType: 'image/png', body: rasterized });

    const jpg = await fetchLogoForPush('https://i.imgur.com/x.jpg', {}, { fetchImpl: impl });
    expect(jpg?.contentType).toBe('image/jpeg');
    expect(jpg?.body.equals(PNG)).toBe(true);
  });

  it('returns null for errors, non-images, oversize bodies, junk URLs, and unparseable SVG', async () => {
    const { impl } = fakeFetch({
      'https://a.example/401': { status: 401 },
      'https://a.example/html': { contentType: 'text/html', body: PNG },
      'https://a.example/big': {
        contentType: 'image/png',
        body: Buffer.alloc(LOGO_MAX_BYTES + 1),
      },
      'https://a.example/badsvg': {
        contentType: 'image/svg+xml',
        body: Buffer.from('not svg'),
      },
    });
    const deps = { fetchImpl: impl, rasterize: () => null };
    expect(await fetchLogoForPush('https://a.example/401', {}, deps)).toBeNull();
    expect(await fetchLogoForPush('https://a.example/html', {}, deps)).toBeNull();
    expect(await fetchLogoForPush('https://a.example/big', {}, deps)).toBeNull();
    expect(await fetchLogoForPush('https://a.example/badsvg', {}, deps)).toBeNull();
    expect(await fetchLogoForPush('javascript:alert(1)', {}, deps)).toBeNull();
    expect(await fetchLogoForPush('not a url', {}, deps)).toBeNull();
  });

  it('never fetches private targets — directly or via a redirect chain', async () => {
    const { impl, calls } = fakeFetch({
      'https://ok.example/a.png': {
        contentType: 'image/png',
        body: PNG,
        // A public URL whose redirect chain lands on the operator's LAN.
        finalUrl: 'http://192.168.1.10/steal',
      },
    });
    const deps = { fetchImpl: impl };
    for (const target of [
      'http://127.0.0.1:4610/api/lottery/state',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost/x.png',
      'http://10.0.0.5/x.png',
    ]) {
      expect(await fetchLogoForPush(target, {}, deps)).toBeNull();
    }
    // Nothing above ever reached fetch; the redirect case fetches once, then refuses the body.
    expect(calls).toHaveLength(0);
    expect(await fetchLogoForPush('https://ok.example/a.png', {}, deps)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('withholds cookies on plaintext http, even for a real ESPN host', async () => {
    const { impl, calls } = fakeFetch({
      'http://fan.espn.com/logo.jpg': { contentType: 'image/jpeg', body: PNG },
    });
    const result = await fetchLogoForPush('http://fan.espn.com/logo.jpg', COOKIES, {
      fetchImpl: impl,
    });
    // The fetch itself proceeds (public bytes are fine) — but the session never rides plaintext.
    expect(result?.contentType).toBe('image/jpeg');
    expect(calls[0].cookie).toBeUndefined();
  });
});

describe('pushTeamLogos (#249)', () => {
  const stageWith = (pushes: unknown[]): InspectableRevealStage => ({
    state: () => Promise.resolve({ phase: 'idle' }),
    lobby: () => Promise.resolve(),
    logo: (entry: unknown) => {
      pushes.push(entry);
      return Promise.resolve();
    },
    clear: () => Promise.resolve(),
    start: () => Promise.resolve(),
    beat: () => Promise.resolve(),
    reveal: () => Promise.resolve(),
    finish: () => Promise.resolve(),
    abort: () => Promise.resolve(),
  });

  it('pushes what it can fetch, skips what it cannot, and reports the landed count', async () => {
    const { impl } = fakeFetch({
      'https://i.imgur.com/a.jpg': { contentType: 'image/jpeg', body: PNG },
      'https://dead.example/x.jpg': { status: 404 },
    });
    const pushes: { teamId?: string; url?: string; contentType?: string; data?: string }[] = [];
    const count = await pushTeamLogos(
      stageWith(pushes),
      new Map([
        ['1', 'https://i.imgur.com/a.jpg'],
        ['2', 'https://dead.example/x.jpg'],
      ]),
      {},
      { fetchImpl: impl },
    );
    expect(count).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].teamId).toBe('1');
    expect(pushes[0].url).toBe('https://i.imgur.com/a.jpg');
    expect(Buffer.from(pushes[0].data ?? '', 'base64').equals(PNG)).toBe(true);
  });

  it('is a quiet no-op against a stage without the logo method', async () => {
    const bare = { state: () => Promise.resolve({ phase: 'idle' }) } as InspectableRevealStage;
    const count = await pushTeamLogos(bare, new Map([['1', 'https://i.imgur.com/a.jpg']]), {});
    expect(count).toBe(0);
  });
});
