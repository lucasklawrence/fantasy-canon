import type { PlayerTier } from '@fantasy-canon/core';
import { describe, expect, it, vi } from 'vitest';
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
    clientLog: over.clientLog,
    clientScript: over.clientScript ?? ((): string | undefined => 'export const bundled = 1;'),
    exchangeToken:
      over.exchangeToken ?? ((code: string) => Promise.resolve({ accessToken: `tok-${code}` })),
    // Stub identity: a token is "valid" iff it looks like `user-<id>`, so a test can present an
    // arbitrary caller without a socket, and an unknown token exercises the rejection path.
    identify:
      over.identify ??
      ((token: string) =>
        token.startsWith('user-')
          ? Promise.resolve({ id: token.slice('user-'.length) })
          : Promise.reject(new Error('bad token'))),
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

const LOTTERY_LOBBY_BODY = JSON.stringify({
  title: 'Lottery',
  teamCount: 2,
  totalBalls: 3,
  guildId: 'g-a',
  rows: [
    { team: 'B', balls: 2, firstPct: 66.7, top3Pct: 100 },
    { team: 'A', balls: 1, firstPct: 33.3, top3Pct: 100 },
  ],
});

/** An editable lobby (#210): team ids on every row plus the setup runner as commissioner. */
const EDITABLE_LOBBY_BODY = JSON.stringify({
  title: 'Lottery',
  teamCount: 2,
  totalBalls: 3,
  guildId: 'g-a',
  commissionerIds: ['commish'],
  rows: [
    { teamId: 't-b', team: 'B', balls: 2, firstPct: 66.7, top3Pct: 100 },
    { teamId: 't-a', team: 'A', balls: 1, firstPct: 33.3, top3Pct: 100 },
  ],
});

const asCommissioner = { authorization: 'Bearer user-commish' };

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

  it('mode-switches / to the lottery machine while a stage is live (the Activity opens at root)', async () => {
    const d = deps(hub());
    // Idle stage → the draft dashboard.
    expect((await routeRequest('GET', '/', '', d)).body).toContain('Draft Dashboard');

    await routeRequest('POST', '/api/lottery/start', LOTTERY_START_BODY, d);
    for (const url of ['/', '/.proxy/']) {
      const live = await routeRequest('GET', url, '', d);
      expect(live.body).toContain('The Lottery Machine');
      expect(live.body).toContain('src="./client/lottery.js"');
    }
    // A finished run keeps serving the machine (late clickers get the finale + verify panel)…
    await routeRequest(
      'POST',
      '/api/lottery/finish',
      JSON.stringify({
        order: [{ pick: 1, team: 'B' }],
        verify: { secretSeed: 's', salt: 'm', drawSeed: 's|m', commitment: 'h' },
      }),
      d,
    );
    expect((await routeRequest('GET', '/', '', d)).body).toContain('The Lottery Machine');
    // …and /lottery always reaches the machine directly, while a fresh (idle) deps set serves
    // the dashboard at root again — the in-memory stage resets with the process.
    expect((await routeRequest('GET', '/lottery', '', d)).body).toContain('The Lottery Machine');
    expect((await routeRequest('GET', '/', '', deps(hub()))).body).toContain('Draft Dashboard');
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

  it("409s a second guild's start while another guild's run is live", async () => {
    const d = deps(hub());
    const forGuild = (guildId: string): string =>
      JSON.stringify({ ...(JSON.parse(LOTTERY_START_BODY) as object), guildId });
    expect((await routeRequest('POST', '/api/lottery/start', forGuild('g-a'), d)).status).toBe(200);
    await routeRequest(
      'POST',
      '/api/lottery/beat',
      JSON.stringify({ pick: 2, remaining: ['A', 'B'] }),
      d,
    );
    const busy = await routeRequest('POST', '/api/lottery/start', forGuild('g-b'), d);
    expect(busy.status).toBe(409);
    expect(busy.body).toContain('another live ceremony');
  });

  it('arms and disarms the lobby, and the lobby phase owns the Activity root (#198)', async () => {
    const d = deps(hub());
    // An armed lobby must win the root: inside Discord the Activity can only open at `/`, so this
    // is what makes joining before `begin` work at all.
    expect((await routeRequest('GET', '/', '', d)).body).toContain('Draft Dashboard');
    expect((await routeRequest('POST', '/api/lottery/lobby', LOTTERY_LOBBY_BODY, d)).status).toBe(
      200,
    );
    expect((await routeRequest('GET', '/', '', d)).body).toContain('The Lottery Machine');
    expect((await routeRequest('GET', '/api/lottery/state', '', d)).body).toContain('"lobby"');

    // Disarming hands the root back to the draft dashboard — without this a stale lobby would
    // shadow it until the api restarted.
    const cleared = await routeRequest(
      'POST',
      '/api/lottery/clear',
      JSON.stringify({ guildId: 'g-a' }),
      d,
    );
    expect(cleared.status).toBe(200);
    expect((await routeRequest('GET', '/', '', d)).body).toContain('Draft Dashboard');
  });

  it('409s a lobby armed over a committed run, and 400s a bad lobby payload', async () => {
    const d = deps(hub());
    await routeRequest('POST', '/api/lottery/start', LOTTERY_START_BODY, d);
    const busy = await routeRequest('POST', '/api/lottery/lobby', LOTTERY_LOBBY_BODY, d);
    expect(busy.status).toBe(409);
    expect(busy.body).toContain('another live ceremony');
    // The committed run survived the rejected lobby.
    expect((await routeRequest('GET', '/api/lottery/state', '', d)).body).toContain('hash');

    expect((await routeRequest('POST', '/api/lottery/lobby', '{bad', d)).status).toBe(400);
    expect((await routeRequest('POST', '/api/lottery/lobby', '{}', d)).status).toBe(400);
    expect((await routeRequest('POST', '/api/lottery/clear', '{bad', d)).status).toBe(400);
  });

  it('requires x-stage-key on the new lobby and clear POSTs too', async () => {
    const d = deps(hub(), { stageKey: 'sekrit' });
    for (const [route, body] of [
      ['/api/lottery/lobby', LOTTERY_LOBBY_BODY],
      ['/api/lottery/clear', '{}'],
    ] as const) {
      expect((await routeRequest('POST', route, body, d)).status).toBe(401);
      expect((await routeRequest('POST', route, body, d, { 'x-stage-key': 'nope' })).status).toBe(
        401,
      );
      expect((await routeRequest('POST', route, body, d, { 'x-stage-key': 'sekrit' })).status).toBe(
        200,
      );
    }
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

describe('commissioner lobby edits (#210)', () => {
  it('tells the caller whether they may edit, without ever leaking who the commissioner is', async () => {
    const d = deps(hub());
    await routeRequest('POST', '/api/lottery/lobby', EDITABLE_LOBBY_BODY, d);

    const commish = await routeRequest('GET', '/api/lottery/me', '', d, asCommissioner);
    expect(commish.status).toBe(200);
    expect(JSON.parse(commish.body)).toEqual({ userId: 'commish', commissioner: true });

    const member = await routeRequest('GET', '/api/lottery/me', '', d, {
      authorization: 'Bearer user-someone-else',
    });
    expect(JSON.parse(member.body)).toEqual({ userId: 'someone-else', commissioner: false });

    // The public snapshot is what every viewer polls — it must not carry the id list.
    const state = await routeRequest('GET', '/api/lottery/state', '', d);
    expect(state.body).not.toContain('commish');
    expect(state.body).not.toContain('commissionerIds');
  });

  it('401s /me and /adjust without a usable bearer', async () => {
    const d = deps(hub());
    await routeRequest('POST', '/api/lottery/lobby', EDITABLE_LOBBY_BODY, d);
    const body = JSON.stringify({ teamId: 't-a', balls: 4 });

    expect((await routeRequest('GET', '/api/lottery/me', '', d)).status).toBe(401);
    expect((await routeRequest('POST', '/api/lottery/adjust', body, d)).status).toBe(401);
    // A token Discord rejects is the same 401 — the client's fix is identical either way.
    const bad = await routeRequest('POST', '/api/lottery/adjust', body, d, {
      authorization: 'Bearer nonsense',
    });
    expect(bad.status).toBe(401);
  });

  it('adjusts a team’s balls and recomputes the whole odds table', async () => {
    const d = deps(hub());
    await routeRequest('POST', '/api/lottery/lobby', EDITABLE_LOBBY_BODY, d);

    const reply = await routeRequest(
      'POST',
      '/api/lottery/adjust',
      JSON.stringify({ teamId: 't-a', balls: 3 }),
      d,
      asCommissioner,
    );
    expect(reply.status).toBe(200);

    const snapshot = JSON.parse(
      (await routeRequest('GET', '/api/lottery/state', '', d)).body,
    ) as LotterySnapshot;
    const rows = snapshot.lobby?.rows ?? [];
    // Row order is preserved (B first, as armed) so a stepper doesn't jump under the finger.
    expect(rows.map((r) => r.teamId)).toEqual(['t-b', 't-a']);
    expect(rows.map((r) => r.balls)).toEqual([2, 3]);
    // 2 vs 3 balls out of 5 — odds are recomputed from scratch, not carried over.
    expect(rows[0].firstPct).toBeCloseTo(40, 5);
    expect(rows[1].firstPct).toBeCloseTo(60, 5);
    // …and the header count follows, so `totalBalls` never contradicts the rows.
    expect(snapshot.lobby?.totalBalls).toBe(5);
    // The edit is pending until the bot drains it at `begin`.
    expect(snapshot.adjustments).toEqual([{ teamId: 't-a', balls: 3 }]);
  });

  it('403s a member who is not the commissioner, and 409s everyone once the bag is sealed', async () => {
    const identify = vi.fn((token: string) => Promise.resolve({ id: token.slice('user-'.length) }));
    const d = deps(hub(), { identify });
    const body = JSON.stringify({ teamId: 't-a', balls: 4 });
    await routeRequest('POST', '/api/lottery/lobby', EDITABLE_LOBBY_BODY, d);

    const outsider = await routeRequest('POST', '/api/lottery/adjust', body, d, {
      authorization: 'Bearer user-rando',
    });
    expect(outsider.status).toBe(403);
    expect(identify).toHaveBeenCalledTimes(1);

    // A committed run is nobody's to edit — not even the commissioner's. This is the fairness
    // guarantee: the commitment binds the bag (ADR 0006).
    await routeRequest('POST', '/api/lottery/start', LOTTERY_START_BODY, d);
    const sealed = await routeRequest('POST', '/api/lottery/adjust', body, d, asCommissioner);
    expect(sealed.status).toBe(409);
    // …and it was rejected locally: identifying a caller costs a Discord round-trip against our
    // rate limit, so an un-editable stage must never spend one.
    expect(identify).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown team and 400s a ball count outside 1..30', async () => {
    const d = deps(hub());
    await routeRequest('POST', '/api/lottery/lobby', EDITABLE_LOBBY_BODY, d);

    const unknown = await routeRequest(
      'POST',
      '/api/lottery/adjust',
      JSON.stringify({ teamId: 't-nope', balls: 2 }),
      d,
      asCommissioner,
    );
    expect(unknown.status).toBe(404);

    for (const balls of [0, -1, 2.5, 31, 'four']) {
      const reply = await routeRequest(
        'POST',
        '/api/lottery/adjust',
        JSON.stringify({ teamId: 't-a', balls }),
        d,
        asCommissioner,
      );
      expect(reply.status).toBe(400);
    }
    // Nothing above got through: the lobby is exactly as it was armed.
    const state = JSON.parse(
      (await routeRequest('GET', '/api/lottery/state', '', d)).body,
    ) as LotterySnapshot;
    expect(state.lobby?.totalBalls).toBe(3);
    expect(state.adjustments).toBeUndefined();
  });

  it('renames a team and asks for a re-import, both commissioner-gated (#219)', async () => {
    const d = deps(hub());
    await routeRequest('POST', '/api/lottery/lobby', EDITABLE_LOBBY_BODY, d);

    const renamed = await routeRequest(
      'POST',
      '/api/lottery/rename',
      JSON.stringify({ teamId: 't-a', displayName: 'Alpha Antlers' }),
      d,
      asCommissioner,
    );
    expect(renamed.status).toBe(200);

    const reimport = await routeRequest('POST', '/api/lottery/reimport', '', d, asCommissioner);
    expect(reimport.status).toBe(200);

    const state = JSON.parse(
      (await routeRequest('GET', '/api/lottery/state', '', d)).body,
    ) as LotterySnapshot;
    expect(state.lobby?.rows.map((r) => r.team)).toEqual(['B', 'Alpha Antlers']);
    expect(state.renames).toEqual([{ teamId: 't-a', displayName: 'Alpha Antlers' }]);
    expect(state.reimportRequested).toBe(true);
    // A rename is cosmetic: no ball moved, so the bag is untouched.
    expect(state.lobby?.totalBalls).toBe(3);
  });

  it('401s/403s rename and reimport exactly like adjust', async () => {
    const d = deps(hub());
    await routeRequest('POST', '/api/lottery/lobby', EDITABLE_LOBBY_BODY, d);
    const rename = JSON.stringify({ teamId: 't-a', displayName: 'X' });

    expect((await routeRequest('POST', '/api/lottery/rename', rename, d)).status).toBe(401);
    expect((await routeRequest('POST', '/api/lottery/reimport', '', d)).status).toBe(401);
    for (const [route, body] of [
      ['/api/lottery/rename', rename],
      ['/api/lottery/reimport', ''],
    ] as const) {
      const outsider = await routeRequest('POST', route, body, d, {
        authorization: 'Bearer user-rando',
      });
      expect(outsider.status).toBe(403);
    }
  });

  it('409s a duplicate name, 400s an unusable one, 409s everything once the bag is sealed', async () => {
    const d = deps(hub());
    await routeRequest('POST', '/api/lottery/lobby', EDITABLE_LOBBY_BODY, d);

    const dupe = await routeRequest(
      'POST',
      '/api/lottery/rename',
      JSON.stringify({ teamId: 't-a', displayName: 'b' }),
      d,
      asCommissioner,
    );
    expect(dupe.status).toBe(409);
    expect(dupe.body).toContain('already called');

    const blank = await routeRequest(
      'POST',
      '/api/lottery/rename',
      JSON.stringify({ teamId: 't-a', displayName: '   ' }),
      d,
      asCommissioner,
    );
    expect(blank.status).toBe(400);

    await routeRequest('POST', '/api/lottery/start', LOTTERY_START_BODY, d);
    expect(
      (
        await routeRequest(
          'POST',
          '/api/lottery/rename',
          JSON.stringify({ teamId: 't-a', displayName: 'X' }),
          d,
          asCommissioner,
        )
      ).status,
    ).toBe(409);
    expect(
      (await routeRequest('POST', '/api/lottery/reimport', '', d, asCommissioner)).status,
    ).toBe(409);
  });

  it('records a begin request stamped with the verified caller, commissioner-gated (#233)', async () => {
    const d = deps(hub());
    await routeRequest('POST', '/api/lottery/lobby', EDITABLE_LOBBY_BODY, d);
    const body = JSON.stringify({ delaySeconds: 10, direction: 'first-to-last' });

    // Same gate ladder as every commissioner write.
    expect((await routeRequest('POST', '/api/lottery/begin', body, d)).status).toBe(401);
    expect(
      (
        await routeRequest('POST', '/api/lottery/begin', body, d, {
          authorization: 'Bearer user-rando',
        })
      ).status,
    ).toBe(403);

    const accepted = await routeRequest('POST', '/api/lottery/begin', body, d, asCommissioner);
    expect(accepted.status).toBe(200);

    const state = JSON.parse(
      (await routeRequest('GET', '/api/lottery/state', '', d)).body,
    ) as LotterySnapshot;
    // `requestedBy` is the identity the bearer proved, not anything the body said — the audit
    // line the bot posts must name whoever actually pressed the button.
    expect(state.beginRequested).toEqual({
      delaySeconds: 10,
      direction: 'first-to-last',
      requestedBy: 'commish',
    });
    // A doorbell, not a draw: the lobby is still armed and untouched.
    expect(state.phase).toBe('lobby');
    expect(state.lobby?.totalBalls).toBe(3);
  });

  it('400s a begin outside the picker vocabulary and ignores a spoofed requestedBy (#233)', async () => {
    const d = deps(hub());
    await routeRequest('POST', '/api/lottery/lobby', EDITABLE_LOBBY_BODY, d);

    for (const bad of [
      { delaySeconds: 0, direction: 'worst-to-first' },
      { delaySeconds: 7, direction: 'worst-to-first' },
      { delaySeconds: 20, direction: 'sideways' },
      {},
    ]) {
      const reply = await routeRequest(
        'POST',
        '/api/lottery/begin',
        JSON.stringify(bad),
        d,
        asCommissioner,
      );
      expect(reply.status).toBe(400);
    }

    const spoofed = await routeRequest(
      'POST',
      '/api/lottery/begin',
      JSON.stringify({ delaySeconds: 5, direction: 'worst-to-first', requestedBy: 'victim' }),
      d,
      asCommissioner,
    );
    expect(spoofed.status).toBe(200);
    const state = JSON.parse(
      (await routeRequest('GET', '/api/lottery/state', '', d)).body,
    ) as LotterySnapshot;
    expect(state.beginRequested?.requestedBy).toBe('commish');

    // And like every commissioner write, a sealed bag is nobody's to begin again.
    await routeRequest('POST', '/api/lottery/start', LOTTERY_START_BODY, d);
    expect(
      (
        await routeRequest(
          'POST',
          '/api/lottery/begin',
          JSON.stringify({ delaySeconds: 5, direction: 'worst-to-first' }),
          d,
          asCommissioner,
        )
      ).status,
    ).toBe(409);
  });

  it('never accepts the bot’s stage key in place of a bearer (the two auth paths stay disjoint)', async () => {
    const d = deps(hub(), { stageKey: 'sekrit' });
    await routeRequest('POST', '/api/lottery/lobby', EDITABLE_LOBBY_BODY, d, {
      'x-stage-key': 'sekrit',
    });
    const withKey = await routeRequest(
      'POST',
      '/api/lottery/adjust',
      JSON.stringify({ teamId: 't-a', balls: 2 }),
      d,
      { 'x-stage-key': 'sekrit' },
    );
    expect(withKey.status).toBe(401);
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

describe('client diagnostics beacon (#231)', () => {
  it('logs the msg param, truncated, and replies 204 with no body', async () => {
    const h = hub();
    const logged: string[] = [];
    const d = deps(h, { clientLog: (m) => logged.push(m) });
    const reply = await routeRequest(
      'GET',
      `/api/lottery/diag?msg=${encodeURIComponent('handshake failed: ' + 'x'.repeat(400))}`,
      '',
      d,
    );
    expect(reply.status).toBe(204);
    expect(reply.body).toBe('');
    expect(logged).toHaveLength(1);
    expect(logged[0].startsWith('handshake failed:')).toBe(true);
    expect(logged[0].length).toBe(300);
  });

  it('works under the /.proxy prefix and without a clientLog sink', async () => {
    const h = hub();
    const reply = await routeRequest('GET', '/.proxy/api/lottery/diag?msg=hi', '', deps(h));
    expect(reply.status).toBe(204);
  });
});
