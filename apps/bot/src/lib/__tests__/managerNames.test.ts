import { describe, it, expect } from 'vitest';
import { buildManagerNameMap, buildOwnerDisplayMap } from '../managerNames.js';

describe('buildOwnerDisplayMap', () => {
  it('prefers displayName, then nickname, then first+last', () => {
    const payload = {
      members: [
        { id: '{A}', displayName: 'Display A', firstName: 'First', lastName: 'A' },
        { id: '{B}', nickname: 'Nick B', firstName: 'First', lastName: 'B' },
        { id: '{C}', firstName: 'First', lastName: 'C' },
      ],
    };
    const map = buildOwnerDisplayMap(payload);
    expect(map.get('{A}')).toBe('Display A');
    expect(map.get('{B}')).toBe('Nick B');
    expect(map.get('{C}')).toBe('First C');
  });

  it('returns an empty map for malformed payloads', () => {
    expect(buildOwnerDisplayMap(undefined).size).toBe(0);
    expect(buildOwnerDisplayMap({ members: 'nope' }).size).toBe(0);
  });
});

describe('buildManagerNameMap', () => {
  it('joins teams to member display names via primaryOwner', () => {
    const payload = {
      members: [{ id: '{A}', displayName: 'Mike R.' }],
      teams: [{ id: 7, primaryOwner: '{A}' }],
    };
    expect(buildManagerNameMap(payload).get(7)).toBe('Mike R.');
  });

  it('falls back to the first owners[] id when primaryOwner is absent', () => {
    const payload = {
      members: [{ id: '{B}', displayName: 'Sarah L.' }],
      teams: [{ id: 3, owners: ['{B}'] }],
    };
    expect(buildManagerNameMap(payload).get(3)).toBe('Sarah L.');
  });

  it('falls back to embedded owner metadata when no member matches', () => {
    const payload = {
      teams: [{ id: 5, owners: [{ firstName: 'Jane', lastName: 'Doe' }] }],
    };
    expect(buildManagerNameMap(payload).get(5)).toBe('Jane Doe');
  });

  it('omits teams with no resolvable manager name', () => {
    const payload = { teams: [{ id: 9 }] };
    expect(buildManagerNameMap(payload).has(9)).toBe(false);
  });
});
