/**
 * Turn an archived fantasy-research report (see `research/*.md`) into a structured draft
 * pool the recommendation engine can consume. Pure and deterministic — no I/O; the caller
 * reads the markdown and passes the string in.
 *
 * The reports are prose-first (written for humans), so rather than NLP-parse the narrative
 * we read an explicit, human-authored **markdown table** the report carries for exactly this
 * purpose: a "Draft board" table of players (and, in the mid-round report, a "Fades" table).
 * Tables are trivially and robustly parseable, stay reviewable in a diff, and keep the prose
 * as the source of truth. A report with no such table simply yields an empty pool — never a
 * throw — so older reports remain safe to feed in.
 *
 * Tables are matched by their header columns, not by their surrounding heading, so the exact
 * section title can drift without breaking parsing:
 *   - a **players** table has a `Player` and a `Pos` column,
 *   - a **fades** table has a `Player` and a `Reason` column.
 */

/** Positions we draft for. DST/K rows in a board table are ignored. */
export type Position = 'QB' | 'RB' | 'WR' | 'TE';

const POSITIONS: readonly Position[] = ['QB', 'RB', 'WR', 'TE'];

export interface PlayerTier {
  name: string;
  position: Position;
  team?: string;
  /** Numeric tier (1 = best) when the board gives one. */
  tier?: number;
  /** Raw tier text when it isn't a bare number (e.g. "Rd 6-7"). */
  tierLabel?: string;
  /** Overall ADP (pick number, 12-team). */
  adp?: number;
  note?: string;
  /** Where this row came from — the report topic or a caller-supplied id (filename). */
  source: string;
}

export interface FadeEntry {
  name: string;
  position: string;
  adp?: number;
  reason: string;
  confidence?: string;
}

export interface RankingsMeta {
  date: string;
  topic: string;
  league: Record<string, unknown>;
}

export interface ParsedRankings {
  players: PlayerTier[];
  fades: FadeEntry[];
  meta: RankingsMeta;
}

interface Table {
  /** Lower-cased header cells, for signature matching. */
  header: string[];
  /** Each row keyed by its lower-cased header cell. */
  rows: Array<Record<string, string>>;
}

/** Split a single `| a | b |` markdown table row into trimmed cells. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** A GitHub table separator row, e.g. `| --- | :--: |`. */
function isSeparatorRow(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

/** Collect every markdown pipe table in the document (header + data rows). */
function findTables(markdown: string): Table[] {
  const lines = markdown.split(/\r?\n/);
  const tables: Table[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;
    // A table needs a header row immediately followed by a separator row.
    const next = lines[i + 1];
    if (next === undefined || !isSeparatorRow(next)) continue;

    const header = splitRow(line).map((c) => c.toLowerCase());
    const rows: Array<Record<string, string>> = [];
    let j = i + 2;
    for (; j < lines.length; j += 1) {
      const rowLine = lines[j];
      if (!rowLine.trim().startsWith('|')) break;
      const cells = splitRow(rowLine);
      const row: Record<string, string> = {};
      header.forEach((key, idx) => {
        row[key] = cells[idx] ?? '';
      });
      rows.push(row);
    }
    tables.push({ header, rows });
    i = j - 1;
  }

  return tables;
}

function headerHas(table: Table, ...needles: string[]): boolean {
  return needles.every((n) => table.header.some((h) => h.includes(n)));
}

/** Parse a number out of a cell like `1.6`, `~44`, `44 / RB20`; undefined if none. */
function parseAdp(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : undefined;
}

function normalizePosition(raw: string | undefined): Position | undefined {
  const up = (raw ?? '').trim().toUpperCase();
  return POSITIONS.includes(up as Position) ? (up as Position) : undefined;
}

/** Parse the leading `---` YAML-ish frontmatter into the bits we need. */
function parseFrontmatter(markdown: string): RankingsMeta {
  const meta: RankingsMeta = { date: '', topic: '', league: {} };
  const fmMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return meta;

  for (const line of fmMatch[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'date') meta.date = value.trim();
    else if (key === 'topic') meta.topic = value.trim();
    else if (key === 'league') meta.league = parseInlineObject(value);
  }
  return meta;
}

/** Parse `{ sport: NFL, size: 12, scoring: full-PPR }` into a record (numbers coerced). */
function parseInlineObject(raw: string): Record<string, unknown> {
  const inner = raw.trim().replace(/^\{/, '').replace(/\}$/, '');
  const out: Record<string, unknown> = {};
  for (const part of inner.split(',')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return out;
}

function cell(row: Record<string, string>, ...names: string[]): string | undefined {
  for (const key of Object.keys(row)) {
    if (names.some((n) => key.includes(n))) {
      const v = row[key].trim();
      if (v) return v;
    }
  }
  return undefined;
}

/**
 * Parse a research report into a structured pool. `source` labels each player row's origin
 * (pass the filename); it defaults to the report's frontmatter topic.
 */
export function parseRankingsReport(markdown: string, source?: string): ParsedRankings {
  const meta = parseFrontmatter(markdown);
  const origin = source ?? meta.topic;
  const tables = findTables(markdown);

  const players: PlayerTier[] = [];
  const fades: FadeEntry[] = [];

  for (const table of tables) {
    if (headerHas(table, 'player', 'reason')) {
      for (const row of table.rows) {
        const name = cell(row, 'player', 'name');
        const reason = cell(row, 'reason');
        if (!name || !reason) continue;
        fades.push({
          name,
          position: cell(row, 'pos') ?? '',
          adp: parseAdp(cell(row, 'adp')),
          reason,
          confidence: cell(row, 'confidence', 'conf'),
        });
      }
    } else if (headerHas(table, 'player', 'pos')) {
      for (const row of table.rows) {
        const name = cell(row, 'player', 'name');
        const position = normalizePosition(cell(row, 'pos'));
        if (!name || !position) continue;
        const tierRaw = cell(row, 'tier');
        const tier = tierRaw && /^\d+$/.test(tierRaw) ? Number(tierRaw) : undefined;
        players.push({
          name,
          position,
          team: cell(row, 'team'),
          tier,
          tierLabel: tierRaw && tier === undefined ? tierRaw : undefined,
          adp: parseAdp(cell(row, 'adp')),
          note: cell(row, 'note'),
          source: origin,
        });
      }
    }
  }

  return { players, fades, meta };
}

/**
 * Merge several parsed reports into one pool. Players are de-duplicated by normalized name;
 * when the same player appears twice, the row with the richer signal wins (a defined tier and
 * the lower ADP), so a later mid-round report can refine a top-board entry. Fades concatenate,
 * de-duplicated by name (first wins).
 */
export function mergeRankings(reports: ParsedRankings[]): {
  players: PlayerTier[];
  fades: FadeEntry[];
} {
  const byName = new Map<string, PlayerTier>();
  for (const report of reports) {
    for (const p of report.players) {
      const key = normalizeName(p.name);
      const existing = byName.get(key);
      byName.set(key, existing ? preferPlayer(existing, p) : p);
    }
  }

  const fadeByName = new Map<string, FadeEntry>();
  for (const report of reports) {
    for (const f of report.fades) {
      const key = normalizeName(f.name);
      if (!fadeByName.has(key)) fadeByName.set(key, f);
    }
  }

  return { players: [...byName.values()], fades: [...fadeByName.values()] };
}

function preferPlayer(a: PlayerTier, b: PlayerTier): PlayerTier {
  const merged: PlayerTier = { ...a };
  if (merged.tier === undefined && b.tier !== undefined) merged.tier = b.tier;
  if (merged.tierLabel === undefined && b.tierLabel !== undefined) merged.tierLabel = b.tierLabel;
  if (b.adp !== undefined && (merged.adp === undefined || b.adp < merged.adp)) merged.adp = b.adp;
  if (!merged.team && b.team) merged.team = b.team;
  if (!merged.note && b.note) merged.note = b.note;
  return merged;
}

/** Normalize a player name for matching: lower-case, drop punctuation and generational suffixes. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}
