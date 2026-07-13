import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseRankingsReport, mergeRankings, normalizeName } from '../parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const researchDir = path.resolve(here, '../../../../../research');
const read = (file: string): string => readFileSync(path.join(researchDir, file), 'utf8');

const TOP_BOARD = '2026-07-12-2026-redraft-ppr-rankings.md';
const MID_ROUND = '2026-07-12-2026-midround-tiers-rookies-fades.md';

describe('parseRankingsReport', () => {
  it('parses frontmatter meta from a real report', () => {
    const { meta } = parseRankingsReport(read(TOP_BOARD));
    expect(meta.date).toBe('2026-07-12');
    expect(meta.topic).toMatch(/top board/i);
    expect(meta.league.size).toBe(12);
    expect(meta.league.scoring).toBe('full-PPR');
  });

  it('extracts the derived draft board as typed players', () => {
    const { players } = parseRankingsReport(read(TOP_BOARD), TOP_BOARD);
    const bijan = players.find((p) => p.name === 'Bijan Robinson');
    expect(bijan).toMatchObject({
      position: 'RB',
      team: 'ATL',
      tier: 1,
      adp: 1.6,
      source: TOP_BOARD,
    });
    // Every parsed player has a supported position and a source stamp.
    expect(players.length).toBeGreaterThan(20);
    expect(players.every((p) => ['QB', 'RB', 'WR', 'TE'].includes(p.position))).toBe(true);
    expect(players.every((p) => p.source === TOP_BOARD)).toBe(true);
    // Positions from the section come through — a QB and a TE are present.
    expect(players.some((p) => p.position === 'QB' && p.name === 'Josh Allen')).toBe(true);
    expect(players.some((p) => p.position === 'TE' && p.name === 'Trey McBride')).toBe(true);
  });

  it('leaves an empty team cell undefined rather than a blank string', () => {
    const { players } = parseRankingsReport(read(TOP_BOARD));
    const warren = players.find((p) => p.name === 'Tyler Warren');
    expect(warren?.team).toBeUndefined();
  });

  it('defaults source to the report topic when none is given', () => {
    const { players, meta } = parseRankingsReport(read(TOP_BOARD));
    expect(players[0]?.source).toBe(meta.topic);
  });

  it('parses the fades table with confidence and reason', () => {
    const { fades } = parseRankingsReport(read(MID_ROUND));
    const irving = fades.find((f) => f.name === 'Bucky Irving');
    expect(irving).toMatchObject({ position: 'RB', adp: 44, confidence: 'high' });
    expect(irving?.reason).toMatch(/goal-line/i);
    expect(fades.some((f) => f.confidence === 'medium')).toBe(true);
  });

  it('does not surface a fades table as players (and vice-versa)', () => {
    const { players, fades } = parseRankingsReport(read(TOP_BOARD));
    // The top-board report has no fades table.
    expect(fades).toHaveLength(0);
    expect(players.length).toBeGreaterThan(0);
  });

  it('returns empty pools but valid meta when there is no board table', () => {
    const md = [
      '---',
      'date: 2026-01-01',
      'topic: nothing',
      '---',
      '',
      '# Prose only',
      'no tables here',
    ].join('\n');
    const parsed = parseRankingsReport(md);
    expect(parsed.players).toHaveLength(0);
    expect(parsed.fades).toHaveLength(0);
    expect(parsed.meta.date).toBe('2026-01-01');
  });

  it('parses ADP out of noisy cells', () => {
    const md = [
      '| Player | Pos | ADP |',
      '| --- | --- | --- |',
      '| Tilde Guy | RB | ~44 |',
      '| Slash Guy | WR | 23 / WR8 |',
      '| No Adp | TE | |',
    ].join('\n');
    const { players } = parseRankingsReport(md);
    expect(players.find((p) => p.name === 'Tilde Guy')?.adp).toBe(44);
    expect(players.find((p) => p.name === 'Slash Guy')?.adp).toBe(23);
    expect(players.find((p) => p.name === 'No Adp')?.adp).toBeUndefined();
  });
});

describe('mergeRankings', () => {
  it('combines both real reports into one de-duplicated pool', () => {
    const top = parseRankingsReport(read(TOP_BOARD), TOP_BOARD);
    const mid = parseRankingsReport(read(MID_ROUND), MID_ROUND);
    const { players, fades } = mergeRankings([top, mid]);
    expect(players.some((p) => p.name === 'Bijan Robinson')).toBe(true);
    expect(players.some((p) => p.name === 'Jeremiyah Love')).toBe(true);
    expect(fades.length).toBe(mid.fades.length);
    // No two players share a normalized name.
    const keys = players.map((p) => normalizeName(p.name));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('prefers the richer row (defined tier, lower ADP) on a duplicate name', () => {
    const a = parseRankingsReport(
      [
        '| Player | Pos | Tier | ADP |',
        '| --- | --- | --- | --- |',
        '| Some Back | RB | | 30 |',
      ].join('\n'),
    );
    const b = parseRankingsReport(
      [
        '| Player | Pos | Tier | ADP |',
        '| --- | --- | --- | --- |',
        '| Some Back | RB | 3 | 22 |',
      ].join('\n'),
    );
    const { players } = mergeRankings([a, b]);
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({ tier: 3, adp: 22 });
  });
});

describe('normalizeName', () => {
  it('drops punctuation and generational suffixes', () => {
    expect(normalizeName('James Cook III')).toBe('jamescook');
    expect(normalizeName('A.J. Brown')).toBe('ajbrown');
    expect(normalizeName("De'Von Achane")).toBe('devonachane');
  });
});
