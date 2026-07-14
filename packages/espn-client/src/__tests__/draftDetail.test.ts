import { buildPlayerNameMap, parseDraftDetail } from '../draftDetail.js';

describe('parseDraftDetail', () => {
  it('maps raw picks, derives overall from (round, pickInRound), and sorts', () => {
    // A snake draft with no `overallPickNumber` and rows out of order — overall is derived.
    const payload = {
      draftDetail: {
        drafted: true,
        picks: [
          { teamId: 3, playerId: 300, roundId: 1, roundPickNumber: 2, bidAmount: 0, keeper: false },
          { teamId: 1, playerId: 100, roundId: 1, roundPickNumber: 1, bidAmount: 0, keeper: false },
          { teamId: 1, playerId: 101, roundId: 2, roundPickNumber: 1, bidAmount: 0, keeper: false },
        ],
      },
    };

    const parsed = parseDraftDetail(payload);

    expect(parsed.drafted).toBe(true);
    expect(parsed.picks).toEqual([
      { teamId: 1, playerId: 100, round: 1, pickInRound: 1, overall: 1, keeper: false },
      { teamId: 3, playerId: 300, round: 1, pickInRound: 2, overall: 2, keeper: false },
      { teamId: 1, playerId: 101, round: 2, pickInRound: 1, overall: 3, keeper: false },
    ]);
  });

  it('prefers ESPN overallPickNumber and carries auction bid / keeper / nominating fields', () => {
    const payload = {
      draftDetail: {
        drafted: true,
        picks: [
          {
            teamId: 5,
            playerId: 111,
            roundId: 1,
            roundPickNumber: 1,
            overallPickNumber: 1,
            bidAmount: 54,
            keeper: true,
            nominatingTeamId: 5,
          },
        ],
      },
    };

    expect(parseDraftDetail(payload).picks[0]).toEqual({
      teamId: 5,
      playerId: 111,
      round: 1,
      pickInRound: 1,
      overall: 1,
      bidAmount: 54,
      keeper: true,
      nominatingTeamId: 5,
    });
  });

  it('returns no picks before the draft has run (drafted === false)', () => {
    expect(parseDraftDetail({ draftDetail: { drafted: false, picks: [] } })).toEqual({
      drafted: false,
      picks: [],
    });
  });

  it('treats a missing draftDetail as not-yet-drafted', () => {
    expect(parseDraftDetail({})).toEqual({ drafted: false, picks: [] });
    expect(parseDraftDetail(null)).toEqual({ drafted: false, picks: [] });
  });
});

describe('buildPlayerNameMap', () => {
  it('resolves ids from team rosters and a top-level players list', () => {
    const payload = {
      teams: [
        {
          roster: {
            entries: [
              { playerPoolEntry: { player: { id: 100, fullName: 'Ja’Marr Chase' } } },
              { playerPoolEntry: { player: { id: 101, fullName: 'Bijan Robinson' } } },
            ],
          },
        },
        {
          roster: {
            entries: [{ playerPoolEntry: { player: { id: 300, fullName: 'Amon-Ra St. Brown' } } }],
          },
        },
      ],
      players: [
        { player: { id: 400, fullName: 'Puka Nacua' } },
        { id: 401, fullName: 'Malik Nabers' },
      ],
    };

    const map = buildPlayerNameMap(payload);

    expect(map.get(100)).toBe('Ja’Marr Chase');
    expect(map.get(101)).toBe('Bijan Robinson');
    expect(map.get(300)).toBe('Amon-Ra St. Brown');
    expect(map.get(400)).toBe('Puka Nacua'); // { player } shape
    expect(map.get(401)).toBe('Malik Nabers'); // bare shape
    expect(map.has(999)).toBe(false);
  });

  it('is empty for a payload with no roster/player data', () => {
    expect(buildPlayerNameMap({}).size).toBe(0);
  });
});
