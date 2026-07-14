import type { EspnClient, FetchLeagueParams, FetchLeagueResult } from '@fantasy-canon/espn-client';
import { describe, expect, it } from 'vitest';
import { fetchCompletedDraft } from '../completedDraft.js';

/** A stub ESPN client that records which views were requested and returns a canned payload per view. */
function stubClient(payloads: Record<string, unknown>): { client: EspnClient; views: string[] } {
  const views: string[] = [];
  const client: EspnClient = {
    fetchLeague: (params: FetchLeagueParams): Promise<FetchLeagueResult> => {
      views.push(params.view);
      return Promise.resolve({
        url: `https://espn/${params.view}`,
        status: 200,
        payload: payloads[params.view] ?? {},
      });
    },
  };
  return { client, views };
}

const draftDetail = (picks: unknown[], drafted = true): unknown => ({
  draftDetail: { drafted, picks },
});

describe('fetchCompletedDraft', () => {
  it('fetches picks + rosters, resolves names, and returns a replayable source', async () => {
    const { client, views } = stubClient({
      mDraftDetail: draftDetail([
        { teamId: 2, playerId: 101, roundId: 1, roundPickNumber: 2, keeper: false, bidAmount: 0 },
        { teamId: 1, playerId: 100, roundId: 1, roundPickNumber: 1, keeper: false, bidAmount: 0 },
      ]),
      mRoster: {
        teams: [
          {
            roster: {
              entries: [{ playerPoolEntry: { player: { id: 100, fullName: 'Bijan Robinson' } } }],
            },
          },
          {
            roster: {
              entries: [{ playerPoolEntry: { player: { id: 101, fullName: 'Ja’Marr Chase' } } }],
            },
          },
        ],
      },
    });

    const result = await fetchCompletedDraft(client, { leagueId: '1', season: 2025 });

    // Draft payload lacked names, so it fell back to an mRoster fetch (in that order).
    expect(views).toEqual(['mDraftDetail', 'mRoster']);
    expect(result.drafted).toBe(true);
    expect(result.picks).toEqual([
      { overall: 1, teamId: 1, playerName: 'Bijan Robinson' },
      { overall: 2, teamId: 2, playerName: 'Ja’Marr Chase' },
    ]);
    // ESPN-native detail is preserved for display/analysis.
    expect(result.detailPicks[0]).toMatchObject({ round: 1, pickInRound: 1, playerId: 100 });
    // The source replays the finished board, flagged complete.
    const snapshot = result.source.poll();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.picks.map((p) => p.playerName)).toEqual(['Bijan Robinson', 'Ja’Marr Chase']);
  });

  it('skips the mRoster fetch when the draft payload already carries player names', async () => {
    const { client, views } = stubClient({
      mDraftDetail: {
        draftDetail: {
          drafted: true,
          picks: [{ teamId: 1, playerId: 100, roundId: 1, roundPickNumber: 1, keeper: false }],
        },
        players: [{ player: { id: 100, fullName: 'Bijan Robinson' } }],
      },
    });

    const result = await fetchCompletedDraft(client, { leagueId: '1', season: 2025 });

    expect(views).toEqual(['mDraftDetail']);
    expect(result.picks[0].playerName).toBe('Bijan Robinson');
  });

  it('returns an empty result before the draft has run (drafted === false), without fetching rosters', async () => {
    const { client, views } = stubClient({ mDraftDetail: draftDetail([], false) });

    const result = await fetchCompletedDraft(client, { leagueId: '1', season: 2025 });

    expect(views).toEqual(['mDraftDetail']);
    expect(result).toMatchObject({ drafted: false, picks: [], detailPicks: [] });
    expect(result.source.size).toBe(0);
  });

  it('falls back to a Player <id> placeholder when a name cannot be resolved', async () => {
    const { client } = stubClient({
      mDraftDetail: draftDetail([
        { teamId: 1, playerId: 999, roundId: 1, roundPickNumber: 1, keeper: false },
      ]),
      mRoster: { teams: [] },
    });

    const result = await fetchCompletedDraft(client, { leagueId: '1', season: 2025 });

    expect(result.picks[0].playerName).toBe('Player 999');
  });
});
