/**
 * Lights up the four data-dependent weekly trophies. The core trophies engine
 * (`computeWeeklyTrophies`) emits Overachiever/Underachiever and Best/Worst Manager only
 * when handed a `TrophyExtras` — a per-team projected-points map and a per-team
 * optimal-lineup-% map. This module builds both from one `mBoxscore` scoring period.
 *
 * `mBoxscore` (not `mScoreboard`, which the command uses for matchups) is required because
 * only it carries per-player `stats` with the projected line (`statSourceId: 1`) and the
 * roster needed for lineup efficiency:
 *   schedule[].{home,away}.{teamId, rosterForCurrentScoringPeriod.entries[]}
 *     entry.lineupSlotId / playerId / playerPoolEntry.{appliedStatTotal, player.{eligibleSlots, stats[]}}
 *
 * Optimal-lineup % reuses `parseStarterSlots` + `computeLineupEfficiency` from the
 * /canon lineup work, so the Best/Worst Manager numbers match that command by construction.
 */

import { computeLineupEfficiency, type LineupPlayer, type StarterSlot } from '@fantasy-canon/core';
import { BENCH_SLOT_ID, IR_SLOT_ID } from './lineupEfficiency.js';

/** The extras shape consumed by `computeWeeklyTrophies`. */
export interface TrophyExtras {
  /** Projected points per teamId — enables Overachiever / Underachiever. */
  projected?: ReadonlyMap<number, number>;
  /** Optimal-lineup % (0..1) per teamId — enables Best / Worst Manager. */
  optimalPct?: ReadonlyMap<number, number>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Projected fantasy points for one roster entry in the given scoring period, or `undefined`
 * if ESPN didn't return a projection. Projections are the `statSourceId: 1` (vs `0` =
 * actual), `statSplitTypeId: 1` (single week) stat for that period.
 */
function projectedPoints(
  entry: Record<string, unknown>,
  scoringPeriodId: number,
): number | undefined {
  const player = asRecord(asRecord(entry.playerPoolEntry)?.player);
  const stats = player?.stats;
  if (!Array.isArray(stats)) return undefined;
  for (const stat of stats) {
    const s = asRecord(stat);
    if (!s) continue;
    if (
      asNumber(s.statSourceId) === 1 &&
      asNumber(s.statSplitTypeId) === 1 &&
      asNumber(s.scoringPeriodId) === scoringPeriodId
    ) {
      return asNumber(s.appliedTotal);
    }
  }
  return undefined;
}

interface SideExtras {
  teamId: number;
  /** Sum of started players' projected points; undefined if any starter lacked one. */
  projected?: number;
  optimalPct: number;
}

function parseSide(
  side: unknown,
  starterSlots: StarterSlot[],
  scoringPeriodId: number,
): SideExtras | undefined {
  const s = asRecord(side);
  if (!s) return undefined;
  const teamId = asNumber(s.teamId);
  const entries = asRecord(s.rosterForCurrentScoringPeriod)?.entries;
  if (teamId === undefined || !Array.isArray(entries)) return undefined;

  const players: LineupPlayer[] = [];
  let projectedTotal = 0;
  let projectedComplete = true;
  for (const entry of entries) {
    const e = asRecord(entry);
    if (!e) continue;
    const lineupSlotId = asNumber(e.lineupSlotId);
    const playerId = asNumber(e.playerId);
    const pool = asRecord(e.playerPoolEntry);
    const player = asRecord(pool?.player);
    if (lineupSlotId === undefined || playerId === undefined || !player) continue;

    const eligibleSlots = (Array.isArray(player.eligibleSlots) ? player.eligibleSlots : [])
      .map((v) => asNumber(v))
      .filter((v): v is number => v !== undefined);
    const started = lineupSlotId !== BENCH_SLOT_ID && lineupSlotId !== IR_SLOT_ID;

    players.push({
      playerId,
      points: asNumber(pool?.appliedStatTotal) ?? 0,
      eligibleSlots,
      started,
    });

    if (started) {
      const proj = projectedPoints(e, scoringPeriodId);
      if (proj === undefined) projectedComplete = false;
      else projectedTotal += proj;
    }
  }

  const eff = computeLineupEfficiency(players, starterSlots);
  return {
    teamId,
    projected: projectedComplete ? projectedTotal : undefined,
    optimalPct: eff.efficiency,
  };
}

/**
 * Build the projected-points and optimal-lineup-% maps for one scoring period from an
 * `mBoxscore` payload. Teams missing a complete projection are omitted from the projected
 * map only (their Over/Under eligibility), never from `optimalPct`.
 */
export function extractTrophyExtras(
  mBoxscorePayload: unknown,
  starterSlots: StarterSlot[],
  scoringPeriodId: number,
): TrophyExtras {
  const projected = new Map<number, number>();
  const optimalPct = new Map<number, number>();

  const schedule = asRecord(mBoxscorePayload)?.schedule;
  if (Array.isArray(schedule)) {
    for (const matchup of schedule) {
      const m = asRecord(matchup);
      if (!m) continue;
      for (const side of [m.home, m.away]) {
        const parsed = parseSide(side, starterSlots, scoringPeriodId);
        if (!parsed || optimalPct.has(parsed.teamId)) continue;
        optimalPct.set(parsed.teamId, parsed.optimalPct);
        if (parsed.projected !== undefined) projected.set(parsed.teamId, parsed.projected);
      }
    }
  }

  return { projected, optimalPct };
}
