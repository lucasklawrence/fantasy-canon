/**
 * Read-only ESPN draft-room capture as a {@link DraftSource}. A {@link DraftRoomReader} reads the
 * live pick-history DOM each tick; this source parses those raw cell strings (reusing core's pure
 * {@link parsePlayerColumn}), accumulates picks by overall so a virtualized/scrolling table never
 * drops one, and hands the board to the poller — exactly like the manual and sink sources.
 *
 * **This never writes to the page.** The reader interface exposes only reads; the Playwright
 * implementation ({@link createPlaywrightReader}) runs a single `page.evaluate` that collects text
 * and returns strings — it calls no `.click()`, fills no input, submits no pick. That is the hard
 * line for Tier B in ADR 0004: observe the board, never make a move on the user's behalf.
 *
 * The seam keeps Playwright at the very edge: everything interesting (which cell is the pick number,
 * badge-stripping, on-the-clock parsing, cross-tick accumulation) is pure and unit-tested against
 * canned DOM text, so only the thin `page.evaluate` selector logic needs a live draft to validate.
 */

import {
  espnRowsToPicks,
  parsePlayerColumn,
  type DraftPick,
  type DraftSnapshot,
  type DraftSource,
  type EspnRawPick,
} from '@fantasy-canon/core';

/** One rendered pick-history row, as raw text pulled from the DOM (nothing interpreted yet). */
export interface RawDomRow {
  /**
   * Overall pick number if the page could read it directly from the row (preferred), else `null`
   * and we fall back to {@link RawDomRow.pickText}.
   */
  overall: number | null;
  /** The pick cell's raw text, e.g. `"R1, P1"` / `"1.01"` / `"12"` — parsed when `overall` is null. */
  pickText: string;
  /** Concatenated player-cell text, e.g. `"Bijan RobinsonATLRB"` (may carry an injury badge). */
  playerText: string;
}

/** Everything one DOM read yields: the currently-rendered rows plus the on-the-clock banner text. */
export interface RawDraftDom {
  rows: RawDomRow[];
  /** The "On the Clock" banner text, e.g. `"On the Clock: Pick 37"`; parsed to a number. */
  onTheClockText?: string;
  /** The page believes the draft has finished (e.g. a "Draft Complete" banner is showing). */
  complete?: boolean;
}

/**
 * The seam between "read the ESPN DOM" and the pure capture logic. Read-only by construction: the
 * only method observes. A test supplies canned {@link RawDraftDom}; Playwright supplies the live one.
 */
export interface DraftRoomReader {
  read(): Promise<RawDraftDom>;
}

/** Pull an overall pick number out of a pick cell's text. Handles the forms ESPN has shown. */
export function parseOverall(pickText: string, leagueSize?: number): number | undefined {
  const text = (pickText ?? '').trim();
  if (!text) return undefined;

  // "R1, P1" / "R1 P1" / "Round 1 Pick 1" → derive overall from round + pick-in-round.
  const rp = text.match(/R(?:ound)?\s*(\d+).*?P(?:ick)?\s*(\d+)/i);
  if (rp && leagueSize && leagueSize > 0) {
    const round = Number(rp[1]);
    const pickInRound = Number(rp[2]);
    if (round > 0 && pickInRound > 0) return (round - 1) * leagueSize + pickInRound;
  }

  // "1.01" / "12.11" decimal form: <round>.<pick-in-round> (pick is zero-padded).
  const dotted = text.match(/^(\d+)\.(\d{1,2})$/);
  if (dotted && leagueSize && leagueSize > 0) {
    const round = Number(dotted[1]);
    const pickInRound = Number(dotted[2]);
    if (round > 0 && pickInRound > 0) return (round - 1) * leagueSize + pickInRound;
  }

  // Plain overall — "Pick 12", "#12", or "12".
  const plain = text.match(/(\d+)/);
  if (plain) {
    const n = Number(plain[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** Pull the on-the-clock overall pick number out of the banner text, if present. */
export function parseOnTheClock(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.match(/(\d+)/);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Turn one DOM read into engine-ready picks: prefer the page's own `overall`, else parse `pickText`
 * (using `leagueSize` for the round.pick forms), strip injury badges via {@link parsePlayerColumn},
 * and drop any row without a usable overall or name. De-dupe/sort is left to {@link espnRowsToPicks}.
 */
export function domToPicks(dom: RawDraftDom, leagueSize?: number): DraftPick[] {
  const raw: EspnRawPick[] = [];
  for (const row of dom.rows) {
    const overall =
      typeof row.overall === 'number' && Number.isFinite(row.overall) && row.overall > 0
        ? row.overall
        : parseOverall(row.pickText, leagueSize);
    if (overall === undefined) continue;
    const { name, nflTeam, position } = parsePlayerColumn(row.playerText);
    if (!name) continue;
    raw.push({ overall, playerName: name, nflTeam, position });
  }
  return espnRowsToPicks(raw);
}

/**
 * A {@link DraftSource} backed by a {@link DraftRoomReader}. Accumulates every pick it has ever seen
 * (keyed by overall, first read wins) so a pick that scrolls out of a virtualized table stays on the
 * board; `poll()` returns the full accumulated snapshot, which the poller diffs idempotently.
 */
export class PlaywrightEspnDraftSource implements DraftSource {
  readonly kind = 'espn-dom';
  private readonly picks = new Map<number, DraftPick>();
  private onTheClock?: number;
  private complete = false;

  constructor(
    private readonly reader: DraftRoomReader,
    private readonly leagueSize?: number,
  ) {}

  async poll(): Promise<DraftSnapshot> {
    const dom = await this.reader.read();
    for (const pick of domToPicks(dom, this.leagueSize)) {
      if (!this.picks.has(pick.overall)) this.picks.set(pick.overall, pick);
    }
    const otc = parseOnTheClock(dom.onTheClockText);
    if (otc !== undefined) this.onTheClock = otc;
    if (dom.complete) this.complete = true;

    return {
      picks: [...this.picks.values()].sort((a, b) => a.overall - b.overall),
      onTheClock: this.onTheClock,
      complete: this.complete || undefined,
    };
  }
}
