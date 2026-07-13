import type { PlayerTier } from '../../rankings/parse.js';
import { applyPicks, createDraftSession } from '../session.js';
import { gradeRoster, gradeSession, type RosterPick } from '../gradeRoster.js';

function player(
  name: string,
  position: PlayerTier['position'],
  adp?: number,
  tier?: number,
): PlayerTier {
  return { name, position, adp, tier, source: 'test' };
}
const rb = (name: string, adp?: number, tier?: number) => player(name, 'RB', adp, tier);
const wr = (name: string, adp?: number) => player(name, 'WR', adp);
const te = (name: string, adp?: number, tier?: number) => player(name, 'TE', adp, tier);
const qb = (name: string, adp?: number) => player(name, 'QB', adp);

const SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 };

/** A complete starters-filled roster drafted right at ADP (every value = 0). */
function parRoster(): { pool: PlayerTier[]; picks: RosterPick[] } {
  const pool = [
    qb('Par QB', 50),
    rb('RB One', 10),
    rb('RB Two', 20),
    rb('RB Three', 60),
    wr('WR One', 15),
    wr('WR Two', 25),
    wr('WR Three', 70),
    te('TE One', 40),
  ];
  const picks: RosterPick[] = [
    { overall: 10, playerName: 'RB One' },
    { overall: 15, playerName: 'WR One' },
    { overall: 20, playerName: 'RB Two' },
    { overall: 25, playerName: 'WR Two' },
    { overall: 40, playerName: 'TE One' },
    { overall: 50, playerName: 'Par QB' },
    { overall: 60, playerName: 'RB Three' },
    { overall: 70, playerName: 'WR Three' },
    { overall: 150, playerName: 'A Kicker', position: 'K' },
    { overall: 160, playerName: 'A Defense', position: 'DST' },
  ];
  return { pool, picks };
}

describe('gradeRoster', () => {
  it('scores value as overall − ADP and classifies steals, reaches, and fair picks', () => {
    const pool = [rb('Steal RB', 20), wr('Reach WR', 30), qb('Par QB', 50)];
    const picks: RosterPick[] = [
      { overall: 10, playerName: 'Reach WR' }, // 10 − 30 = −20 → reach
      { overall: 40, playerName: 'Steal RB' }, // 40 − 20 = +20 → steal
      { overall: 50, playerName: 'Par QB' }, //   50 − 50 =   0 → fair
    ];
    const result = gradeRoster(picks, pool, { rosterSlots: SLOTS });

    expect(result.picks.map((p) => [p.playerName, p.value, p.verdict])).toEqual([
      ['Reach WR', -20, 'reach'],
      ['Steal RB', 20, 'steal'],
      ['Par QB', 0, 'fair'],
    ]);
    expect(result.valueScore).toBe(0); // (−20 + 20 + 0) / 3
    expect(result.steals.map((p) => p.playerName)).toEqual(['Steal RB']);
    expect(result.reaches.map((p) => p.playerName)).toEqual(['Reach WR']);
    expect(result.gradedCount).toBe(3);
  });

  it('clamps a single monster steal so it cannot dominate the average', () => {
    const pool = [rb('Faller', 5)];
    const result = gradeRoster([{ overall: 120, playerName: 'Faller' }], pool, {
      rosterSlots: SLOTS,
    });
    // 120 − 5 = 115, clamped to +30.
    expect(result.picks[0].value).toBe(30);
  });

  it('grades a par, starters-filled roster around B with no missing slots', () => {
    const { pool, picks } = parRoster();
    const result = gradeRoster(picks, pool, { rosterSlots: SLOTS });

    expect(result.valueScore).toBe(0);
    expect(result.starters.missing).toEqual([]);
    expect(result.starters.filled).toBe(result.starters.required);
    expect(result.starters.required).toBe(9); // QB+RB×2+WR×2+TE+FLEX+K+DST
    expect(result.grade).toBe('B');
  });

  it('penalizes each unfilled starting slot and names it in the notes', () => {
    const { pool, picks } = parRoster();
    const withoutQb = picks.filter((p) => p.playerName !== 'Par QB');
    const result = gradeRoster(withoutQb, pool, { rosterSlots: SLOTS });

    expect(result.starters.missing).toContain('QB');
    expect(result.score).toBe(-8); // valueScore 0 − 8 × 1 missing
    expect(result.grade).toBe('C');
    expect(result.notes.some((n) => /Unfilled starting slot/.test(n))).toBe(true);
  });

  it('does not evaluate (or penalize) K/DST when no pick carries a K/DST position', () => {
    const { pool, picks } = parRoster();
    // Drop the explicit K/DST picks → grader is blind to those slots and must skip them.
    const skillOnly = picks.filter((p) => p.position === undefined);
    const result = gradeRoster(skillOnly, pool, { rosterSlots: SLOTS });

    expect(result.starters.required).toBe(7); // K + DST slots excluded
    expect(result.starters.missing).toEqual([]);
    expect(result.grade).toBe('B');
  });

  it('falls back to a tier estimate when a player has no ADP', () => {
    const pool = [rb('Tier Back', undefined, 1)]; // tier 1 → effAdp 1×12 − 6 = 6
    const result = gradeRoster([{ overall: 30, playerName: 'Tier Back' }], pool, {
      rosterSlots: SLOTS,
    });
    expect(result.picks[0].adp).toBe(6);
    expect(result.picks[0].value).toBe(24); // 30 − 6
    expect(result.picks[0].verdict).toBe('steal');
  });

  it('leaves a player who is not on the board ungraded', () => {
    const result = gradeRoster([{ overall: 5, playerName: 'Nobody Knows' }], [], {
      rosterSlots: SLOTS,
    });
    expect(result.picks[0].value).toBeUndefined();
    expect(result.picks[0].verdict).toBe('fair');
    expect(result.gradedCount).toBe(0);
    expect(result.valueScore).toBe(0);
  });

  it('is deterministic for identical input', () => {
    const { pool, picks } = parRoster();
    expect(gradeRoster(picks, pool, { rosterSlots: SLOTS })).toEqual(
      gradeRoster(picks, pool, { rosterSlots: SLOTS }),
    );
  });

  it('matches positions case-insensitively for lowercase rosterSlots keys', () => {
    const pool = [rb('R1', 10), rb('R2', 20)];
    const picks: RosterPick[] = [
      { overall: 10, playerName: 'R1' },
      { overall: 20, playerName: 'R2' },
    ];
    const result = gradeRoster(picks, pool, { rosterSlots: { rb: 2, bench: 6 } });
    expect(result.starters.missing).toEqual([]);
    expect(result.starters.filled).toBe(2);
  });

  it('disambiguates a name duplicated across positions by the pick position', () => {
    // The ADP merger keys rows by name|position, so the same normalized name can appear at two
    // positions. An explicitly-positioned pick must grade against the matching row, not whichever
    // was inserted first.
    const pool = [wr('Mike Williams', 30), rb('Mike Williams', 80)];
    const picks: RosterPick[] = [{ overall: 40, playerName: 'Mike Williams', position: 'RB' }];
    const result = gradeRoster(picks, pool, { rosterSlots: SLOTS });

    expect(result.picks[0].position).toBe('RB');
    expect(result.picks[0].adp).toBe(80); // the RB row, not the first-inserted WR (30)
    expect(result.picks[0].value).toBe(-30); // 40 − 80 = −40 → clamped to −30 → reach
    expect(result.picks[0].verdict).toBe('reach');
  });

  it('gates K and DST slots independently — a tagged K does not unmask an unseen DST', () => {
    const pool = [rb('R1', 10)];
    const picks: RosterPick[] = [
      { overall: 10, playerName: 'R1' },
      { overall: 150, playerName: 'A Kicker', position: 'K' },
    ];
    // K is observable (filled); DST is untagged → its slot must be skipped, not counted missing.
    const result = gradeRoster(picks, pool, { rosterSlots: { RB: 1, K: 1, DST: 1 } });
    expect(result.starters.missing).toEqual([]);
  });

  it('fills FLEX from a leftover WR when no RB remains', () => {
    const pool = [rb('R1', 10), wr('W1', 15), wr('W2', 25)];
    const picks: RosterPick[] = [
      { overall: 10, playerName: 'R1' },
      { overall: 15, playerName: 'W1' },
      { overall: 25, playerName: 'W2' },
    ];
    const result = gradeRoster(picks, pool, { rosterSlots: { RB: 1, WR: 1, FLEX: 1 } });
    expect(result.starters.missing).toEqual([]);
    expect(result.starters.filled).toBe(3);
  });

  it('reports FLEX unfilled when no flex-eligible player is left over', () => {
    const pool = [rb('R1', 10), wr('W1', 15)];
    const picks: RosterPick[] = [
      { overall: 10, playerName: 'R1' },
      { overall: 15, playerName: 'W1' },
    ];
    const result = gradeRoster(picks, pool, { rosterSlots: { RB: 1, WR: 1, FLEX: 1 } });
    expect(result.starters.missing).toEqual(['FLEX']);
  });
});

describe('gradeSession', () => {
  it('grades only the picks belonging to your draft slot', () => {
    const pool = [rb('My RB', 1), wr('My WR', 3), rb('My Bench', 5)];
    // 2-team snake, our slot 1, 3 rounds → our overalls are 1, 4, 5.
    let session = createDraftSession({
      leagueSize: 2,
      myTeamId: 1,
      rosterSlots: { RB: 1, WR: 1, BENCH: 1 },
      rounds: 3,
    });
    session = applyPicks(session, [
      { overall: 1, teamId: 1, playerName: 'My RB' },
      { overall: 2, teamId: 2, playerName: 'Opp A' },
      { overall: 3, teamId: 2, playerName: 'Opp B' },
      { overall: 4, teamId: 1, playerName: 'My WR' },
      { overall: 5, teamId: 1, playerName: 'My Bench' },
      { overall: 6, teamId: 2, playerName: 'Opp C' },
    ]);

    const result = gradeSession(session, pool);
    expect(result.picks.map((p) => p.playerName)).toEqual(['My RB', 'My WR', 'My Bench']);
    expect(result.starters.missing).toEqual([]); // RB + WR starters both filled
  });
});
