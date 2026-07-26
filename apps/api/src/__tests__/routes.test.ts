import type { PlayerTier } from '@fantasy-canon/core';
import { describe, expect, it } from 'vitest';
import { createDraftHub, type DraftHub } from '../hub.js';
import { createLotteryStage, type LotterySnapshot } from '../lotteryStage.js';
import {
  normalizePath,
  parsePickBody,
  routeRequest,
  type Envelope,
  type RouteDeps,
} from '../routes.js';

const POOL: PlayerTier[] = [
  { name: 'A', position: 'RB', adp: 1, source: 'test' },
  { name: 'B', position: 'WR', adp: 2, source: 'test' },
  { name: 'C', position: 'RB', adp: 3, source: 'test' },
];

/** Route deps backed by a real hub + stage, a fixed timestamp, and stub client/token wiring. */
function deps(h: DraftHub, over: Partial<RouteDeps> = {}): RouteDeps {
  return {
    getEnvelope: (): Envelope => ({ ...h.snapshot(), updatedAt: '2026-07-14T00:00:00.000Z' }),
    ingest: (picks) => h.ingest(picks),
    nextOverall: () => h.nextOverall(),
    reset: () => h.reset(),
    clientId: over.clientId ?? '',
    clientScript: over.clientScript ?? ((): string | undefined => 'export const bundled = 1;'),
    exchangeToken:
      over.exchangeToken ?? ((code: string) => Promise.resolve({ accessToken: `tok-${code}` })),
    lottery: over.lottery ?? createLotteryStage(),
    lotteryScript: over.lotteryScript ?? ((): string | undefined => 'export const machine = 1;'),
    stageKey: over.stageKey ?? '',
  };
}

const LOTTERY_START_BODY = JSON.stringify({
  title: 'Lottery',
  commitment: 'hash',
  teamCount: 2,
  totalBalls: 3,
  delayMs: 1000,
  rows: [
    { team: 'B', balls: 2, firstPct: 66.7, top3Pct: 100 },
    { team: 'A', balls: 1, firstPct: 33.3, top3Pct: 100 },
  ],
});

function hub(): DraftHub {
  return createDraftHub({
    leagueSize: 3,
    mySlot: 1,
    rosterSlots: { RB: 1, WR: 1, QB: 1 },
    pool: POOL,
  });
}

describe('normalizePath', () => {
  it('drops the query string', () => {
    expect(normalizePath('/api/state?t=1')).toBe('/api/state');
  });

  it('strips a single leading /.proxy segment (the Discord Activity prefix)', () => {
    expect(normalizePath('/.proxy/api/state')).toBe('/api/state');
    expect(normalizePath('/.proxy/client/activity.js?v=2')).toBe('/client/activity.js');
    expect(normalizePath('/.proxy')).toBe('/');
    expect(normalizePath('/.proxy/')).toBe('/');
  });

  it('leaves an un-prefixed path untouched', () => {
    expect(normalizePath('/api/pick')).toBe('/api/pick');
  });
});

describe('routeRequest', () => {
  it('serves the dashboard shell with the injected client id and bundle script at /', async () => {
    const reply = await routeRequest('GET', '/', '', deps(hub(), { clientId: 'app-42' }));
    expect(reply.status).toBe(200);
    expect(reply.contentType).toContain('text/html');
    expect(reply.body).toContain('Draft Dashboard');
    expect(reply.body).toContain('clientId: "app-42"');
    expect(reply.body).toContain('src="./client/activity.js"');
  });

  it('serves the built client bundle, and 503s when it has not been built', async () => {
    const built = await routeRequest('GET', '/client/activity.js', '', deps(hub()));
    expect(built.status).toBe(200);
    expect(built.contentType).toContain('javascript');
    expect(built.body).toContain('bundled');

    const missing = await routeRequest(
      'GET',
      '/client/activity.js',
      '',
      deps(hub(), { clientScript: () => undefined }),
    );
    expect(missing.status).toBe(503);
    expect(missing.body).toContain('build:client');
  });

  it('serves the current envelope as JSON at /api/state — and under the /.proxy prefix', async () => {
    const d = deps(hub());
    for (const url of ['/api/state?t=1', '/.proxy/api/state']) {
      const reply = await routeRequest('GET', url, '', d);
      expect(reply.status).toBe(200);
      const env = JSON.parse(reply.body) as Envelope;
      expect(env.status).toBe('waiting for the first pick');
      expect(env.updatedAt).toBe('2026-07-14T00:00:00.000Z');
      expect(env.view.poolSize).toBe(3);
    }
  });

  it('ingests a single { playerName } pick and reflects it in state', async () => {
    const h = hub();
    const d = deps(h);
    const post = await routeRequest('POST', '/api/pick', JSON.stringify({ playerName: 'A' }), d);
    expect(post.status).toBe(200);
    expect(JSON.parse(post.body)).toEqual({ added: 1, picks: 1 });

    const state = JSON.parse((await routeRequest('GET', '/api/state', '', d)).body) as Envelope;
    expect(state.view.remaining).toBe(2); // A off the board
    expect(state.view.recentPicks[0]?.name).toBe('A');
  });

  it('ingests an explicit { picks: [...] } board idempotently', async () => {
    const h = hub();
    const d = deps(h);
    const body = JSON.stringify({
      picks: [
        { overall: 1, playerName: 'A' },
        { overall: 2, playerName: 'B' },
      ],
    });
    expect(JSON.parse((await routeRequest('POST', '/api/pick', body, d)).body)).toEqual({
      added: 2,
      picks: 2,
    });
    // Re-POST the same board → nothing new.
    expect(JSON.parse((await routeRequest('POST', '/api/pick', body, d)).body)).toEqual({
      added: 0,
      picks: 2,
    });
  });

  it('400s on invalid JSON and on a body with no usable pick', async () => {
    const d = deps(hub());
    expect((await routeRequest('POST', '/api/pick', '{not json', d)).status).toBe(400);
    expect((await routeRequest('POST', '/api/pick', JSON.stringify({ foo: 1 }), d)).status).toBe(
      400,
    );
  });

  it('resets the board', async () => {
    const h = hub();
    const d = deps(h);
    await routeRequest('POST', '/api/pick', JSON.stringify({ playerName: 'A' }), d);
    expect((await routeRequest('POST', '/api/reset', '', d)).status).toBe(200);
    const state = JSON.parse((await routeRequest('GET', '/api/state', '', d)).body) as Envelope;
    expect(state.view.remaining).toBe(3); // whole pool back
  });

  it('exchanges an OAuth code for an access token at /api/token', async () => {
    const reply = await routeRequest(
      'POST',
      '/api/token',
      JSON.stringify({ code: 'xyz' }),
      deps(hub()),
    );
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ access_token: 'tok-xyz' });
  });

  it('400s a token request with no code, and 502s when the exchange fails', async () => {
    const bad = await routeRequest('POST', '/api/token', JSON.stringify({}), deps(hub()));
    expect(bad.status).toBe(400);

    const failing = deps(hub(), { exchangeToken: () => Promise.reject(new Error('discord down')) });
    const reply = await routeRequest('POST', '/api/token', JSON.stringify({ code: 'x' }), failing);
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body)).toEqual({ error: 'discord down' });
  });

  it('404s an unknown route', async () => {
    expect((await routeRequest('GET', '/nope', '', deps(hub()))).status).toBe(404);
  });
});

describe('lottery routes (#169)', () => {
  it('serves the lottery shell and its bundle (503 when unbuilt)', async () => {
    const d = deps(hub(), { clientId: 'app-9' });
    const page = await routeRequest('GET', '/lottery', '', d);
    expect(page.status).toBe(200);
    expect(page.body).toContain('The Lottery Machine');
    expect(page.body).toContain('clientId: "app-9"');
    expect(page.body).toContain('src="./client/lottery.js"');

    const js = await routeRequest('GET', '/client/lottery.js', '', d);
    expect(js.status).toBe(200);
    expect(js.body).toContain('machine');

    const missing = await routeRequest(
      'GET',
      '/client/lottery.js',
      '',
      deps(hub(), { lotteryScript: () => undefined }),
    );
    expect(missing.status).toBe(503);
  });

  it('drives the stage through start → beat → reveal → finish, visible in /api/lottery/state', async () => {
    const d = deps(hub());
    expect((await routeRequest('POST', '/api/lottery/start', LOTTERY_START_BODY, d)).status).toBe(
      200,
    );
    await routeRequest(
      'POST',
      '/api/lottery/beat',
      JSON.stringify({ pick: 2, remaining: ['A', 'B'] }),
      d,
    );
    await routeRequest(
      'POST',
      '/api/lottery/reveal',
      JSON.stringify({ pick: 2, team: 'A', balls: 1, oddsPct: 33.3, remaining: ['B'] }),
      d,
    );

    const state = JSON.parse(
      (await routeRequest('GET', '/api/lottery/state', '', d)).body,
    ) as LotterySnapshot;
    expect(state.phase).toBe('revealing');
    expect(state.start?.title).toBe('Lottery');
    expect(state.reveals.map((r) => r.team)).toEqual(['A']);
  });

  it('routes work under the /.proxy prefix and 400 on bad payloads', async () => {
    const d = deps(hub());
    expect(
      (await routeRequest('POST', '/.proxy/api/lottery/start', LOTTERY_START_BODY, d)).status,
    ).toBe(200);
    expect((await routeRequest('POST', '/api/lottery/beat', '{bad', d)).status).toBe(400);
    expect((await routeRequest('POST', '/api/lottery/finish', '{}', d)).status).toBe(400);
  });

  it('requires x-stage-key on POSTs when configured — state stays public', async () => {
    const d = deps(hub(), { stageKey: 'sekrit' });
    const denied = await routeRequest('POST', '/api/lottery/start', LOTTERY_START_BODY, d);
    expect(denied.status).toBe(401);
    const wrong = await routeRequest('POST', '/api/lottery/start', LOTTERY_START_BODY, d, {
      'x-stage-key': 'nope',
    });
    expect(wrong.status).toBe(401);
    const ok = await routeRequest('POST', '/api/lottery/start', LOTTERY_START_BODY, d, {
      'x-stage-key': 'sekrit',
    });
    expect(ok.status).toBe(200);
    expect((await routeRequest('GET', '/api/lottery/state', '', d)).status).toBe(200);
  });
});

describe('parsePickBody', () => {
  it('assigns the next overall to a bare { playerName }', () => {
    const parsed = parsePickBody(JSON.stringify({ playerName: '  Bijan  ' }), () => 5);
    expect(parsed).toEqual({ picks: [{ overall: 5, teamId: 0, playerName: 'Bijan' }] });
  });

  it('reads an explicit board with overalls and team ids', () => {
    const parsed = parsePickBody(
      JSON.stringify({ picks: [{ overall: 1, playerName: 'A', teamId: 4 }] }),
      () => 1,
    );
    expect(parsed).toEqual({ picks: [{ overall: 1, teamId: 4, playerName: 'A' }] });
  });

  it('rejects invalid JSON, empty bodies, and picks missing a name or overall', () => {
    expect('error' in parsePickBody('{bad', () => 1)).toBe(true);
    expect('error' in parsePickBody('{}', () => 1)).toBe(true);
    expect('error' in parsePickBody(JSON.stringify({ picks: [{ overall: 1 }] }), () => 1)).toBe(
      true,
    );
    expect(
      'error' in parsePickBody(JSON.stringify({ picks: [{ playerName: 'A' }] }), () => 1),
    ).toBe(true);
  });

  it('rejects non-integer / non-positive overalls in an explicit board', () => {
    for (const overall of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const body = JSON.stringify({ picks: [{ overall, playerName: 'A' }] });
      expect('error' in parsePickBody(body, () => 1)).toBe(true);
    }
  });

  it('rejects an explicit non-integer / non-positive overall on a single pick', () => {
    for (const overall of [0, -3, 2.5]) {
      const body = JSON.stringify({ playerName: 'A', overall });
      expect('error' in parsePickBody(body, () => 1)).toBe(true);
    }
    // A bare { playerName } with no overall still takes the next slot.
    expect(parsePickBody(JSON.stringify({ playerName: 'A' }), () => 7)).toEqual({
      picks: [{ overall: 7, teamId: 0, playerName: 'A' }],
    });
  });
});
