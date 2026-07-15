import { afterEach, describe, expect, it } from 'vitest';
import { startAdviceServer, type AdviceServerHandle, type ServeState } from '../server.js';

let handle: AdviceServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('startAdviceServer', () => {
  it('serves the current state as JSON at /state', async () => {
    const state: ServeState = {
      status: 'watching draft',
      updatedAt: '2026-08-30T00:00:00.000Z',
      source: 'https://fantasy.espn.com/football/draft',
    };
    handle = await startAdviceServer(() => state, { port: 0 });

    const res = await fetch(`${handle.url}state`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual(state);
  });

  it('reflects fresh state on each request (getState is called per request)', async () => {
    let n = 0;
    handle = await startAdviceServer(
      () => ({ status: `tick ${(n += 1)}`, updatedAt: '2026-08-30T00:00:00.000Z' }),
      { port: 0 },
    );

    const a = (await (await fetch(`${handle.url}state`)).json()) as ServeState;
    const b = (await (await fetch(`${handle.url}state`)).json()) as ServeState;
    expect(a.status).toBe('tick 1');
    expect(b.status).toBe('tick 2');
  });

  it('serves the dashboard HTML at /', async () => {
    handle = await startAdviceServer(() => ({ status: 'x', updatedAt: 'x' }), { port: 0 });

    const res = await fetch(handle.url);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Live Draft Advisor');
    expect(body).toContain('/state'); // the page polls this endpoint
  });
});
