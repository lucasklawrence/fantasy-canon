import type { PlayerTier } from '@fantasy-canon/core';
import { describe, expect, it } from 'vitest';
import { createDraftHub, type DraftHub } from '../hub.js';
import { parsePickBody, routeRequest, type Envelope, type RouteDeps } from '../routes.js';

const POOL: PlayerTier[] = [
  { name: 'A', position: 'RB', adp: 1, source: 'test' },
  { name: 'B', position: 'WR', adp: 2, source: 'test' },
  { name: 'C', position: 'RB', adp: 3, source: 'test' },
];

/** Route deps backed by a real hub, with a fixed timestamp so replies are deterministic. */
function deps(h: DraftHub): RouteDeps {
  return {
    getEnvelope: (): Envelope => ({ ...h.snapshot(), updatedAt: '2026-07-14T00:00:00.000Z' }),
    ingest: (picks) => h.ingest(picks),
    nextOverall: () => h.nextOverall(),
    reset: () => h.reset(),
  };
}

function hub(): DraftHub {
  return createDraftHub({
    leagueSize: 3,
    mySlot: 1,
    rosterSlots: { RB: 1, WR: 1, QB: 1 },
    pool: POOL,
  });
}

describe('routeRequest', () => {
  it('serves the dashboard page at /', () => {
    const reply = routeRequest('GET', '/', '', deps(hub()));
    expect(reply.status).toBe(200);
    expect(reply.contentType).toContain('text/html');
    expect(reply.body).toContain('Draft Dashboard');
  });

  it('serves the current envelope as JSON at /api/state', () => {
    const reply = routeRequest('GET', '/api/state?t=1', '', deps(hub()));
    expect(reply.status).toBe(200);
    const env = JSON.parse(reply.body) as Envelope;
    expect(env.status).toBe('waiting for the first pick');
    expect(env.updatedAt).toBe('2026-07-14T00:00:00.000Z');
    expect(env.view.poolSize).toBe(3);
  });

  it('ingests a single { playerName } pick and reflects it in state', () => {
    const h = hub();
    const d = deps(h);
    const post = routeRequest('POST', '/api/pick', JSON.stringify({ playerName: 'A' }), d);
    expect(post.status).toBe(200);
    expect(JSON.parse(post.body)).toEqual({ added: 1, picks: 1 });

    const state = JSON.parse(routeRequest('GET', '/api/state', '', d).body) as Envelope;
    expect(state.view.remaining).toBe(2); // A off the board
    expect(state.view.recentPicks[0]?.name).toBe('A');
  });

  it('ingests an explicit { picks: [...] } board idempotently', () => {
    const h = hub();
    const d = deps(h);
    const body = JSON.stringify({
      picks: [
        { overall: 1, playerName: 'A' },
        { overall: 2, playerName: 'B' },
      ],
    });
    expect(JSON.parse(routeRequest('POST', '/api/pick', body, d).body)).toEqual({
      added: 2,
      picks: 2,
    });
    // Re-POST the same board → nothing new.
    expect(JSON.parse(routeRequest('POST', '/api/pick', body, d).body)).toEqual({
      added: 0,
      picks: 2,
    });
  });

  it('400s on invalid JSON and on a body with no usable pick', () => {
    const d = deps(hub());
    expect(routeRequest('POST', '/api/pick', '{not json', d).status).toBe(400);
    expect(routeRequest('POST', '/api/pick', JSON.stringify({ foo: 1 }), d).status).toBe(400);
  });

  it('resets the board', () => {
    const h = hub();
    const d = deps(h);
    routeRequest('POST', '/api/pick', JSON.stringify({ playerName: 'A' }), d);
    expect(routeRequest('POST', '/api/reset', '', d).status).toBe(200);
    const state = JSON.parse(routeRequest('GET', '/api/state', '', d).body) as Envelope;
    expect(state.view.remaining).toBe(3); // whole pool back
  });

  it('404s an unknown route', () => {
    expect(routeRequest('GET', '/nope', '', deps(hub())).status).toBe(404);
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
});
