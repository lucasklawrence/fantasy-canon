import { describe, expect, it } from 'vitest';
import {
  fetchLogoForPush,
  isEspnHost,
  prefetchLogoBytes,
  pushTeamLogos,
  LOGO_MAX_BYTES,
} from '../logoPush.js';
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
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

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
      'https://i.imgur.com/y.jpg': { contentType: 'image/jpeg', body: JPEG },
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

    const jpg = await fetchLogoForPush('https://i.imgur.com/y.jpg', {}, { fetchImpl: impl });
    expect(jpg?.contentType).toBe('image/jpeg');
    expect(jpg?.body.equals(JPEG)).toBe(true);
  });

  it('derives the content type from magic bytes, never the remote header (#254)', async () => {
    const { impl } = fakeFetch({
      // A hostile header on real PNG bytes: the header must never reach a data: URI.
      'https://evil.example/inject.png': {
        contentType: 'image/png"/><rect width="1080" height="1080"/><a href="',
        body: PNG,
      },
      // A truthful-looking header on bytes that are not an image at all.
      'https://evil.example/fake.png': {
        contentType: 'image/png',
        body: Buffer.from('<html>hotlink denied</html>', 'utf8'),
      },
      // A raster format resvg cannot decode inside <image>: dropped, not an empty ring.
      'https://a.example/favicon.ico': {
        contentType: 'image/x-icon',
        body: Buffer.from([0x00, 0x00, 0x01, 0x00, 1, 2]),
      },
    });
    const inject = await fetchLogoForPush(
      'https://evil.example/inject.png',
      {},
      { fetchImpl: impl },
    );
    expect(inject?.contentType).toBe('image/png');
    expect(
      await fetchLogoForPush('https://evil.example/fake.png', {}, { fetchImpl: impl }),
    ).toBeNull();
    expect(
      await fetchLogoForPush('https://a.example/favicon.ico', {}, { fetchImpl: impl }),
    ).toBeNull();
  });

  it('keeps WebP for the stage and lets the bytes decide regardless of the header', async () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([16, 0, 0, 0]),
      Buffer.from('WEBP', 'latin1'),
      Buffer.from([1, 2, 3]),
    ]);
    const { impl } = fakeFetch({
      // WebP displayed on the Activity before #254's sniffing — it must keep working (#249).
      'https://i.imgur.com/a.webp': { contentType: 'image/webp', body: webp },
      // Real images behind the generic headers CDNs actually use: all accepted by bytes.
      'https://cdn.example/raw': { contentType: 'application/octet-stream', body: PNG },
      'https://cdn.example/s3': { contentType: 'binary/octet-stream', body: PNG },
      'https://cdn.example/plain': { contentType: 'text/plain', body: JPEG },
      'https://cdn.example/bare': { body: JPEG },
      // An SVG behind a generic header still reaches the rasterizer — byte-sniffed too.
      'https://cdn.example/logo': {
        contentType: 'application/octet-stream',
        body: Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8'),
      },
    });
    const kept = await fetchLogoForPush('https://i.imgur.com/a.webp', {}, { fetchImpl: impl });
    expect(kept?.contentType).toBe('image/webp');
    for (const [url, type] of [
      ['https://cdn.example/raw', 'image/png'],
      ['https://cdn.example/s3', 'image/png'],
      ['https://cdn.example/plain', 'image/jpeg'],
      ['https://cdn.example/bare', 'image/jpeg'],
    ] as const) {
      const got = await fetchLogoForPush(url, {}, { fetchImpl: impl });
      expect(got?.contentType).toBe(type);
    }
    const rasterized = Buffer.from([7, 7, 7]);
    const svg = await fetchLogoForPush(
      'https://cdn.example/logo',
      {},
      { fetchImpl: impl, rasterize: () => rasterized },
    );
    expect(svg).toEqual({ contentType: 'image/png', body: rasterized });
  });

  it('returns null for errors, non-images, oversize bodies, junk URLs, and unparseable SVG', async () => {
    const { impl } = fakeFetch({
      'https://a.example/401': { status: 401 },
      'https://a.example/html': {
        contentType: 'text/html',
        body: Buffer.from('<html>not an image</html>', 'utf8'),
      },
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
      'http://[::1]/x.png', // URL keeps the brackets — the guard must strip them
      'http://[fe80::1]/x.png',
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
    expect(result?.contentType).toBe('image/png');
    expect(calls[0].cookie).toBeUndefined();
  });
});

describe('prefetchLogoBytes (#254)', () => {
  it('fills the map with base64 bytes for what it can fetch, skips the rest', async () => {
    const { impl } = fakeFetch({
      'https://i.imgur.com/a.jpg': { contentType: 'image/jpeg', body: PNG },
      'https://dead.example/x.jpg': { status: 404 },
    });
    const bytes = await prefetchLogoBytes(
      new Map([
        ['1', 'https://i.imgur.com/a.jpg'],
        ['2', 'https://dead.example/x.jpg'],
      ]),
      {},
      { fetchImpl: impl },
    );
    expect(bytes.size).toBe(1);
    expect(bytes.get('1')?.contentType).toBe('image/png');
    expect(Buffer.from(bytes.get('1')?.data ?? '', 'base64').equals(PNG)).toBe(true);
  });

  it('returns at the soft deadline with what has landed — and keeps filling afterwards', async () => {
    let releaseSlow: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const { impl } = fakeFetch({
      'https://fast.example/a.jpg': { contentType: 'image/jpeg', body: PNG },
      'https://slow.example/b.jpg': { contentType: 'image/jpeg', body: PNG },
    });
    const gated: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('slow.example')) await slow;
      return impl(input, init);
    };

    const bytes = await prefetchLogoBytes(
      new Map([
        ['fast', 'https://fast.example/a.jpg'],
        ['slow', 'https://slow.example/b.jpg'],
      ]),
      {},
      { fetchImpl: gated },
      10,
    );
    // The cap fired: the fast one is in, the slow one is not — the caller renders with what it has.
    expect(bytes.has('fast')).toBe(true);
    expect(bytes.has('slow')).toBe(false);

    // The straggler lands in the SAME map once its fetch settles — later readers see more.
    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bytes.has('slow')).toBe(true);
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

  it('serves from the prefetch cache first and never refetches what it holds (#254)', async () => {
    const { impl, calls } = fakeFetch({
      'https://i.imgur.com/b.jpg': { contentType: 'image/jpeg', body: PNG },
    });
    const pushes: { teamId?: string; contentType?: string; data?: string }[] = [];
    const cachedData = PNG.toString('base64');
    const count = await pushTeamLogos(
      stageWith(pushes),
      new Map([
        ['1', 'https://i.imgur.com/a.jpg'], // in the cache — must not be fetched
        ['2', 'https://i.imgur.com/b.jpg'], // not in the cache — falls back to a live fetch
      ]),
      {},
      { fetchImpl: impl },
      new Map([['1', { contentType: 'image/png', data: cachedData }]]),
    );
    expect(count).toBe(2);
    expect(calls.map((c) => c.url)).toEqual(['https://i.imgur.com/b.jpg']);
    expect(pushes.find((p) => p.teamId === '1')?.contentType).toBe('image/png');
    expect(pushes.find((p) => p.teamId === '1')?.data).toBe(cachedData);
    expect(pushes.find((p) => p.teamId === '2')?.contentType).toBe('image/png');
  });

  it('waits out an in-flight prefetch straggler instead of double-fetching it (#254)', async () => {
    let releaseSlow: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const { impl, calls } = fakeFetch({
      'https://slow.example/b.jpg': { contentType: 'image/jpeg', body: JPEG },
    });
    const gated: typeof fetch = async (input, init) => {
      await slow;
      return impl(input, init);
    };
    const logos = new Map([['slow', 'https://slow.example/b.jpg']]);
    const bytes = await prefetchLogoBytes(logos, {}, { fetchImpl: gated }, 10);
    expect(bytes.size).toBe(0); // the cap fired; the straggler is still in flight

    const pushes: { teamId?: string; data?: string }[] = [];
    const pushing = pushTeamLogos(stageWith(pushes), logos, {}, { fetchImpl: gated }, bytes);
    releaseSlow();
    const count = await pushing;
    // One fetch total: the prefetch's own. The push waited for it and served from the map.
    expect(count).toBe(1);
    expect(calls).toHaveLength(1);
    expect(Buffer.from(pushes[0]?.data ?? '', 'base64').equals(JPEG)).toBe(true);
  });

  it('writes a successful fallback fetch back into the cache, so cards catch up (#254)', async () => {
    const { impl } = fakeFetch({
      'https://i.imgur.com/late.jpg': { contentType: 'image/jpeg', body: JPEG },
    });
    const pushes: unknown[] = [];
    // A prefetch cache that missed this team entirely (its host timed out at setup).
    const bytes = new Map<string, { contentType: string; data: string }>();
    const count = await pushTeamLogos(
      stageWith(pushes),
      new Map([['9', 'https://i.imgur.com/late.jpg']]),
      {},
      { fetchImpl: impl },
      bytes,
    );
    expect(count).toBe(1);
    // The bytes now live in the SAME map the session holds — the finish board will wear them.
    expect(bytes.get('9')?.contentType).toBe('image/jpeg');
    expect(Buffer.from(bytes.get('9')?.data ?? '', 'base64').equals(JPEG)).toBe(true);
  });

  it('is a quiet no-op against a stage without the logo method', async () => {
    const bare = { state: () => Promise.resolve({ phase: 'idle' }) } as InspectableRevealStage;
    const count = await pushTeamLogos(bare, new Map([['1', 'https://i.imgur.com/a.jpg']]), {});
    expect(count).toBe(0);
  });
});
