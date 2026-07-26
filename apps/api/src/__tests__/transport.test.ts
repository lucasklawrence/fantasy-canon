import { describe, expect, it } from 'vitest';
import { apiPath, isDiscordActivity, proxyBase, wsUrl } from '../client/transport.js';

describe('isDiscordActivity', () => {
  it('detects the Activity via the frame_id query param', () => {
    expect(isDiscordActivity({ search: '?frame_id=abc123', hostname: 'localhost' })).toBe(true);
  });

  it('detects the Activity via the discordsays.com host', () => {
    expect(isDiscordActivity({ search: '', hostname: '123.discordsays.com' })).toBe(true);
  });

  it('is false for a plain dev host', () => {
    expect(isDiscordActivity({ search: '?x=1', hostname: '127.0.0.1' })).toBe(false);
  });
});

describe('proxyBase', () => {
  it('prefixes /.proxy inside Discord and nothing in dev', () => {
    expect(proxyBase(true)).toBe('/.proxy');
    expect(proxyBase(false)).toBe('');
  });
});

describe('apiPath', () => {
  it('joins the base and route, tolerating a missing leading slash', () => {
    expect(apiPath('/.proxy', '/api/state')).toBe('/.proxy/api/state');
    expect(apiPath('', '/api/state')).toBe('/api/state');
    expect(apiPath('/.proxy', 'api/token')).toBe('/.proxy/api/token');
  });
});

describe('wsUrl', () => {
  it('matches the page scheme and carries the base prefix', () => {
    expect(wsUrl({ protocol: 'http:', host: '127.0.0.1:4610' }, '')).toBe(
      'ws://127.0.0.1:4610/api/ws',
    );
    expect(wsUrl({ protocol: 'https:', host: 'abc.discordsays.com' }, '/.proxy')).toBe(
      'wss://abc.discordsays.com/.proxy/api/ws',
    );
  });

  it('takes an alternate feed route (the lottery stage)', () => {
    expect(
      wsUrl({ protocol: 'https:', host: 'abc.discordsays.com' }, '/.proxy', '/api/lottery/ws'),
    ).toBe('wss://abc.discordsays.com/.proxy/api/lottery/ws');
  });
});
