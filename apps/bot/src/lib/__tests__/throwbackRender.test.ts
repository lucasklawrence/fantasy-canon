import { describe, expect, it } from 'vitest';
import { isThrowbackPostType, parseThrowbackRef, renderThrowback } from '../throwbackRender.js';
import type { BotContext } from '../../config.js';

const mTeam = {
  teams: [
    {
      id: 1,
      location: 'Team',
      nickname: 'A',
      record: { overall: { wins: 2, losses: 0, ties: 0, pointsFor: 240 } },
      transactionCounter: { acquisitions: 5, drops: 3, moveToActive: 2, moveToIR: 1, trades: 0 },
    },
    {
      id: 2,
      location: 'Team',
      nickname: 'B',
      record: { overall: { wins: 0, losses: 2, ties: 0, pointsFor: 180 } },
      transactionCounter: { acquisitions: 1, drops: 1, moveToActive: 0, moveToIR: 0, trades: 0 },
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

const mTransactions2 = {
  transactions: [
    {
      id: 't1',
      type: 'WAIVER',
      status: 'EXECUTED',
      bidAmount: 40,
      scoringPeriodId: 3,
      teamId: 1,
      items: [
        { type: 'WAIVER', toTeamId: 1 },
        { type: 'WAIVER', fromTeamId: 1 },
      ],
    },
    {
      id: 't2',
      type: 'WAIVER',
      status: 'EXECUTED',
      bidAmount: 12,
      scoringPeriodId: 3,
      teamId: 2,
      items: [{ type: 'WAIVER', toTeamId: 2 }],
    },
  ],
};

function makeContext(): BotContext {
  const snapshots = [
    { leagueId: '123', season: 2024, view: 'mTeam', fetchedAt: new Date(), payload: mTeam },
    {
      leagueId: '123',
      season: 2024,
      view: 'mScoreboard',
      fetchedAt: new Date(),
      payload: mScoreboard,
    },
    {
      leagueId: '123',
      season: 2024,
      view: 'mTransactions2',
      fetchedAt: new Date(),
      payload: mTransactions2,
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
    // The shared ensureSnapshot warms this on mTeam; a no-op set is enough here.
    teamNameCache: { set: () => undefined },
  } as unknown as BotContext;
}

describe('isThrowbackPostType', () => {
  it('accepts supported post types and rejects others', () => {
    expect(isThrowbackPostType('rivalry')).toBe(true);
    expect(isThrowbackPostType('waiver_legend')).toBe(true);
    expect(isThrowbackPostType('luck')).toBe(true);
    expect(isThrowbackPostType('churn')).toBe(true);
    expect(isThrowbackPostType('power-ranking')).toBe(false);
    expect(isThrowbackPostType('')).toBe(false);
  });
});

describe('parseThrowbackRef', () => {
  it('parses each post type ref shape', () => {
    expect(parseThrowbackRef('rivalry', '1:2')).toEqual({
      postType: 'rivalry',
      teamA: 1,
      teamB: 2,
    });
    expect(parseThrowbackRef('waiver_legend', '3:1')).toEqual({
      postType: 'waiver_legend',
      week: 3,
      teamId: 1,
    });
    expect(parseThrowbackRef('luck', '4')).toEqual({ postType: 'luck', teamId: 4 });
    expect(parseThrowbackRef('churn', '4')).toEqual({ postType: 'churn', teamId: 4 });
  });

  it('throws on a malformed ref', () => {
    expect(() => parseThrowbackRef('rivalry', '1')).toThrow();
    expect(() => parseThrowbackRef('luck', 'abc')).toThrow();
    expect(() => parseThrowbackRef('waiver_legend', '3:')).toThrow();
    expect(() => parseThrowbackRef('churn', '')).toThrow();
  });
});

describe('renderThrowback', () => {
  it('renders a rivalry card', async () => {
    const result = await renderThrowback(makeContext(), '123', 2024, 'rivalry', '1:2');
    expect(result).not.toBeNull();
    expect(result?.label).toBe('Rivalry Throwback');
    expect(result?.filename).toBe('123-throwback-rivalry-2024.png');
    expect((result?.buffer.length ?? 0) > 0).toBe(true);
  });

  it('renders a waiver legend card from per-week FAAB spend', async () => {
    const result = await renderThrowback(makeContext(), '123', 2024, 'waiver_legend', '3:1');
    expect(result?.label).toBe('Waiver Legend');
    expect(result?.filename).toBe('123-throwback-waiver-2024.png');
    expect((result?.buffer.length ?? 0) > 0).toBe(true);
  });

  it('renders a luck card', async () => {
    const result = await renderThrowback(makeContext(), '123', 2024, 'luck', '1');
    expect(result?.label).toBe('Luck Throwback');
    expect(result?.filename).toBe('123-throwback-luck-2024.png');
    expect((result?.buffer.length ?? 0) > 0).toBe(true);
  });

  it('renders a churn card', async () => {
    const result = await renderThrowback(makeContext(), '123', 2024, 'churn', '1');
    expect(result?.label).toBe('Roster Churn');
    expect(result?.filename).toBe('123-throwback-churn-2024.png');
    expect((result?.buffer.length ?? 0) > 0).toBe(true);
  });

  it('returns null when the referenced row has no data', async () => {
    // No head-to-head for a non-existent opponent.
    expect(await renderThrowback(makeContext(), '123', 2024, 'rivalry', '1:9')).toBeNull();
    // No waiver spend in week 5.
    expect(await renderThrowback(makeContext(), '123', 2024, 'waiver_legend', '5:1')).toBeNull();
    // Unknown team.
    expect(await renderThrowback(makeContext(), '123', 2024, 'churn', '9')).toBeNull();
  });
});
