import { describe, it, expect } from 'vitest';
import { buildScoutProfile, classifyArchetype } from '../scoutProfile.js';
import { TeamInfo } from '../teamStats.js';
import { RosterPlayer } from '../roster.js';

function team(overrides: Partial<TeamInfo> = {}): TeamInfo {
  return {
    id: 1,
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    streakLength: 0,
    acquisitions: 0,
    moves: 0,
    movesToIr: 0,
    totalMoves: 0,
    tradeBlockOn: 0,
    tradeBlockUntouchable: 0,
    homeWins: 0,
    homeLosses: 0,
    awayWins: 0,
    awayLosses: 0,
    ...overrides,
  };
}

describe('classifyArchetype', () => {
  it('labels a heavy adder as a Wire Addict', () => {
    const target = team({ id: 1, acquisitions: 40, totalMoves: 40 });
    const league = [target, team({ id: 2, acquisitions: 5, totalMoves: 5 })];
    const result = classifyArchetype(target, league);
    expect(result.label).toBe('Wire Addict');
    expect(result.detail).toBe('adds 40');
  });

  it('labels a low-activity manager as a Minimalist', () => {
    const target = team({ id: 1, totalMoves: 1, acquisitions: 1 });
    const league = [
      target,
      team({ id: 2, totalMoves: 40, acquisitions: 40 }),
      team({ id: 3, totalMoves: 40, acquisitions: 40 }),
    ];
    expect(classifyArchetype(target, league).label).toBe('Minimalist');
  });
});

describe('buildScoutProfile', () => {
  const roster: RosterPlayer[] = [
    { name: 'Josh Allen', position: 'QB', starting: true },
    { name: 'Backup RB', position: 'RB', starting: false },
  ];

  it('renders record, splits, streak, archetype, trade block and roster', () => {
    const target = team({
      id: 1,
      wins: 8,
      losses: 5,
      pointsFor: 1450.25,
      pointsAgainst: 1320.5,
      streakType: 'WIN',
      streakLength: 3,
      acquisitions: 30,
      totalMoves: 30,
      tradeBlockOn: 2,
      tradeBlockUntouchable: 1,
      homeWins: 5,
      homeLosses: 1,
      awayWins: 3,
      awayLosses: 4,
    });
    const lines = buildScoutProfile({
      team: target,
      allTeams: [target, team({ id: 2, acquisitions: 5, totalMoves: 5 })],
      teamName: 'Team Touchdown',
      managerName: 'Mike R.',
      roster,
      season: 2025,
      leagueLabel: 'My League',
    });
    const text = lines.join('\n');
    expect(lines[0]).toBe('League My League • Season 2025 • Scout');
    expect(lines[1]).toBe('Team Touchdown (Mike R.)');
    expect(text).toContain('Record: 8-5 • PF 1450.3 • PA 1320.5');
    expect(text).toContain('Home 83% (5-1) / Away 43% (3-4)');
    expect(text).toContain('Streak: W3');
    expect(text).toContain('Archetype: Wire Addict');
    expect(text).toContain('Trade block: 2 on the block, 1 untouchable');
    expect(text).toContain('Starters: QB Josh Allen');
    expect(text).toContain('Bench: RB Backup RB');
  });

  it('notes an unavailable roster and no streak', () => {
    const target = team({ id: 1, wins: 1, losses: 0 });
    const lines = buildScoutProfile({
      team: target,
      allTeams: [target],
      teamName: 'Solo',
      roster: [],
      season: 2025,
      leagueLabel: 'L',
    });
    const text = lines.join('\n');
    expect(lines[1]).toBe('Solo');
    expect(text).toContain('Streak: none');
    expect(text).toContain('Roster: unavailable');
  });
});
