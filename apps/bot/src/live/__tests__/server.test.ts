import { describe, expect, it } from 'vitest';
import { routeRequest, type ServeState } from '../server.js';

const state: ServeState = {
  status: 'watching draft',
  updatedAt: '2026-08-30T00:00:00.000Z',
  source: 'https://fantasy.espn.com/football/draft',
};

describe('routeRequest', () => {
  it('serves the current state as JSON at /state', () => {
    const reply = routeRequest('/state', () => state);
    expect(reply.status).toBe(200);
    expect(reply.contentType).toContain('application/json');
    expect(JSON.parse(reply.body)).toEqual(state);
  });

  it('calls getState per request, so each /state reflects fresh state', () => {
    let n = 0;
    const getState = (): ServeState => ({
      status: `tick ${(n += 1)}`,
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    const status = (url: string): string =>
      (JSON.parse(routeRequest(url, getState).body) as ServeState).status;
    expect(status('/state')).toBe('tick 1');
    expect(status('/state')).toBe('tick 2');
  });

  it('serves the dashboard HTML at / (and /index.html and query strings)', () => {
    for (const url of ['/', '/index.html', '/?x=1']) {
      const reply = routeRequest(url, () => state);
      expect(reply.status).toBe(200);
      expect(reply.contentType).toContain('text/html');
      expect(reply.body).toContain('Live Draft Advisor');
      expect(reply.body).toContain('/state'); // the page polls this endpoint
    }
  });

  it('404s anything else', () => {
    expect(routeRequest('/nope', () => state).status).toBe(404);
  });
});
