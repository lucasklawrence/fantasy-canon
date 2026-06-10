/**
 * Lineup efficiency: how many points a team's *actual* starting lineup scored versus
 * the *optimal* lineup it could have started from the same roster that week. The gap is
 * "points left on the bench"; the ratio is the manager's optimal-lineup % (the basis of
 * the Best/Worst Manager trophies). See docs/14-data-surfacing-research.md §3-4.
 *
 * Pure and deterministic: no I/O. ESPN-specific parsing (slot ids, applied points,
 * eligibility) lives in the bot layer; this module only does the math.
 *
 * Computing the optimal lineup is NOT plain greedy — with FLEX-style multi-eligible
 * slots, greedily seating the highest scorer can strand a dedicated slot (e.g. a
 * QB/RB-eligible star taking the FLEX seat leaves the QB seat empty). The set of players
 * that can be simultaneously seated is a transversal matroid, so processing players in
 * descending points and seating each via an augmenting path (Kuhn's algorithm) yields a
 * provably maximum-weight assignment.
 */

export interface LineupPlayer {
  /** Stable id; used only for deterministic tie-breaking. */
  playerId: number;
  /** Fantasy points the player actually scored that week. */
  points: number;
  /** Starting lineup-slot ids the player is eligible to fill (bench/IR excluded). */
  eligibleSlots: number[];
  /** Whether the player was in the team's actual starting lineup that week. */
  started: boolean;
}

export interface StarterSlot {
  /** A starting lineup-slot id (the caller excludes bench/IR slots). */
  slotId: number;
  /** Number of seats of this slot the league starts. */
  count: number;
}

export interface LineupEfficiency {
  /** Points scored by the players actually started. */
  actualPoints: number;
  /** Points the best legal lineup from this roster would have scored. */
  optimalPoints: number;
  /** optimalPoints - actualPoints, floored at 0. */
  pointsLeftOnBench: number;
  /** actualPoints / optimalPoints in [0, 1]; 1 when the optimal lineup scores 0. */
  efficiency: number;
}

/**
 * Compute lineup efficiency for one team in one week.
 *
 * @param players      All rostered players that week (starters and bench), each with
 *                     actual points, eligible starting slots, and whether they started.
 * @param starterSlots The league's starting requirements (slot id → seat count), bench/IR
 *                     excluded.
 */
export function computeLineupEfficiency(
  players: LineupPlayer[],
  starterSlots: StarterSlot[],
): LineupEfficiency {
  const actualPoints = players.reduce((sum, p) => (p.started ? sum + p.points : sum), 0);

  // Expand slot requirements into individual seats; seats[i] is the slot id of seat i.
  const seats: number[] = [];
  for (const slot of starterSlots) {
    for (let i = 0; i < slot.count; i += 1) seats.push(slot.slotId);
  }

  const optimalPoints = maxWeightLineup(players, seats);
  const pointsLeftOnBench = Math.max(0, optimalPoints - actualPoints);
  const efficiency = optimalPoints > 0 ? actualPoints / optimalPoints : 1;

  return { actualPoints, optimalPoints, pointsLeftOnBench, efficiency };
}

/**
 * Maximum total points obtainable by seating players into starting seats, respecting
 * eligibility (each player ≤ 1 seat, each seat ≤ 1 player). Transversal-matroid greedy:
 * take players in descending points, seat each via an augmenting path if one exists.
 */
function maxWeightLineup(players: LineupPlayer[], seats: number[]): number {
  if (seats.length === 0) return 0;

  // Descending points; ties broken by playerId for determinism.
  const order = [...players].sort((a, b) => b.points - a.points || a.playerId - b.playerId);

  // seatOwner[s] = index into `order` of the player currently in seat s, or -1.
  const seatOwner = new Int32Array(seats.length).fill(-1);
  const eligible = (playerIdx: number, seat: number): boolean =>
    order[playerIdx].eligibleSlots.includes(seats[seat]);

  let total = 0;
  for (let p = 0; p < order.length; p += 1) {
    if (order[p].eligibleSlots.length === 0) continue;
    const visited = new Array<boolean>(seats.length).fill(false);
    if (seatPlayer(p, seatOwner, visited, eligible, seats.length)) {
      total += order[p].points;
    }
  }
  return total;
}

/** Kuhn's augmenting DFS: try to seat player `p`, displacing occupants along the path. */
function seatPlayer(
  p: number,
  seatOwner: Int32Array,
  visited: boolean[],
  eligible: (playerIdx: number, seat: number) => boolean,
  seatCount: number,
): boolean {
  for (let s = 0; s < seatCount; s += 1) {
    if (visited[s] || !eligible(p, s)) continue;
    visited[s] = true;
    if (seatOwner[s] === -1 || seatPlayer(seatOwner[s], seatOwner, visited, eligible, seatCount)) {
      seatOwner[s] = p;
      return true;
    }
  }
  return false;
}
