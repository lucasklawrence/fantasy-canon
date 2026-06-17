import { getLeagueInfo } from '../leagueInfo.js';
import { createMockContext } from './mockContext.js';

describe('getLeagueInfo', () => {
  it('reads the league name from a cached mSettings snapshot (no fetch)', async () => {
    const { context, fetchCalls } = createMockContext({
      snapshots: [
        {
          leagueId: 'L',
          season: 2024,
          view: 'mSettings',
          fetchedAt: new Date(0),
          payload: { settings: { name: 'The League' } },
        },
      ],
    });
    expect(await getLeagueInfo(context, 'L', 2024)).toEqual({ leagueId: 'L', name: 'The League' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('fetches and persists mSettings on a cache miss', async () => {
    const { context, fetchCalls, saved } = createMockContext({
      fetchPayloads: { mSettings: { settings: { name: 'Fetched League' } } },
    });
    expect(await getLeagueInfo(context, 'L', 2024)).toEqual({
      leagueId: 'L',
      name: 'Fetched League',
    });
    expect(fetchCalls).toEqual([{ view: 'mSettings', scoringPeriodId: undefined }]);
    expect(saved).toHaveLength(1);
  });

  it('falls back to no name when the fetch fails', async () => {
    const { context } = createMockContext({ fetchThrows: ['mSettings'] });
    expect(await getLeagueInfo(context, 'L', 2024)).toEqual({ leagueId: 'L', name: undefined });
  });

  it('returns no name when the settings payload lacks a usable name', async () => {
    const { context } = createMockContext({
      fetchPayloads: { mSettings: { settings: { name: '  ' } } },
    });
    expect((await getLeagueInfo(context, 'L', 2024)).name).toBeUndefined();
  });
});
