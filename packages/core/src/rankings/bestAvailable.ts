/**
 * Value-Based Drafting recommendation engine. Given the remaining player pool and the live
 * draft state (who's been picked, where you pick next), rank the best players still available
 * — cross-position — by value over replacement, and tag each pick as reach / value / wait.
 *
 * Pure and deterministic: no I/O, no clock. The caller feeds draft state (from manual pick
 * entry or an ESPN snapshot) and gets a ranked board back; feed it again after each pick and
 * the board updates. This is the "best available, live" core behind `/canon draft cheatsheet`.
 *
 * We have ADP + tiers but no point projections, so value is derived from draft cost: a player's
 * "effective ADP" (his ADP, or a round-midpoint estimate from his tier) stands in for value,
 * lower = better. Every metric below is therefore in **ADP-slot** units ("N slots better than
 * the replacement-level player at this position"), which is exactly what VBD compares:
 *
 *   - **VOR**  (Value Over Replacement): value vs. the last startable player at the position
 *     (leagueSize × starting slots, flex shared across RB/WR/TE).
 *   - **VORP** (Value Over Replacement Player): value vs. a deeper, waiver-level baseline
 *     (one extra round past the starter line) — how much better than a bench-depth body.
 *   - **VONA** (Value Over Next Available): value vs. the best player at the same position who
 *     is likely to survive to your *next* pick. High VONA ⇒ the position falls off a cliff
 *     before you pick again ⇒ reach now; low VONA ⇒ a comparable body waits ⇒ you can wait.
 *
 * The board is **sorted by draft value (effective ADP)** — a true "best available" order that
 * already bakes positional scarcity into the market price. VOR/VORP are exposed as diagnostics,
 * but on a partial research board (uneven, ~20 names per position) a position-rank replacement
 * baseline is noisy across positions, so we don't rank by it; VONA (a local, pairwise signal)
 * is what drives the reach/value/wait call.
 */

import type { PlayerTier, Position } from './parse.js';
import { normalizeName } from './parse.js';

export interface DraftPick {
  /** 1-based overall pick number. */
  overall: number;
  teamId: number;
  playerName: string;
}

export interface DraftState {
  leagueSize: number;
  /** Starting-lineup slots, e.g. `{ QB:1, RB:2, WR:2, TE:1, FLEX:1, BENCH:6 }`. */
  rosterSlots: Record<string, number>;
  scoring: 'ppr';
  myTeamId: number;
  /** Picks already made, in any order. */
  picks: DraftPick[];
  /** Team currently on the clock, if known. */
  onTheClock?: number;
  /** Your remaining pick overalls, ascending (e.g. from a snake schedule). */
  myUpcomingOveralls: number[];
}

export type Recommendation = 'reach' | 'value' | 'wait';

export interface Candidate {
  name: string;
  position: Position;
  tier?: number;
  adp?: number;
  vor: number;
  vorp: number;
  vona: number;
  recommend: Recommendation;
  /** Best-first ordering key (higher = better); derived from effective draft cost. */
  score: number;
}

/** Share of FLEX slots each position competes for, when sizing the replacement baseline. */
const FLEX_SHARE: Record<Position, number> = { RB: 0.45, WR: 0.45, TE: 0.1, QB: 0 };

/** A player going later than your current pick by this many slots reads as a "value". */
const VALUE_SLIP = 6;
/** VONA at or above this (a steep positional drop before your next pick) reads as a "reach". */
const REACH_VONA = 18;

/**
 * Effective ADP (lower = better). Uses the player's ADP; when absent, estimates from tier as a
 * round-midpoint (tier 1 ≈ pick 6, tier 2 ≈ pick 18, …). Unknown players sort to the back.
 *
 * Exported so the post-draft grader ({@link gradeRoster}) scores value against the *same* draft-cost
 * scale the board is built on — one source of truth for the tier fallback.
 */
export function effAdp(p: PlayerTier): number {
  if (typeof p.adp === 'number') return p.adp;
  if (typeof p.tier === 'number') return p.tier * 12 - 6;
  return 999;
}

/** Number of starting slots a position claims: its dedicated slots plus its share of FLEX. */
function startingSlots(rosterSlots: Record<string, number>, pos: Position): number {
  const dedicated = rosterSlots[pos] ?? 0;
  const flex = rosterSlots.FLEX ?? rosterSlots.flex ?? 0;
  return dedicated + flex * FLEX_SHARE[pos];
}

/**
 * Rank the available pool best-first by value over replacement. `pool` is the full board;
 * players named in `state.picks` are treated as off the board.
 */
export function bestAvailable(pool: PlayerTier[], state: DraftState): Candidate[] {
  const drafted = new Set(state.picks.map((p) => normalizeName(p.playerName)));
  const currentOverall = state.picks.length + 1;

  // Your current and following picks, for VONA. `following` is when you'd next address a run.
  const upcoming = [...state.myUpcomingOveralls]
    .filter((o) => o >= currentOverall)
    .sort((a, b) => a - b);
  const following = upcoming[1] ?? upcoming[0];

  // Position-scoped, ADP-sorted views of the *full* board — replacement level is a property of
  // the position independent of who's already gone.
  const byPosAll = new Map<Position, PlayerTier[]>();
  for (const p of pool) {
    const list = byPosAll.get(p.position) ?? [];
    list.push(p);
    byPosAll.set(p.position, list);
  }
  for (const list of byPosAll.values()) list.sort((a, b) => effAdp(a) - effAdp(b));

  const replacementEffAdp = (pos: Position, rank: number): number => {
    const list = byPosAll.get(pos) ?? [];
    if (list.length === 0) return state.leagueSize * 16;
    // Clamp to the pool — on a partial board the true replacement-rank player may not be listed,
    // so we anchor on the last name we have rather than extrapolating a runaway baseline.
    const clamped = Math.min(Math.max(rank, 1), list.length);
    return effAdp(list[clamped - 1]);
  };

  const candidates: Candidate[] = [];
  for (const [pos, all] of byPosAll) {
    const startRank = Math.round(state.leagueSize * startingSlots(state.rosterSlots, pos));
    const vorBase = replacementEffAdp(pos, startRank);
    const vorpBase = replacementEffAdp(pos, startRank + state.leagueSize);

    const available = all.filter((p) => !drafted.has(normalizeName(p.name)));

    for (const p of available) {
      const eff = effAdp(p);
      const vor = round1(vorBase - eff);
      const vorp = round1(vorpBase - eff);

      // Best same-position body that survives to your following pick (excluding p itself).
      let vona = 0;
      if (following !== undefined) {
        const survivors = available.filter((q) => q !== p && effAdp(q) >= following);
        const nextEff = survivors.length ? Math.min(...survivors.map(effAdp)) : following + 24; // position gone before you pick again — steep drop.
        vona = round1(nextEff - eff);
      }

      candidates.push({
        name: p.name,
        position: pos,
        tier: p.tier,
        adp: p.adp,
        vor,
        vorp,
        vona,
        recommend: classify(eff, currentOverall, vona),
        // Best available first: lower effective ADP ⇒ higher score.
        score: round1(-eff),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return candidates;
}

function classify(eff: number, currentOverall: number, vona: number): Recommendation {
  if (eff >= currentOverall + VALUE_SLIP) return 'value';
  if (vona >= REACH_VONA) return 'reach';
  return 'wait';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
