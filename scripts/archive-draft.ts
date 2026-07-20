/**
 * Draft-archive CLI (#138) — snapshot a mock-draft roster to `drafts/` so strategies can be
 * A/B'd over time. Mirrors how `research/` is populated out-of-band (not from the running bot).
 *
 *   pnpm archive:draft -- add \
 *     --date 2026-07-12 --source espn-autopick --team "Lucas's Loud Team" \
 *     --slot 7 --league 79246808 --season 2026 \
 *     --players "Amon-Ra St. Brown, Saquon Barkley, …, Eddy Pineiro:K, …"
 *
 *   pnpm archive:draft -- compare
 *
 * Grades against the committed research boards only (no network), so a committed entry is
 * reproducible from repo state. Players are given in draft order (round 1..N); K/DST need an
 * explicit `Name:POS` since they're never on the research board. Pure formatting/grade logic lives
 * in `@fantasy-canon/core`; this script only does argv + filesystem.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDraftArchiveMarkdown,
  compareDraftEntries,
  draftArchiveFilename,
  draftOrder,
  gradeRoster,
  mergeRankings,
  parseDraftArchiveSummary,
  parseRankingsReport,
  upsertDraftIndex,
  type DraftArchiveMeta,
  type DraftArchiveSummary,
  type DraftSourceLabel,
  type PlayerTier,
  type RosterPick,
  type SlotPosition,
} from '../packages/core/src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEARCH_DIR = path.join(REPO_ROOT, 'research');
const DRAFTS_DIR = path.join(REPO_ROOT, 'drafts');
const INDEX_FILE = path.join(DRAFTS_DIR, 'INDEX.md');

/** Standard 12-team league starting lineup + bench (matches the bot's `ROSTER_SLOTS`). */
const ROSTER_SLOTS: Record<string, number> = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  K: 1,
  DST: 1,
  BENCH: 6,
};

const SOURCES: DraftSourceLabel[] = ['espn-autopick', 'engine', 'manual'];
const EXPLICIT_POSITIONS = new Set<SlotPosition>(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);

function fail(message: string): never {
  console.error(`archive-draft: ${message}`);
  process.exit(1);
}

function parseArgs(rawArgv: string[]): { command: string; flags: Record<string, string> } {
  // `pnpm archive:draft -- add …` leaves a bare `--` separator token; drop it.
  const argv = rawArgv.filter((a) => a !== '--');
  const [command = 'add', ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[(i += 1)] : 'true';
    flags[key] = value;
  }
  return { command, flags };
}

/** Build the draft pool from committed research boards — pure parse, no network, reproducible. */
function loadResearchPool(): { players: PlayerTier[]; latestDate: string } {
  if (!existsSync(RESEARCH_DIR)) return { players: [], latestDate: '' };
  const parsed = readdirSync(RESEARCH_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'TEMPLATE.md' && f !== 'INDEX.md')
    .sort()
    .map((f) => parseRankingsReport(readFileSync(path.join(RESEARCH_DIR, f), 'utf8'), f))
    .filter((p) => p.players.length > 0);
  const merged = mergeRankings(parsed);
  const latestDate =
    parsed
      .map((p) => p.meta.date)
      .filter(Boolean)
      .sort()
      .at(-1) ?? '';
  return { players: merged.players, latestDate };
}

/** Parse `"Name, Name:POS, …"` (draft order) into RosterPicks, assigning overalls from the slot. */
function parseRoster(spec: string, slot: number, size: number): RosterPick[] {
  const names = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) fail('--players is empty');
  const overalls = draftOrder(slot, size, names.length, 'snake');
  return names.map((entry, i) => {
    const cut = entry.lastIndexOf(':');
    if (cut === -1) return { overall: overalls[i], playerName: entry };
    const playerName = entry.slice(0, cut).trim();
    const pos = entry
      .slice(cut + 1)
      .trim()
      .toUpperCase() as SlotPosition;
    if (!EXPLICIT_POSITIONS.has(pos)) fail(`"${entry}": unknown position "${pos}"`);
    return { overall: overalls[i], playerName, position: pos };
  });
}

function runAdd(flags: Record<string, string>): void {
  const required = ['date', 'source', 'team', 'slot', 'league', 'players'];
  for (const key of required) if (!flags[key]) fail(`missing --${key}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.date))
    fail(`--date must be YYYY-MM-DD (got "${flags.date}")`);
  const source = flags.source as DraftSourceLabel;
  if (!SOURCES.includes(source)) fail(`--source must be one of ${SOURCES.join(' | ')}`);
  const size = Number(flags.size ?? '12');
  const season = Number(flags.season ?? '2026');
  const slot = Number(flags.slot);
  if (!Number.isInteger(size) || size < 2)
    fail(`--size must be an integer ≥ 2 (got "${flags.size}")`);
  if (!Number.isInteger(season) || season < 2000)
    fail(`--season must be a 4-digit year (got "${flags.season}")`);
  if (!Number.isInteger(slot) || slot < 1 || slot > size)
    fail(`--slot ${flags.slot} out of range for a ${size}-team league`);

  const { players, latestDate } = loadResearchPool();
  if (players.length === 0)
    console.warn('archive-draft: no research boards found — grade will be board-less.');

  const roster = parseRoster(flags.players, slot, size);
  const grade = gradeRoster(roster, players, { rosterSlots: ROSTER_SLOTS });

  const meta: DraftArchiveMeta = {
    date: flags.date,
    source,
    leagueId: flags.league,
    team: flags.team,
    slot,
    settings: { size, scoring: flags.scoring ?? 'full-PPR', type: 'snake', season },
    boardAsOf: latestDate || undefined,
  };

  const filename = draftArchiveFilename(meta);
  const markdown = buildDraftArchiveMarkdown(meta, grade);
  if (!existsSync(DRAFTS_DIR)) mkdirSync(DRAFTS_DIR, { recursive: true });
  writeFileSync(path.join(DRAFTS_DIR, filename), markdown, 'utf8');

  const existingIndex = existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, 'utf8') : '';
  writeFileSync(INDEX_FILE, upsertDraftIndex(existingIndex, meta, grade, filename), 'utf8');

  console.log(`archived drafts/${filename} — grade ${grade.grade} (value ${grade.valueScore})`);
  if (grade.notes.length) console.log(`notes: ${grade.notes.join('; ')}`);
}

function runCompare(): void {
  if (!existsSync(DRAFTS_DIR)) fail('no drafts/ directory yet');
  const summaries: DraftArchiveSummary[] = readdirSync(DRAFTS_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'TEMPLATE.md')
    .map((f) => parseDraftArchiveSummary(readFileSync(path.join(DRAFTS_DIR, f), 'utf8')))
    .filter((s): s is DraftArchiveSummary => s !== undefined);
  console.log(compareDraftEntries(summaries));
}

function main(): void {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'add') runAdd(flags);
  else if (command === 'compare') runCompare();
  else fail(`unknown command "${command}" (expected "add" or "compare")`);
}

main();
