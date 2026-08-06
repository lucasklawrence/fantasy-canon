import { buildTeamLogoMap, buildTeamNameMap, formatTeamName } from '../teamNames.js';

describe('formatTeamName', () => {
  it('prefers "location nickname"', () => {
    expect(formatTeamName({ location: 'Team', nickname: 'Awesome' }, 1)).toBe('Team Awesome');
  });

  it('uses just location or nickname when only one is present', () => {
    expect(formatTeamName({ location: 'Solo' }, 1)).toBe('Solo');
    expect(formatTeamName({ nickname: 'Nick' }, 1)).toBe('Nick');
  });

  it('falls back to name, then abbrev, then "Team <id>"', () => {
    expect(formatTeamName({ name: 'Named Squad' }, 1)).toBe('Named Squad');
    expect(formatTeamName({ abbrev: 'ABC' }, 1)).toBe('ABC');
    expect(formatTeamName({}, 7)).toBe('Team 7');
  });

  it('ignores non-string fields', () => {
    expect(formatTeamName({ location: 42, nickname: null, name: 'Real' }, 1)).toBe('Real');
  });
});

describe('buildTeamNameMap', () => {
  it('maps teamId → display name across the teams array', () => {
    const payload = {
      teams: [
        { id: 1, location: 'Gridiron', nickname: 'Goblins' },
        { id: 2, name: 'Couch Commandos' },
        { id: 3, abbrev: 'PYL' },
      ],
    };
    const map = buildTeamNameMap(payload);
    expect(map.get(1)).toBe('Gridiron Goblins');
    expect(map.get(2)).toBe('Couch Commandos');
    expect(map.get(3)).toBe('PYL');
    expect(map.size).toBe(3);
  });

  it('skips entries without a finite numeric id', () => {
    const map = buildTeamNameMap({
      teams: [
        { id: 'x', name: 'Bad' },
        { id: 5, name: 'Good' },
      ],
    });
    expect(map.size).toBe(1);
    expect(map.get(5)).toBe('Good');
  });

  it('returns an empty map for non-object / missing-teams payloads', () => {
    expect(buildTeamNameMap(null).size).toBe(0);
    expect(buildTeamNameMap('nope').size).toBe(0);
    expect(buildTeamNameMap({}).size).toBe(0);
    expect(buildTeamNameMap({ teams: 'not-an-array' }).size).toBe(0);
  });
});

describe('buildTeamLogoMap (#242)', () => {
  it('keeps http(s) logo URLs by team id and trims whitespace', () => {
    const map = buildTeamLogoMap({
      teams: [
        { id: 1, logo: 'https://cdn.espn.example/one.png' },
        { id: 2, logo: '  http://cdn.espn.example/two.jpg  ' },
      ],
    });
    expect(map.get(1)).toBe('https://cdn.espn.example/one.png');
    expect(map.get(2)).toBe('http://cdn.espn.example/two.jpg');
  });

  it('drops anything that is not a plain http(s) URL — it ends up fetched by the proxy', () => {
    const map = buildTeamLogoMap({
      teams: [
        { id: 1, logo: 'javascript:alert(1)' },
        { id: 2, logo: 'data:image/png;base64,AAAA' },
        { id: 3, logo: '' },
        { id: 4, logo: 42 },
        { id: 5 },
        { id: 'nope', logo: 'https://cdn.espn.example/ok.png' },
      ],
    });
    expect(map.size).toBe(0);
  });

  it('returns an empty map for non-object / missing-teams payloads', () => {
    expect(buildTeamLogoMap(null).size).toBe(0);
    expect(buildTeamLogoMap({ teams: 'not-an-array' }).size).toBe(0);
  });
});
