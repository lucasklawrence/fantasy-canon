import { describe, it, expect } from 'vitest';
import {
  TeamNameCache,
  buildChoiceLabel,
  filterTeamChoices,
  MAX_AUTOCOMPLETE_CHOICES,
  TeamChoice,
} from '../teamNameCache.js';

function choice(teamId: number, teamName: string, managerName?: string): TeamChoice {
  return { teamId, teamName, managerName, label: buildChoiceLabel(teamName, managerName) };
}

describe('buildChoiceLabel', () => {
  it('appends the manager name when present and distinct', () => {
    expect(buildChoiceLabel('Team Touchdown', 'Mike R.')).toBe('Team Touchdown (Mike R.)');
  });

  it('omits the manager when absent or identical to the team name', () => {
    expect(buildChoiceLabel('Team Touchdown')).toBe('Team Touchdown');
    expect(buildChoiceLabel('Mike R.', 'Mike R.')).toBe('Mike R.');
  });

  it('falls back to "Team" for a blank team name', () => {
    expect(buildChoiceLabel('   ')).toBe('Team');
  });
});

describe('TeamNameCache', () => {
  it('stores and retrieves choices per league + season', () => {
    const cache = new TeamNameCache();
    cache.set('123', 2025, [choice(1, 'Alpha'), choice(2, 'Beta')]);
    expect(cache.get('123', 2025).map((c) => c.teamName)).toEqual(['Alpha', 'Beta']);
    expect(cache.get('123', 2024)).toEqual([]);
    expect(cache.get('999', 2025)).toEqual([]);
  });

  it('unions across seasons and dedupes by team id (latest season wins)', () => {
    const cache = new TeamNameCache();
    cache.set('123', 2024, [choice(1, 'Old Name'), choice(2, 'Beta')]);
    cache.set('123', 2025, [choice(1, 'New Name'), choice(3, 'Gamma')]);
    const all = cache.getAllForLeague('123');
    const byId = new Map(all.map((c) => [c.teamId, c.teamName]));
    expect(byId.get(1)).toBe('New Name');
    expect(byId.get(2)).toBe('Beta');
    expect(byId.get(3)).toBe('Gamma');
    expect(all).toHaveLength(3);
  });

  it('does not leak choices between leagues', () => {
    const cache = new TeamNameCache();
    cache.set('123', 2025, [choice(1, 'Alpha')]);
    cache.set('456', 2025, [choice(9, 'Zeta')]);
    expect(cache.getAllForLeague('123').map((c) => c.teamId)).toEqual([1]);
  });
});

describe('filterTeamChoices', () => {
  const choices = [
    choice(1, 'Team Touchdown', 'Mike R.'),
    choice(2, 'Gridiron Gang', 'Sarah L.'),
    choice(3, 'The Touchback', 'Mike T.'),
  ];

  it('returns all choices for a blank query', () => {
    expect(filterTeamChoices(choices, '   ')).toHaveLength(3);
  });

  it('matches on team name, case-insensitively', () => {
    expect(filterTeamChoices(choices, 'touch').map((c) => c.teamId)).toEqual([1, 3]);
  });

  it('matches on manager name', () => {
    expect(filterTeamChoices(choices, 'sarah').map((c) => c.teamId)).toEqual([2]);
  });

  it('caps results at the Discord limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => choice(i, `Team ${i}`));
    expect(filterTeamChoices(many, '')).toHaveLength(MAX_AUTOCOMPLETE_CHOICES);
  });
});
