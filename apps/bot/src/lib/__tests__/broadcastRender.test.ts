import { describe, expect, it } from 'vitest';
import { isBroadcastMetric, renderBroadcast } from '../broadcastRender.js';
import type { BotContext } from '../../config.js';

const mTeam = {
  teams: [
    {
      id: 1,
      location: 'Team',
      nickname: 'A',
      record: { overall: { wins: 2, losses: 0, ties: 0, pointsFor: 240 } },
    },
    {
      id: 2,
      location: 'Team',
      nickname: 'B',
      record: { overall: { wins: 0, losses: 2, ties: 0, pointsFor: 180 } },
    },
  ],
};

const mScoreboard = {
  schedule: [
    {
      matchupPeriodId: 1,
      home: { teamId: 1, totalPoints: 120 },
      away: { teamId: 2, totalPoints: 90 },
    },
    {
      matchupPeriodId: 2,
      home: { teamId: 1, totalPoints: 120 },
      away: { teamId: 2, totalPoints: 90 },
    },
  ],
};

function makeContext(scoreboard: unknown): BotContext {
  const snapshots = [
    { leagueId: '123', season: 2024, view: 'mTeam', fetchedAt: new Date(), payload: mTeam },
    {
      leagueId: '123',
      season: 2024,
      view: 'mScoreboard',
      fetchedAt: new Date(),
      payload: scoreboard,
    },
  ];
  return {
    env: { defaultLeagueId: '123', discordToken: 't', discordAppId: 'a' },
    snapshotsRepo: {
      listBySeason: () => Promise.resolve(snapshots),
      save: () => Promise.resolve(undefined),
    },
    // mSettings is not cached, so getLeagueInfo will fetch it; return an empty payload.
    espnClient: {
      fetchLeague: () => Promise.resolve({ url: '', status: 200, payload: {} }),
    },
  } as unknown as BotContext;
}

describe('isBroadcastMetric', () => {
  it('accepts supported metrics and rejects others', () => {
    expect(isBroadcastMetric('power-ranking')).toBe(true);
    expect(isBroadcastMetric('standings')).toBe(true);
    expect(isBroadcastMetric('luck')).toBe(false);
    expect(isBroadcastMetric('')).toBe(false);
  });
});

describe('renderBroadcast', () => {
  it('renders a power-ranking card', async () => {
    const result = await renderBroadcast(makeContext(mScoreboard), '123', 2024, 'power-ranking');
    expect(result).not.toBeNull();
    expect(result?.label).toBe('Power Rankings');
    expect(result?.filename).toBe('123-power-2024.png');
    expect((result?.buffer.length ?? 0) > 0).toBe(true);
  });

  it('renders a standings bump chart', async () => {
    const result = await renderBroadcast(makeContext(mScoreboard), '123', 2024, 'standings');
    expect(result).not.toBeNull();
    expect(result?.label).toBe('Standings by Week');
    expect(result?.filename).toBe('123-standings-2024.png');
    expect((result?.buffer.length ?? 0) > 0).toBe(true);
  });

  it('returns null when there are no matchups to render', async () => {
    const empty = { schedule: [] };
    expect(await renderBroadcast(makeContext(empty), '123', 2024, 'power-ranking')).toBeNull();
    expect(await renderBroadcast(makeContext(empty), '123', 2024, 'standings')).toBeNull();
  });
});
