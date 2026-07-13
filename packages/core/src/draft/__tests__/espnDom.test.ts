import { espnRowsToPicks, espnSnapshot, parsePlayerColumn, type EspnRawPick } from '../espnDom.js';

describe('parsePlayerColumn', () => {
  it('splits a clean player cell into name / team / position', () => {
    expect(parsePlayerColumn('Kyren WilliamsLARRB')).toEqual({
      name: 'Kyren Williams',
      nflTeam: 'LAR',
      position: 'RB',
    });
  });

  it('strips a trailing injury badge so it never glues to the name', () => {
    // Seen live: "Cam Skattebo" carrying a "Q" (questionable) badge before team+pos.
    expect(parsePlayerColumn('Cam SkatteboQNYGRB')).toEqual({
      name: 'Cam Skattebo',
      nflTeam: 'NYG',
      position: 'RB',
    });
  });

  it('handles two-letter team codes', () => {
    expect(parsePlayerColumn('Jahmyr GibbsDETRB')).toMatchObject({
      nflTeam: 'DET',
      position: 'RB',
    });
    expect(parsePlayerColumn('Josh JacobsGBRB')).toEqual({
      name: 'Josh Jacobs',
      nflTeam: 'GB',
      position: 'RB',
    });
  });

  it('keeps punctuated names intact', () => {
    expect(parsePlayerColumn('A.J. BrownPHIWR')).toEqual({
      name: 'A.J. Brown',
      nflTeam: 'PHI',
      position: 'WR',
    });
  });

  it('leaves team/position undefined when tokens are absent (defense/kicker or bare name)', () => {
    expect(parsePlayerColumn('Justin Tucker')).toEqual({ name: 'Justin Tucker' });
  });
});

describe('espnRowsToPicks', () => {
  const rows: EspnRawPick[] = [
    { overall: 2, playerName: "Ja'Marr Chase", nflTeam: 'CIN', position: 'WR' },
    { overall: 1, playerName: 'Bijan Robinson', nflTeam: 'ATL', position: 'RB' },
    { overall: 3, playerName: '   ', nflTeam: 'X' }, // no name → dropped
    { overall: 2, playerName: 'Duplicate Overall', nflTeam: 'CIN' }, // dup overall → dropped
  ];

  it('sorts by overall, drops nameless rows, de-dupes overalls, and zeroes teamId', () => {
    const picks = espnRowsToPicks(rows);
    expect(picks).toEqual([
      { overall: 1, teamId: 0, playerName: 'Bijan Robinson' },
      { overall: 2, teamId: 0, playerName: "Ja'Marr Chase" },
    ]);
  });

  it('espnSnapshot carries the on-the-clock overall through', () => {
    const snap = espnSnapshot(rows, 4);
    expect(snap.onTheClock).toBe(4);
    expect(snap.picks).toHaveLength(2);
  });
});
