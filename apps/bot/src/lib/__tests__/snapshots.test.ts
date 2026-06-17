import { ensureSnapshot, populateTeamNameCache } from '../snapshots.js';
import { createMockContext } from './mockContext.js';

describe('ensureSnapshot', () => {
  it('returns the cached payload without fetching or saving', async () => {
    const { context, fetchCalls, saved } = createMockContext({
      snapshots: [
        {
          leagueId: 'L',
          season: 2024,
          view: 'mRoster',
          fetchedAt: new Date(0),
          payload: { cached: true },
        },
      ],
    });
    expect(await ensureSnapshot(context, 'L', 2024, 'mRoster')).toEqual({ cached: true });
    expect(fetchCalls).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('fetches and persists on a cache miss', async () => {
    const { context, fetchCalls, saved } = createMockContext({
      fetchPayloads: { mRoster: { fetched: true } },
    });
    expect(await ensureSnapshot(context, 'L', 2024, 'mRoster')).toEqual({ fetched: true });
    expect(fetchCalls).toEqual([{ view: 'mRoster', scoringPeriodId: undefined }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ leagueId: 'L', season: 2024, view: 'mRoster' });
  });

  it('warms the team-name cache when an mTeam snapshot passes through', async () => {
    const { context, cacheSets } = createMockContext({
      fetchPayloads: {
        mTeam: {
          teams: [
            { id: 1, name: 'A' },
            { id: 2, name: 'B' },
          ],
        },
      },
    });
    await ensureSnapshot(context, 'L', 2024, 'mTeam');
    expect(cacheSets).toEqual([{ leagueId: 'L', season: 2024, count: 2 }]);
  });

  it('does not warm the cache for non-mTeam views', async () => {
    const { context, cacheSets } = createMockContext({ fetchPayloads: { mSettings: {} } });
    await ensureSnapshot(context, 'L', 2024, 'mSettings');
    expect(cacheSets).toHaveLength(0);
  });
});

describe('populateTeamNameCache', () => {
  it('stores one choice per valid team', () => {
    const { context, cacheSets } = createMockContext();
    populateTeamNameCache(context, 'L', 2024, {
      teams: [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
      ],
    });
    expect(cacheSets).toEqual([{ leagueId: 'L', season: 2024, count: 2 }]);
  });
});
