import { computeWeeklyTrophies, type TrophyMatchup, type TrophyKey } from '../trophies.js';

// One week, 3 matchups / 6 teams. Hand-computed so every category has a known winner.
//   m1: 1=120 beats 2=100  (margin 20)
//   m2: 3=90  beats 4=88   (margin 2  → closest)
//   m3: 5=140 beats 6=70   (margin 70 → blowout)
const WEEK: TrophyMatchup[] = [
  { home: { teamId: 1, score: 120 }, away: { teamId: 2, score: 100 } },
  { home: { teamId: 3, score: 90 }, away: { teamId: 4, score: 88 } },
  { home: { teamId: 5, score: 140 }, away: { teamId: 6, score: 70 } },
];

const winner = (trophies: { key: TrophyKey; teamId: number }[], key: TrophyKey) =>
  trophies.find((t) => t.key === key)?.teamId;

describe('computeWeeklyTrophies', () => {
  it('awards the six score-based trophies from matchups alone', () => {
    const t = computeWeeklyTrophies(WEEK);
    expect(winner(t, 'high-score')).toBe(5); // 140
    expect(winner(t, 'low-score')).toBe(6); // 70
    expect(winner(t, 'blowout')).toBe(5); // won by 70
    expect(winner(t, 'closest')).toBe(3); // won by 2
    expect(winner(t, 'luckiest')).toBe(3); // lowest-scoring winner (90)
    expect(winner(t, 'unluckiest')).toBe(2); // highest-scoring loser (100)
    // Without extras, the four data-gated categories are omitted.
    expect(t.map((x) => x.key)).toEqual([
      'high-score',
      'low-score',
      'blowout',
      'closest',
      'luckiest',
      'unluckiest',
    ]);
  });

  it('carries human-readable detail and the ranking value', () => {
    const t = computeWeeklyTrophies(WEEK);
    const blowout = t.find((x) => x.key === 'blowout');
    expect(blowout).toMatchObject({ emoji: '😱', value: 70, detail: 'won by 70.0' });
    const high = t.find((x) => x.key === 'high-score');
    expect(high).toMatchObject({ emoji: '👑', detail: '140.0 pts' });
  });

  it('adds Over/Underachiever from projected points', () => {
    // deltas (score − projected): 1:+10, 2:−5, 3:+10, 4:−7, 5:+10, 6:−20
    const projected = new Map([
      [1, 110],
      [2, 105],
      [3, 80],
      [4, 95],
      [5, 130],
      [6, 90],
    ]);
    const t = computeWeeklyTrophies(WEEK, { projected });
    // +10 ties among 1/3/5 → lowest teamId wins.
    expect(winner(t, 'overachiever')).toBe(1);
    expect(winner(t, 'underachiever')).toBe(6); // −20
  });

  it('adds Best/Worst Manager from optimal-lineup %', () => {
    const optimalPct = new Map([
      [1, 0.95],
      [2, 0.8],
      [3, 1.0],
      [4, 0.7],
      [5, 0.88],
      [6, 0.6],
    ]);
    const t = computeWeeklyTrophies(WEEK, { optimalPct });
    expect(winner(t, 'best-manager')).toBe(3); // 100%
    expect(winner(t, 'worst-manager')).toBe(6); // 60%
    expect(t.find((x) => x.key === 'best-manager')?.detail).toBe('100% optimal');
  });

  it('emits all ten categories when both extras are supplied', () => {
    const t = computeWeeklyTrophies(WEEK, {
      projected: new Map([[1, 110]]),
      optimalPct: new Map([[1, 0.5]]),
    });
    expect(t).toHaveLength(10);
  });

  it('omits decisive-only categories when every matchup ties', () => {
    const tied: TrophyMatchup[] = [
      { home: { teamId: 1, score: 100 }, away: { teamId: 2, score: 100 } },
    ];
    const t = computeWeeklyTrophies(tied);
    // High/Low still resolve (lower teamId breaks the tie); no winner/loser exists.
    expect(t.map((x) => x.key)).toEqual(['high-score', 'low-score']);
    expect(winner(t, 'high-score')).toBe(1);
  });

  it('returns nothing for an empty week', () => {
    expect(computeWeeklyTrophies([])).toEqual([]);
  });
});
