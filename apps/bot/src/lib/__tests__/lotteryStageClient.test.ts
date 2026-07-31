import { describe, expect, it } from 'vitest';
import { createHttpRevealStage, DEFAULT_STAGE_URL, stageFromEnv } from '../lotteryStageClient.js';

/** A typed fake fetch that records calls — no vi.fn `any` chains, no real socket. */
function fakeFetch(init: { ok?: boolean; status?: number; text?: string; json?: unknown } = {}): {
  impl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string, reqInit?: RequestInit): Promise<Response> => {
    calls.push({ url, init: reqInit ?? {} });
    return Promise.resolve({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      text: () => Promise.resolve(init.text ?? ''),
      json: () => Promise.resolve(init.json ?? {}),
    } as unknown as Response);
  }) as typeof fetch;
  return { impl, calls };
}

describe('createHttpRevealStage', () => {
  it('POSTs each beat to its route with the stage key header', async () => {
    const { impl, calls } = fakeFetch();
    const stage = createHttpRevealStage({
      baseUrl: 'http://127.0.0.1:9999/',
      stageKey: 'sekrit',
      fetchImpl: impl,
    });

    await stage.lobby({
      title: 'L',
      teamCount: 2,
      totalBalls: 3,
      rows: [{ team: 'A', balls: 1, firstPct: 33.3, top3Pct: 100 }],
    });
    await stage.clear({ guildId: 'g1' });
    await stage.start({
      title: 'L',
      commitment: 'h',
      teamCount: 2,
      totalBalls: 3,
      delayMs: 1000,
      rows: [{ team: 'A', balls: 1, firstPct: 33.3, top3Pct: 100 }],
    });
    await stage.beat({ pick: 2, remaining: ['A', 'B'] });
    await stage.reveal({ pick: 2, team: 'A', balls: 1, oddsPct: 33.3, remaining: ['B'] });
    await stage.finish({
      order: [{ pick: 1, team: 'B' }],
      verify: { secretSeed: 's', salt: 'm', drawSeed: 's|m', commitment: 'h' },
    });
    await stage.abort({ reason: 'r' });

    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:9999/api/lottery/lobby',
      'http://127.0.0.1:9999/api/lottery/clear',
      'http://127.0.0.1:9999/api/lottery/start',
      'http://127.0.0.1:9999/api/lottery/beat',
      'http://127.0.0.1:9999/api/lottery/reveal',
      'http://127.0.0.1:9999/api/lottery/finish',
      'http://127.0.0.1:9999/api/lottery/abort',
    ]);
    expect((calls[0].init.headers as Record<string, string>)['x-stage-key']).toBe('sekrit');
    expect(JSON.parse(calls[0].init.body as string) as { title: string }).toMatchObject({
      title: 'L',
    });
    // Every POST carries a timeout signal — a hung stage must never stall the ceremony.
    expect(calls.every((c) => c.init.signal instanceof AbortSignal)).toBe(true);
  });

  it('omits the key header when no stageKey is configured', async () => {
    const { impl, calls } = fakeFetch();
    const stage = createHttpRevealStage({ baseUrl: 'http://x', fetchImpl: impl });
    await stage.beat({ pick: 1, remaining: [] });
    expect('x-stage-key' in (calls[0].init.headers as Record<string, string>)).toBe(false);
  });

  it('throws with the status on a non-OK response', async () => {
    const { impl } = fakeFetch({ ok: false, status: 401, text: 'bad key' });
    const stage = createHttpRevealStage({ baseUrl: 'http://x', fetchImpl: impl });
    await expect(stage.beat({ pick: 1, remaining: [] })).rejects.toThrow('401');
  });

  it('state() GETs the public snapshot and narrows it to the reconciler shape (#205)', async () => {
    const { impl, calls } = fakeFetch({
      json: {
        phase: 'revealing',
        start: { commitment: 'hash-1', guildId: 'g1', title: 'ignored extra' },
        reveals: [{ pick: 4 }],
      },
    });
    const stage = createHttpRevealStage({ baseUrl: 'http://x', stageKey: 'k', fetchImpl: impl });
    const snapshot = await stage.state();
    expect(calls[0].url).toBe('http://x/api/lottery/state');
    expect(calls[0].init.method).toBeUndefined(); // a plain GET on the public route
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(snapshot).toEqual({
      phase: 'revealing',
      start: { commitment: 'hash-1', guildId: 'g1' },
    });
  });

  it('state() tolerates a lobby snapshot and defaults a malformed phase to idle', async () => {
    const lobby = fakeFetch({ json: { phase: 'lobby', lobby: { guildId: 'g2' } } });
    const stage = createHttpRevealStage({ baseUrl: 'http://x', fetchImpl: lobby.impl });
    expect(await stage.state()).toEqual({ phase: 'lobby', lobby: { guildId: 'g2' } });

    const malformed = fakeFetch({ json: { phase: 42 } });
    const bad = createHttpRevealStage({ baseUrl: 'http://x', fetchImpl: malformed.impl });
    expect((await bad.state()).phase).toBe('idle');

    const failing = fakeFetch({ ok: false, status: 503 });
    const down = createHttpRevealStage({ baseUrl: 'http://x', fetchImpl: failing.impl });
    await expect(down.state()).rejects.toThrow('503');
  });

  it('state() re-validates the pending in-Activity ball edits it hands the bag (#210)', async () => {
    const { impl } = fakeFetch({
      json: {
        phase: 'lobby',
        lobby: { guildId: 'g1' },
        adjustments: [
          { teamId: 't1', balls: 6 },
          { teamId: 't2', balls: 0 }, // a team with no balls could never be drawn
          { teamId: 't3', balls: 2.5 },
          { teamId: 't4' },
          { teamId: 42, balls: 3 },
          'nope',
        ],
      },
    });
    const stage = createHttpRevealStage({ baseUrl: 'http://x', fetchImpl: impl });
    // These numbers become ball counts in a bag a commitment binds, and the stage accepts them
    // from the public Activity client — only the well-formed one survives the trip.
    expect((await stage.state()).adjustments).toEqual([{ teamId: 't1', balls: 6 }]);

    const none = fakeFetch({ json: { phase: 'lobby', adjustments: [] } });
    const empty = createHttpRevealStage({ baseUrl: 'http://x', fetchImpl: none.impl });
    expect((await empty.state()).adjustments).toBeUndefined();
  });
});

describe('stageFromEnv', () => {
  it('defaults to the loopback dev URL and reads the env overrides', () => {
    // Just construction — no requests are made here.
    expect(stageFromEnv({})).toBeDefined();
    expect(DEFAULT_STAGE_URL).toBe('http://127.0.0.1:4610');
  });
});
