/**
 * Deterministic post-draft **grade** for your roster — the reproducible success metric behind the
 * auto-pick loop (#128). ESPN's own mock-draft grade is a generated share *image* with no stable,
 * readable value, so the number we optimize against has to be our own: same picks + same board ⇒
 * same grade, every run, offline, with zero ToS surface.
 *
 * We have ADP + tiers but no point projections, so — exactly as {@link bestAvailable} does — value
 * is derived from **draft cost**. Each pick's value is how far it beat (or trailed) the market:
 *
 *   value = overall − effAdp(player)
 *
 *   - **positive** ⇒ the player fell *past* his ADP and you got him at a discount → a steal;
 *   - **negative** ⇒ you drafted him *ahead* of his ADP → a reach.
 *
 * Per-pick value is clamped (a 60-slot steal and a 15-slot steal are both just "great value", and
 * late-round noise shouldn't swing the grade), then averaged into a `valueScore`. Roster
 * construction is folded in as a penalty: every **starting slot you couldn't fill** drops the
 * composite score. The score maps to a letter through documented, tunable bands (a par-value draft
 * that fills its starters lands around **B**).
 *
 * Caveat, by design: value is only as honest as the ADP in the pool. A player riding a tier
 * *estimate* (no market ADP) is graded against that estimate, not the market — so a rookie the board
 * over-ranks won't register as a reach until his real ADP is merged in. That's the same blind spot
 * the engine has, and it's tracked separately (rookie-TE calibration).
 *
 * Pure and deterministic: no I/O, no clock, no `Date`/`Math.random`. Intended for a **completed**
 * roster (mid-draft it will read unfilled starters as missing).
 */

import { effAdp } from '../rankings/bestAvailable.js';
import { normalizeName, type PlayerTier, type Position } from '../rankings/parse.js';
import { draftOrder, type DraftSession } from './session.js';

/** Roster/starting-slot positions we grade construction against — a superset of the pool's {@link Position}. */
export type SlotPosition = Position | 'K' | 'DST';

/** One of *your* picks, as fed to the grader. */
export interface RosterPick {
  /** 1-based overall pick number. */
  overall: number;
  playerName: string;
  /**
   * Explicit position. Needed for K/DST, which are never on the research board; when omitted it
   * falls back to the player's position in `pool` (so QB/RB/WR/TE resolve automatically).
   */
  position?: SlotPosition;
}

export type PickVerdict = 'steal' | 'value' | 'fair' | 'reach';

export interface GradedPick {
  overall: number;
  playerName: string;
  position?: SlotPosition;
  /** Market ADP used (player's ADP, else tier estimate); undefined when the player isn't on the board (e.g. K/DST). */
  adp?: number;
  /** `overall − adp`, clamped. Positive = fell past ADP (steal); negative = drafted ahead of ADP (reach). Undefined when ungraded. */
  value?: number;
  verdict: PickVerdict;
}

export interface StartersReport {
  /** Starting slots evaluated (K/DST are only counted when the picks carry K/DST positions). */
  required: number;
  filled: number;
  /** Evaluated starting slots your picks couldn't fill, e.g. `['RB']` or `['K']`. */
  missing: string[];
}

export interface RosterGrade {
  /** Letter grade, e.g. `'A-'`. */
  grade: string;
  /** The numeric score behind the letter: `valueScore` minus the construction penalty. */
  score: number;
  /** Mean clamped value-vs-ADP across graded picks, before any construction penalty. */
  valueScore: number;
  /** Every pick, in overall order, with its value and verdict. */
  picks: GradedPick[];
  /** Best-value picks first (positive value only), up to 3. */
  steals: GradedPick[];
  /** Worst reaches first (negative value only), up to 3. */
  reaches: GradedPick[];
  /** Count and mean value per drafted position. */
  byPosition: Record<string, { count: number; avgValue: number }>;
  starters: StartersReport;
  /** Picks with a usable ADP — the denominator of `valueScore`. */
  gradedCount: number;
  notes: string[];
}

/** Cap on a single pick's value so a runaway steal or reach can't dominate the average. */
const VALUE_CLAMP = 30;
/** Value at/above which a pick reads as a steal. */
const STEAL_AT = 12;
/** Value at/above which a pick reads as a (milder) value. */
const VALUE_AT = 4;
/** Value at/below which a pick reads as a reach. */
const REACH_AT = -8;
/** Score dropped per unfilled starting slot — an empty starter is a real grade-killer. */
const MISSING_STARTER_PENALTY = 8;

/** rosterSlots keys that are bench/reserve, not starting slots. */
const BENCH_KEYS = new Set(['BENCH', 'BE', 'IR', 'RESERVE']);
/** Positions that can fill a FLEX slot. */
const FLEX_ELIGIBLE: readonly Position[] = ['RB', 'WR', 'TE'];

/** Score → letter, highest band first. Tunable; a par-value, starters-filled draft lands at `B`. */
const GRADE_BANDS: ReadonlyArray<readonly [number, string]> = [
  [10, 'A+'],
  [6, 'A'],
  [3, 'A-'],
  [1, 'B+'],
  [-1, 'B'],
  [-3, 'B-'],
  [-6, 'C+'],
  [-10, 'C'],
  [-14, 'C-'],
  [-18, 'D'],
  [Number.NEGATIVE_INFINITY, 'F'],
];

function scoreToGrade(score: number): string {
  for (const [threshold, letter] of GRADE_BANDS) if (score >= threshold) return letter;
  return 'F';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Grade a completed roster. `myPicks` are *your* picks only (see {@link gradeSession} to pull them
 * from a live {@link DraftSession}); `pool` is the same board the engine drafted from.
 */
export function gradeRoster(
  myPicks: RosterPick[],
  pool: PlayerTier[],
  config: { rosterSlots: Record<string, number> },
): RosterGrade {
  const byName = new Map<string, PlayerTier>();
  for (const p of pool) {
    const key = normalizeName(p.name);
    if (!byName.has(key)) byName.set(key, p);
  }

  const picks: GradedPick[] = [...myPicks]
    .sort((a, b) => a.overall - b.overall)
    .map((pick) => {
      const player = byName.get(normalizeName(pick.playerName));
      const position = pick.position ?? player?.position;
      // Only players with a real market signal (ADP or tier) get a value; K/DST and unknowns don't.
      const hasMarket =
        player !== undefined && (player.adp !== undefined || player.tier !== undefined);
      const adp = hasMarket ? effAdp(player) : undefined;

      let value: number | undefined;
      let verdict: PickVerdict = 'fair';
      if (adp !== undefined) {
        value = clamp(round1(pick.overall - adp), -VALUE_CLAMP, VALUE_CLAMP);
        verdict =
          value >= STEAL_AT
            ? 'steal'
            : value >= VALUE_AT
              ? 'value'
              : value <= REACH_AT
                ? 'reach'
                : 'fair';
      }

      return {
        overall: pick.overall,
        playerName: pick.playerName,
        position,
        adp: adp !== undefined ? round1(adp) : undefined,
        value,
        verdict,
      };
    });

  const valued = picks.filter((p): p is GradedPick & { value: number } => p.value !== undefined);
  const valueScore = valued.length
    ? round1(valued.reduce((sum, p) => sum + p.value, 0) / valued.length)
    : 0;

  const starters = evaluateStarters(picks, config.rosterSlots);
  const score = round1(valueScore - MISSING_STARTER_PENALTY * starters.missing.length);
  const grade = scoreToGrade(score);

  const steals = valued
    .filter((p) => p.value > 0)
    .sort((a, b) => b.value - a.value || a.overall - b.overall)
    .slice(0, 3);
  const reaches = valued
    .filter((p) => p.value < 0)
    .sort((a, b) => a.value - b.value || a.overall - b.overall)
    .slice(0, 3);

  return {
    grade,
    score,
    valueScore,
    picks,
    steals,
    reaches,
    byPosition: buildByPosition(picks),
    starters,
    gradedCount: valued.length,
    notes: buildNotes(starters, steals, reaches),
  };
}

/**
 * Grade the roster of `session.config.myTeamId` straight from a live session. Picks are matched to
 * you by their snake/linear overall (robust to sources that don't attribute `teamId`). Note: names
 * only — K/DST can't be resolved from the board, so those starting slots aren't evaluated here; use
 * {@link gradeRoster} with explicit `position`s when you have them (e.g. from the ESPN roster panel).
 */
export function gradeSession(session: DraftSession, pool: PlayerTier[]): RosterGrade {
  const { myTeamId, leagueSize, rounds, order, rosterSlots } = session.config;
  const mine = new Set(draftOrder(myTeamId, leagueSize, rounds, order));
  const myPicks: RosterPick[] = session.picks
    .filter((p) => mine.has(p.overall))
    .map((p) => ({ overall: p.overall, playerName: p.playerName }));
  return gradeRoster(myPicks, pool, { rosterSlots });
}

/**
 * Assign picks to starting slots greedily (dedicated slots first, then FLEX from the leftovers) and
 * report what's unfilled. K/DST slots are only evaluated when at least one pick carries a K/DST
 * position — otherwise we're blind to them (they're never on the board) and must not penalize a
 * kicker/defense we simply can't see.
 */
function evaluateStarters(
  picks: GradedPick[],
  rosterSlots: Record<string, number>,
): StartersReport {
  // K and DST are never on the board, so we can only evaluate their slots when a pick actually
  // carries that position — gated independently, so tagging a K doesn't unmask an unseen DST.
  const canSee = (pos: string): boolean => picks.some((p) => p.position === pos);
  const canSeeK = canSee('K');
  const canSeeDST = canSee('DST');

  // Positions are matched case-insensitively: pick positions are uppercase, so normalize slot keys.
  const remaining: Record<string, number> = {};
  for (const p of picks) {
    if (!p.position) continue;
    remaining[p.position] = (remaining[p.position] ?? 0) + 1;
  }

  const slots = Object.entries(rosterSlots).filter(([key]) => {
    const upper = key.toUpperCase();
    if (BENCH_KEYS.has(upper)) return false;
    if (upper === 'K' && !canSeeK) return false;
    if ((upper === 'DST' || upper === 'D/ST') && !canSeeDST) return false;
    return true;
  });

  const missing: string[] = [];
  let required = 0;
  let filled = 0;

  // Dedicated slots before FLEX, so FLEX consumes only what's left over.
  for (const [key, count] of slots) {
    const upper = key.toUpperCase();
    if (upper === 'FLEX') continue;
    const pos = upper === 'D/ST' ? 'DST' : upper;
    required += count;
    const have = remaining[pos] ?? 0;
    const take = Math.min(have, count);
    filled += take;
    remaining[pos] = have - take;
    for (let i = take; i < count; i += 1) missing.push(pos);
  }

  const flex = slots.find(([key]) => key.toUpperCase() === 'FLEX');
  if (flex) {
    const [, count] = flex;
    required += count;
    let need = count;
    for (const pos of FLEX_ELIGIBLE) {
      if (need === 0) break;
      const have = remaining[pos] ?? 0;
      const take = Math.min(have, need);
      filled += take;
      need -= take;
      remaining[pos] = have - take;
    }
    for (let i = 0; i < need; i += 1) missing.push('FLEX');
  }

  return { required, filled, missing };
}

function buildByPosition(picks: GradedPick[]): Record<string, { count: number; avgValue: number }> {
  const acc: Record<string, { count: number; sum: number; graded: number }> = {};
  for (const p of picks) {
    const pos = p.position ?? 'UNK';
    const bucket = (acc[pos] ??= { count: 0, sum: 0, graded: 0 });
    bucket.count += 1;
    if (p.value !== undefined) {
      bucket.sum += p.value;
      bucket.graded += 1;
    }
  }
  const out: Record<string, { count: number; avgValue: number }> = {};
  for (const [pos, b] of Object.entries(acc)) {
    out[pos] = { count: b.count, avgValue: b.graded ? round1(b.sum / b.graded) : 0 };
  }
  return out;
}

function buildNotes(
  starters: StartersReport,
  steals: GradedPick[],
  reaches: GradedPick[],
): string[] {
  const notes: string[] = [];
  if (starters.missing.length) {
    notes.push(
      `Unfilled starting slot${starters.missing.length > 1 ? 's' : ''}: ${starters.missing.join(', ')}`,
    );
  }
  const best = steals[0];
  if (best && best.value !== undefined) {
    notes.push(
      `Best value: ${best.playerName} at ${best.overall} (+${best.value} past ADP ${best.adp})`,
    );
  }
  const worst = reaches[0];
  if (worst && worst.value !== undefined) {
    notes.push(
      `Biggest reach: ${worst.playerName} at ${worst.overall} (${worst.value} vs ADP ${worst.adp})`,
    );
  }
  return notes;
}
