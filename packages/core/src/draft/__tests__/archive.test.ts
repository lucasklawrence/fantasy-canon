import {
  buildDraftArchiveMarkdown,
  buildDraftArchiveSummary,
  buildDraftIndexRow,
  compareDraftEntries,
  draftArchiveFilename,
  parseDraftArchiveSummary,
  upsertDraftIndex,
  type DraftArchiveMeta,
} from '../archive.js';
import { gradeRoster, type RosterGrade } from '../gradeRoster.js';
import type { PlayerTier } from '../../rankings/parse.js';

const META: DraftArchiveMeta = {
  date: '2026-07-12',
  source: 'espn-autopick',
  leagueId: '79246808',
  team: "Lucas's Loud Team",
  slot: 7,
  settings: { size: 12, scoring: 'full-PPR', type: 'snake', season: 2026 },
  boardAsOf: '2026-07-12',
};

const POOL: PlayerTier[] = [
  { name: 'Amon-Ra St. Brown', position: 'WR', adp: 5, source: 't' },
  { name: 'Saquon Barkley', position: 'RB', adp: 3, source: 't' },
  { name: 'Tee Higgins', position: 'WR', adp: 40, source: 't' },
  { name: 'Brock Purdy', position: 'QB', adp: 95, source: 't' },
];

function sampleGrade(): RosterGrade {
  return gradeRoster(
    [
      { overall: 7, playerName: 'Amon-Ra St. Brown' },
      { overall: 18, playerName: 'Saquon Barkley' },
      { overall: 31, playerName: 'Tee Higgins' },
      { overall: 42, playerName: 'Brock Purdy' },
      { overall: 55, playerName: 'Seahawks D/ST', position: 'DST' },
      { overall: 66, playerName: 'Eddy Pineiro', position: 'K' },
    ],
    POOL,
    { rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 } },
  );
}

describe('draftArchiveFilename', () => {
  it('is date-source-league and strips unsafe chars', () => {
    expect(draftArchiveFilename(META)).toBe('2026-07-12-espn-autopick-79246808.md');
    expect(draftArchiveFilename({ ...META, leagueId: 'my league/1' })).toBe(
      '2026-07-12-espn-autopick-myleague1.md',
    );
  });
});

describe('buildDraftArchiveMarkdown', () => {
  const md = buildDraftArchiveMarkdown(META, sampleGrade());

  it('renders the header, grade, and a roster row per pick in overall order', () => {
    expect(md).toContain("# Lucas's Loud Team — 2026-07-12 draft");
    expect(md).toContain('12-team snake · full-PPR · slot 7 · espn-autopick');
    // 6 picks → 6 data rows in the roster table.
    const rosterRows = md.split('\n').filter((l) => /^\| \d+ \| \d+ \|/.test(l));
    expect(rosterRows).toHaveLength(6);
    // Round derives from overall: pick 18 in a 12-team league is round 2.
    expect(md).toContain('| 2 | 18 | Saquon Barkley |');
  });

  it('embeds a round-trippable summary comment', () => {
    const parsed = parseDraftArchiveSummary(md);
    expect(parsed).toEqual(buildDraftArchiveSummary(META, sampleGrade()));
    expect(parsed?.positions.WR).toBe(2);
    expect(parsed?.grade).toBe(sampleGrade().grade);
  });

  it('uses an h1 title then an emphasized subtitle (no heading-level skip)', () => {
    expect(md).toContain("# Lucas's Loud Team — 2026-07-12 draft");
    expect(md).not.toContain('### 12-team');
    expect(md).toContain('_12-team snake · full-PPR · slot 7 · espn-autopick_');
  });

  it('escapes pipes in player names so a stray "|" cannot break the table', () => {
    const grade = gradeRoster(
      [{ overall: 7, playerName: 'A | B', position: 'WR' }],
      [{ name: 'A | B', position: 'WR', adp: 5, source: 't' }],
      { rosterSlots: { WR: 1, BENCH: 1 } },
    );
    const out = buildDraftArchiveMarkdown(META, grade);
    expect(out).toContain('A \\| B');
    // Every roster data row still has exactly the 7 columns' worth of unescaped pipes.
    const dataRow = out.split('\n').find((l) => /^\| \d+ \| \d+ \|/.test(l)) ?? '';
    expect(dataRow.replace(/\\\|/g, '').match(/\|/g)).toHaveLength(8);
  });
});

describe('parseDraftArchiveSummary', () => {
  it('returns undefined when the marker is absent or corrupt', () => {
    expect(parseDraftArchiveSummary('# just a doc')).toBeUndefined();
    expect(parseDraftArchiveSummary('<!-- draft-archive-summary: {oops -->')).toBeUndefined();
  });
});

describe('upsertDraftIndex', () => {
  const file = draftArchiveFilename(META);
  const grade = sampleGrade();

  it('creates a fresh index from a blank string with a header + one row', () => {
    const out = upsertDraftIndex('', META, grade, file);
    expect(out).toContain('# Draft Archive');
    expect(out).toContain('| Date | Source | Team | Slot | Grade | Value | Steals | Report |');
    expect(out).toContain(`[report](${file})`);
    expect(out.trim().endsWith('|')).toBe(true);
  });

  it('replaces the row for a re-archived file rather than duplicating it', () => {
    const first = upsertDraftIndex('', META, grade, file);
    const second = upsertDraftIndex(first, { ...META, team: 'Renamed' }, grade, file);
    const rows = second.split('\n').filter((l) => l.includes(`[report](${file})`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('Renamed');
  });

  it('keeps rows sorted newest-date-first', () => {
    const older = upsertDraftIndex('', META, grade, file);
    const newerMeta: DraftArchiveMeta = { ...META, date: '2026-08-01', leagueId: '999' };
    const newerFile = draftArchiveFilename(newerMeta);
    const out = upsertDraftIndex(older, newerMeta, grade, newerFile);
    const dataRows = out.split('\n').filter((l) => l.includes('[report]('));
    expect(dataRows[0]).toContain('2026-08-01');
    expect(dataRows[1]).toContain('2026-07-12');
  });
});

describe('compareDraftEntries', () => {
  it('summarises across drafts with a positional table and a trend line', () => {
    const a = buildDraftArchiveSummary(META, sampleGrade());
    const b = buildDraftArchiveSummary(
      { ...META, date: '2026-08-01', source: 'engine' },
      sampleGrade(),
    );
    const out = compareDraftEntries([b, a]);
    expect(out).toContain('# Draft comparison (2 drafts)');
    expect(out).toContain('QB | RB | WR | TE | K | DST');
    expect(out).toContain('**Grade over time:**');
    // Ordered oldest→newest in the trend regardless of input order.
    expect(out.indexOf('2026-07-12')).toBeLessThan(out.indexOf('2026-08-01'));
  });

  it('handles the empty case', () => {
    expect(compareDraftEntries([])).toBe('No drafts archived yet.');
  });
});

describe('buildDraftIndexRow', () => {
  it('links to the report file and shows the letter grade', () => {
    const row = buildDraftIndexRow(META, sampleGrade(), 'x.md');
    expect(row).toContain('[report](x.md)');
    expect(row).toContain(`| ${sampleGrade().grade} |`);
  });
});
