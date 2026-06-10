/**
 * ESPN-specific parsing for lineup efficiency. The pure math lives in
 * `@fantasy-canon/core` (`computeLineupEfficiency`); this module turns raw `mMatchup`
 * and `mSettings` payloads into the `LineupPlayer[]` / `StarterSlot[]` that the core
 * function consumes. Kept out of `core` because it depends on ESPN's (unofficial,
 * version-fiddly) JSON shape — validated against a real-league fixture in
 * `__tests__/lineupEfficiency.test.ts`.
 *
 * Shape (one team in one scoring period), from `mMatchup?scoringPeriodId=N`:
 *   schedule[].{home,away}.rosterForCurrentScoringPeriod.entries[]
 *     .lineupSlotId                              // 20 = bench, 21 = IR, else a starter slot
 *     .playerId
 *     .playerPoolEntry.appliedStatTotal          // fantasy points for that period
 *     .playerPoolEntry.player.eligibleSlots      // slot ids the player can fill
 * ESPN only populates `rosterForCurrentScoringPeriod` for the matchup of the requested
 * `scoringPeriodId`, so collecting every side that has it yields exactly that week.
 *
 * Starter requirements come from `mSettings`:
 *   settings.rosterSettings.lineupSlotCounts     // { slotId: seatCount }, bench=20 / IR=21
 */

import type { LineupPlayer, StarterSlot } from '@fantasy-canon/core';

/** ESPN lineup-slot id for the bench (not a starting slot). */
export const BENCH_SLOT_ID = 20;
/** ESPN lineup-slot id for injured reserve (not a starting slot). */
export const IR_SLOT_ID = 21;

/** One team's roster for a single scoring period. */
export interface WeekTeamLineup {
  teamId: number;
  players: LineupPlayer[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse the league's starting-slot requirements from an `mSettings` payload.
 * Excludes the bench (20) and IR (21) slots and any slot with a zero seat count.
 * Returns `[]` if the payload doesn't contain a recognizable `lineupSlotCounts`.
 */
export function parseStarterSlots(mSettingsPayload: unknown): StarterSlot[] {
  const settings = asRecord(asRecord(mSettingsPayload)?.settings);
  const rosterSettings = asRecord(settings?.rosterSettings);
  const counts = asRecord(rosterSettings?.lineupSlotCounts);
  if (!counts) return [];

  const slots: StarterSlot[] = [];
  for (const [slotKey, rawCount] of Object.entries(counts)) {
    const slotId = asNumber(slotKey);
    const count = asNumber(rawCount);
    if (slotId === undefined || count === undefined || count <= 0) continue;
    if (slotId === BENCH_SLOT_ID || slotId === IR_SLOT_ID) continue;
    slots.push({ slotId, count });
  }
  return slots;
}

/**
 * Number of regular-season scoring periods, derived from `mSettings`
 * (`scheduleSettings.matchupPeriodCount * matchupPeriodLength`). Falls back to
 * `fallback` (default 14) when the payload lacks the field.
 */
export function regularSeasonWeeks(mSettingsPayload: unknown, fallback = 14): number {
  const settings = asRecord(asRecord(mSettingsPayload)?.settings);
  const schedule = asRecord(settings?.scheduleSettings);
  const count = asNumber(schedule?.matchupPeriodCount);
  const length = asNumber(schedule?.matchupPeriodLength) ?? 1;
  if (count === undefined || count <= 0) return fallback;
  return count * length;
}

function parseSide(side: unknown): WeekTeamLineup | undefined {
  const s = asRecord(side);
  if (!s) return undefined;
  const teamId = asNumber(s.teamId);
  const roster = asRecord(s.rosterForCurrentScoringPeriod);
  const entries = roster?.entries;
  if (teamId === undefined || !Array.isArray(entries)) return undefined;

  const players: LineupPlayer[] = [];
  for (const entry of entries) {
    const e = asRecord(entry);
    if (!e) continue;
    const lineupSlotId = asNumber(e.lineupSlotId);
    const playerId = asNumber(e.playerId);
    const pool = asRecord(e.playerPoolEntry);
    const player = asRecord(pool?.player);
    if (lineupSlotId === undefined || playerId === undefined || !player) continue;

    const eligibleRaw = Array.isArray(player.eligibleSlots) ? player.eligibleSlots : [];
    const eligibleSlots = eligibleRaw
      .map((v) => asNumber(v))
      .filter((v): v is number => v !== undefined);

    players.push({
      playerId,
      points: asNumber(pool?.appliedStatTotal) ?? 0,
      eligibleSlots,
      started: lineupSlotId !== BENCH_SLOT_ID && lineupSlotId !== IR_SLOT_ID,
    });
  }
  return { teamId, players };
}

/**
 * Parse every team's lineup for one scoring period from an `mMatchup` payload.
 * Collects each matchup side that carries a `rosterForCurrentScoringPeriod` (ESPN only
 * populates it for the requested `scoringPeriodId`), de-duplicated by team id.
 */
export function parseWeekLineups(mMatchupPayload: unknown): WeekTeamLineup[] {
  const payload = asRecord(mMatchupPayload);
  const schedule = payload?.schedule;
  if (!Array.isArray(schedule)) return [];

  const byTeam = new Map<number, WeekTeamLineup>();
  for (const matchup of schedule) {
    const m = asRecord(matchup);
    if (!m) continue;
    for (const side of [m.home, m.away]) {
      const lineup = parseSide(side);
      if (lineup && !byTeam.has(lineup.teamId)) byTeam.set(lineup.teamId, lineup);
    }
  }
  return [...byTeam.values()];
}
