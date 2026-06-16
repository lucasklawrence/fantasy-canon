import { computeWeeklyStandings, type WeeklyResult } from '../weeklyStandings.js';

describe('computeWeeklyStandings', () => {
  it('tracks cumulative rank after each week', () => {
    const results: WeeklyResult[] = [
      { week: 1, teamId: 1, outcome: 'W', points: 100 },
      { week: 1, teamId: 2, outcome: 'L', points: 90 },
      { week: 2, teamId: 1, outcome: 'W', points: 100 },
      { week: 2, teamId: 2, outcome: 'L', points: 90 },
    ];
    const standings = computeWeeklyStandings(results);
    expect(standings.weeks).toEqual([1, 2]);
    const byId = new Map(standings.lines.map((l) => [l.teamId, l.ranks]));
    expect(byId.get(1)).toEqual([1, 1]);
    expect(byId.get(2)).toEqual([2, 2]);
  });

  it('reflects a lead change across weeks', () => {
    const results: WeeklyResult[] = [
      // Week 1: team 2 wins, team 1 loses
      { week: 1, teamId: 1, outcome: 'L', points: 80 },
      { week: 1, teamId: 2, outcome: 'W', points: 120 },
      // Week 2: team 1 wins, team 2 loses → now tied on wins (1 each); team 1 has more total points (80+150=230 vs 120+70=190)
      { week: 2, teamId: 1, outcome: 'W', points: 150 },
      { week: 2, teamId: 2, outcome: 'L', points: 70 },
    ];
    const byId = new Map(computeWeeklyStandings(results).lines.map((l) => [l.teamId, l.ranks]));
    expect(byId.get(2)).toEqual([1, 2]); // led after wk1, overtaken on tiebreak after wk2
    expect(byId.get(1)).toEqual([2, 1]);
  });

  it('breaks equal win-equivalents by total points for', () => {
    const results: WeeklyResult[] = [
      { week: 1, teamId: 1, outcome: 'W', points: 95 },
      { week: 1, teamId: 2, outcome: 'W', points: 130 }, // both 1-0, team 2 scored more
    ];
    const byId = new Map(computeWeeklyStandings(results).lines.map((l) => [l.teamId, l.ranks]));
    expect(byId.get(2)).toEqual([1]);
    expect(byId.get(1)).toEqual([2]);
  });

  it('counts a tie as half a win', () => {
    const results: WeeklyResult[] = [
      { week: 1, teamId: 1, outcome: 'W', points: 100 },
      { week: 1, teamId: 2, outcome: 'T', points: 100 },
      { week: 1, teamId: 3, outcome: 'T', points: 100 },
      { week: 1, teamId: 4, outcome: 'L', points: 100 },
    ];
    const byId = new Map(computeWeeklyStandings(results).lines.map((l) => [l.teamId, l.ranks]));
    // 1 win (1.0) > tie (0.5) > tie (0.5) > loss (0.0); ties broken by teamId.
    expect(byId.get(1)).toEqual([1]);
    expect(byId.get(2)).toEqual([2]);
    expect(byId.get(3)).toEqual([3]);
    expect(byId.get(4)).toEqual([4]);
  });

  it('keeps prior totals through a bye week (team absent that week)', () => {
    const results: WeeklyResult[] = [
      { week: 1, teamId: 1, outcome: 'W', points: 100 },
      { week: 1, teamId: 2, outcome: 'L', points: 50 },
      // Week 2: only team 2 plays (team 1 on bye); team 2 wins but is still behind on wins.
      { week: 2, teamId: 2, outcome: 'W', points: 200 },
    ];
    const standings = computeWeeklyStandings(results);
    expect(standings.weeks).toEqual([1, 2]);
    const byId = new Map(standings.lines.map((l) => [l.teamId, l.ranks]));
    // After wk2 both have 1 win; team 2 now leads on points (250 vs 100).
    expect(byId.get(1)).toEqual([1, 2]);
    expect(byId.get(2)).toEqual([2, 1]);
  });

  it('returns empty for no results', () => {
    expect(computeWeeklyStandings([])).toEqual({ weeks: [], lines: [] });
  });
});
