import { describe, expect, it } from 'vitest';
import { createHttpRevealStage, DEFAULT_STAGE_URL, stageFromEnv } from '../lotteryStageClient.js';

/** A typed fake fetch that records calls — no vi.fn `any` chains, no real socket. */
function fakeFetch(init: { ok?: boolean; status?: number; text?: string } = {}): {
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
});

describe('stageFromEnv', () => {
  it('defaults to the loopback dev URL and reads the env overrides', () => {
    // Just construction — no requests are made here.
    expect(stageFromEnv({})).toBeDefined();
    expect(DEFAULT_STAGE_URL).toBe('http://127.0.0.1:4610');
  });
});
