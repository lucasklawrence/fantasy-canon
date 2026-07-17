import { computePickOdds } from '../odds.js';
import type { DraftOrderTeamInput } from '../types.js';

/**
 * Independent reference: enumerate every draw sequence recursively and accumulate each
 * team's per-pick probability. Exponential, so only used on tiny inputs — but it shares no
 * code with the subset DP under test.
 */
function bruteForceOdds(weights: number[]): number[][] {
  const n = weights.length;
  const odds = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  const visit = (remaining: number[], pick: number, probability: number): void => {
    const total = remaining.reduce((sum, team) => sum + weights[team], 0);
    for (const team of remaining) {
      const p = (probability * weights[team]) / total;
      odds[team][pick] += p;
      const rest = remaining.filter((t) => t !== team);
      if (rest.length > 0) {
        visit(rest, pick + 1, p);
      }
    }
  };

  visit([...weights.keys()], 0, 1);
  return odds;
}

describe('computePickOdds', () => {
  it('gives every pick equal odds when weights are uniform', () => {
    const odds = computePickOdds([{ teamId: 'a' }, { teamId: 'b' }, { teamId: 'c' }]);
    for (const row of odds) {
      expect(row.probabilities).toHaveLength(3);
      for (const p of row.probabilities) {
        expect(p).toBeCloseTo(1 / 3, 12);
      }
    }
  });

  it('weights pick 1 by ball share', () => {
    const odds = computePickOdds([{ teamId: 'a', bonusBalls: 1 }, { teamId: 'b' }]);
    expect(odds[0].probabilities[0]).toBeCloseTo(2 / 3, 12);
    expect(odds[1].probabilities[0]).toBeCloseTo(1 / 3, 12);
  });

  it('matches brute-force enumeration for a bonus-skewed field', () => {
    const teams: DraftOrderTeamInput[] = [
      { teamId: 'a', bonusBalls: 3 },
      { teamId: 'b', bonusBalls: 1 },
      { teamId: 'c' },
      { teamId: 'd', baseBalls: 5 },
    ];
    const expected = bruteForceOdds([5, 3, 2, 5]);

    const odds = computePickOdds(teams, 2);

    odds.forEach((row, team) => {
      row.probabilities.forEach((p, pick) => {
        expect(p).toBeCloseTo(expected[team][pick], 12);
      });
    });
  });

  it.each([
    ['uniform', (i: number): DraftOrderTeamInput => ({ teamId: `team-${i}` })],
    [
      'bonus-skewed',
      (i: number): DraftOrderTeamInput => ({ teamId: `team-${i}`, bonusBalls: i % 4 }),
    ],
  ])('rows and pick columns each sum to 1 for a 12-team %s league', (_label, makeTeam) => {
    const teams = Array.from({ length: 12 }, (_, i) => makeTeam(i));

    const odds = computePickOdds(teams, 2);

    for (const row of odds) {
      const rowSum = row.probabilities.reduce((sum, p) => sum + p, 0);
      expect(Math.abs(rowSum - 1)).toBeLessThan(1e-9);
    }
    for (let pick = 0; pick < teams.length; pick += 1) {
      const columnSum = odds.reduce((sum, row) => sum + row.probabilities[pick], 0);
      expect(Math.abs(columnSum - 1)).toBeLessThan(1e-9);
    }
  });

  it('rejects empty and duplicate inputs', () => {
    expect(() => computePickOdds([])).toThrow('At least one team');
    expect(() => computePickOdds([{ teamId: 'a' }, { teamId: 'a' }])).toThrow('Duplicate teamId');
  });

  it('rejects fields too large for the exact DP', () => {
    const teams = Array.from({ length: 21 }, (_, i) => ({ teamId: `team-${i}` }));
    expect(() => computePickOdds(teams)).toThrow('limited to 20 teams');
  });
});
