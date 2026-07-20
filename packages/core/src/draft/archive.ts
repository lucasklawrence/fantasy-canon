/**
 * Draft-archive formatting (#138): turn a graded mock-draft roster into the markdown we commit
 * under `drafts/` — one dated file per draft plus a one-line `INDEX.md` row — so strategies
 * (ESPN autopick vs. our engine vs. manual) can be A/B'd over time. Mirrors the `research/`
 * archive.
 *
 * Pure: strings in, strings out — no filesystem, no clock. The CLI (`scripts/archive-draft.ts`)
 * does the I/O: loads the pool, grades via {@link gradeRoster}, then calls these builders and
 * writes the files. Each entry carries a machine-readable summary comment so
 * {@link compareDraftEntries} can diff drafts without re-parsing prose.
 */
import type { DraftOrder } from './session.js';
import type { GradedPick, RosterGrade } from './gradeRoster.js';

/** How the roster was produced — the axis we're comparing. */
export type DraftSourceLabel = 'espn-autopick' | 'engine' | 'manual';

export interface DraftLeagueSettings {
  size: number;
  /** Free text, e.g. `full-PPR`. */
  scoring: string;
  type: DraftOrder;
  season: number;
}

/** Everything about a draft except the picks themselves. */
export interface DraftArchiveMeta {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  source: DraftSourceLabel;
  /** ESPN mock league id (or a free-form label for non-ESPN drafts). */
  leagueId: string;
  /** Our team name in that mock. */
  team: string;
  /** Our 1-based draft slot. */
  slot: number;
  settings: DraftLeagueSettings;
  /** Provenance of the board the grade was computed against, e.g. the research `latestDate`. */
  boardAsOf?: string;
}

/** The compact, machine-readable snapshot embedded in each entry and read back by compare. */
export interface DraftArchiveSummary {
  date: string;
  source: DraftSourceLabel;
  team: string;
  slot: number;
  leagueId: string;
  grade: string;
  score: number;
  valueScore: number;
  gradedCount: number;
  /** Drafted count per position, e.g. `{ QB: 2, RB: 4, WR: 5, TE: 2, K: 1, DST: 1 }`. */
  positions: Record<string, number>;
}

const SUMMARY_MARKER = 'draft-archive-summary';

/** `YYYY-MM-DD-<source>-<leagueId>.md` — stable, sortable, one per mock. */
export function draftArchiveFilename(meta: DraftArchiveMeta): string {
  const league = meta.leagueId.replace(/[^a-zA-Z0-9_-]/g, '');
  return `${meta.date}-${meta.source}-${league}.md`;
}

/** The round a 1-based overall pick lands in for a league of `size`. */
function roundOf(overall: number, size: number): number {
  return Math.ceil(overall / size);
}

function fmtValue(pick: GradedPick): string {
  if (pick.value === undefined) return '—';
  const sign = pick.value > 0 ? '+' : '';
  return `${sign}${pick.value}`;
}

/** Escape free text for a markdown table cell — a literal `|` would break the column layout. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function positionCounts(grade: RosterGrade): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [pos, { count }] of Object.entries(grade.byPosition)) counts[pos] = count;
  return counts;
}

/** Build the {@link DraftArchiveSummary} for an entry — the source of truth for compare. */
export function buildDraftArchiveSummary(
  meta: DraftArchiveMeta,
  grade: RosterGrade,
): DraftArchiveSummary {
  return {
    date: meta.date,
    source: meta.source,
    team: meta.team,
    slot: meta.slot,
    leagueId: meta.leagueId,
    grade: grade.grade,
    score: grade.score,
    valueScore: grade.valueScore,
    gradedCount: grade.gradedCount,
    positions: positionCounts(grade),
  };
}

/** The full per-draft markdown document. */
export function buildDraftArchiveMarkdown(meta: DraftArchiveMeta, grade: RosterGrade): string {
  const summary = buildDraftArchiveSummary(meta, grade);
  const posLine = Object.entries(summary.positions)
    .map(([pos, n]) => `${pos} ${n}`)
    .join(' · ');

  const rosterRows = grade.picks
    .slice()
    .sort((a, b) => a.overall - b.overall)
    .map((p) => {
      const round = roundOf(p.overall, meta.settings.size);
      const adp = p.adp === undefined ? '—' : String(p.adp);
      return `| ${round} | ${p.overall} | ${cell(p.playerName)} | ${p.position ?? '—'} | ${adp} | ${fmtValue(p)} | ${p.verdict} |`;
    });

  const stealLines = grade.steals.length
    ? grade.steals.map((p) => `- **${p.playerName}** (${fmtValue(p)} vs ADP) — ${p.verdict}`)
    : ['- none'];
  const reachLines = grade.reaches.length
    ? grade.reaches.map((p) => `- **${p.playerName}** (${fmtValue(p)} vs ADP) — ${p.verdict}`)
    : ['- none'];

  const starters = grade.starters;
  const startersLine =
    starters.missing.length === 0
      ? `${starters.filled}/${starters.required} starting slots filled`
      : `${starters.filled}/${starters.required} filled — missing ${starters.missing.join(', ')}`;

  const notes = grade.notes.length ? grade.notes.map((n) => `- ${n}`).join('\n') : '- none';

  return [
    `<!-- ${SUMMARY_MARKER}: ${JSON.stringify(summary)} -->`,
    '',
    `# ${meta.team} — ${meta.date} draft`,
    `_${meta.settings.size}-team ${meta.settings.type} · ${meta.settings.scoring} · slot ${meta.slot} · ${meta.source}_`,
    '',
    '## Grade',
    `**${grade.grade}** (score ${grade.score}, value ${grade.valueScore} over ${grade.gradedCount} graded picks)`,
    '',
    `- Positional balance: ${posLine}`,
    `- Starters: ${startersLine}`,
    `- League: id \`${meta.leagueId}\` · season ${meta.settings.season}${
      meta.boardAsOf ? ` · board as-of ${meta.boardAsOf}` : ''
    }`,
    '',
    '## Roster by round',
    '',
    '| Rd | Overall | Player | Pos | ADP | Value | Verdict |',
    '| -- | ------- | ------ | --- | --- | ----- | ------- |',
    ...rosterRows,
    '',
    '## Steals',
    ...stealLines,
    '',
    '## Reaches',
    ...reachLines,
    '',
    '## Notes',
    notes,
    '',
  ].join('\n');
}

/** Read the embedded summary back out of an entry's markdown (returns undefined if absent/corrupt). */
export function parseDraftArchiveSummary(markdown: string): DraftArchiveSummary | undefined {
  const match = new RegExp(`<!--\\s*${SUMMARY_MARKER}:\\s*(\\{.*?\\})\\s*-->`).exec(markdown);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as DraftArchiveSummary;
  } catch {
    return undefined;
  }
}

const INDEX_HEADER = [
  '# Draft Archive',
  '',
  'Every mock draft we run, archived to compare strategies (ESPN autopick vs. our engine vs.',
  'manual) over time. Newest at the top. Add entries with `pnpm archive:draft`.',
  '',
  '| Date | Source | Team | Slot | Grade | Value | Steals | Report |',
  '| ---- | ------ | ---- | ---- | ----- | ----- | ------ | ------ |',
];

/** The one-line INDEX row for an entry, linking to its file. */
export function buildDraftIndexRow(
  meta: DraftArchiveMeta,
  grade: RosterGrade,
  filename: string,
): string {
  const steals = grade.steals.length ? grade.steals.map((p) => p.playerName).join(', ') : '—';
  return `| ${meta.date} | ${meta.source} | ${cell(meta.team)} | ${meta.slot} | ${grade.grade} | ${grade.valueScore} | ${cell(steals)} | [report](${filename}) |`;
}

/**
 * Insert (or replace) an entry's row in `INDEX.md`, keeping rows sorted newest-date-first and
 * de-duplicated by filename (re-archiving a draft replaces its row). Rebuilds from a canonical
 * header, so a missing/blank index is created fresh.
 */
export function upsertDraftIndex(
  existingIndex: string,
  meta: DraftArchiveMeta,
  grade: RosterGrade,
  filename: string,
): string {
  const linkRe = /\[report\]\(([^)]+)\)/;
  const rows: { date: string; file: string; row: string }[] = [];
  for (const line of existingIndex.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const link = linkRe.exec(trimmed);
    if (!link) continue; // header/separator rows have no [report](...) link
    const date = trimmed.split('|')[1]?.trim() ?? '';
    rows.push({ date, file: link[1], row: trimmed });
  }

  const newRow = buildDraftIndexRow(meta, grade, filename);
  const kept = rows.filter((r) => r.file !== filename);
  kept.push({ date: meta.date, file: filename, row: newRow });
  // Newest date first; ties broken by filename for determinism.
  kept.sort((a, b) =>
    a.date === b.date ? a.file.localeCompare(b.file) : b.date.localeCompare(a.date),
  );

  return `${[...INDEX_HEADER, ...kept.map((r) => r.row)].join('\n')}\n`;
}

/** Cross-draft comparison table + a grade-over-time line. Pure; feed it parsed summaries. */
export function compareDraftEntries(summaries: DraftArchiveSummary[]): string {
  if (summaries.length === 0) return 'No drafts archived yet.';

  const ordered = summaries
    .slice()
    .sort((a, b) =>
      a.date === b.date ? a.source.localeCompare(b.source) : a.date.localeCompare(b.date),
    );
  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

  const header = `| Date | Source | Team | Slot | Grade | Value | ${positions.join(' | ')} |`;
  const sep = `| ---- | ------ | ---- | ---- | ----- | ----- | ${positions.map(() => '--').join(' | ')} |`;
  const rows = ordered.map((s) => {
    const posCells = positions.map((p) => String(s.positions[p] ?? 0)).join(' | ');
    return `| ${s.date} | ${s.source} | ${cell(s.team)} | ${s.slot} | ${s.grade} | ${s.valueScore} | ${posCells} |`;
  });

  const trend = ordered
    .map((s) => `${s.date} ${s.source} ${s.grade} (${s.valueScore})`)
    .join('  →  ');

  return [
    `# Draft comparison (${ordered.length} draft${ordered.length === 1 ? '' : 's'})`,
    '',
    header,
    sep,
    ...rows,
    '',
    `**Grade over time:** ${trend}`,
    '',
  ].join('\n');
}
