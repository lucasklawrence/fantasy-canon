/**
 * The wheel visual's policy (#244) — pure and DOM-free, the tested half of the #211 split that
 * `raceLanes` occupies for the race and `ballAssignments` for the hopper.
 *
 * The wheel is the third slot ADR 0008 left open. Same contract as the race: `visual: 'wheel'`
 * rides `LotteryStart` from a closed vocabulary, and **nothing else new goes on the wire**. Every
 * frame is derived from the public reveal stream, so two viewers watching the same ceremony see
 * the same wheel land in the same place without the client being told anything the channel does
 * not already know.
 *
 * The one thing this visual says that the others do not: **wedge width is ball count**. Race lanes
 * are uniform and the hopper's proportions are only legible as a pile, but a wheel is a pie chart
 * that happens to spin — a team with six times the balls has six times the arc, so the viewer can
 * see the odds they were shown in the preview card.
 */

/** One team's slice of the wheel. Angles are radians, clockwise from the +x axis. */
export interface Wedge {
  team: string;
  balls: number;
  /** Degrees, matching the golden-angle scheme every other visual uses. */
  hue: number;
  startRad: number;
  endRad: number;
}

/** Where the pointer sits: 12 o'clock. */
export const POINTER_RAD = -Math.PI / 2;

const TAU = Math.PI * 2;

/**
 * Lay the remaining teams out around the wheel, arc proportional to balls.
 *
 * `drawnTeams` are already off the board, so they take no arc — the wheel visibly shrinks its
 * field as the ceremony proceeds, the way the hopper's pile empties. Rows with no balls are
 * dropped rather than given a zero-width sliver the pointer could never resolve.
 *
 * Hue comes from the row's position in the FULL bag, not among the survivors, so a team's colour
 * does not change when somebody else is drawn.
 */
export function buildWedges(
  rows: { team: string; balls: number }[],
  drawnTeams: string[] = [],
): Wedge[] {
  const drawn = new Set(drawnTeams);
  const hues = new Map(rows.map((row, i) => [row.team, Math.round((i * 137.508) % 360)]));
  const live = rows.filter((row) => row.balls > 0 && !drawn.has(row.team));
  const total = live.reduce((sum, row) => sum + row.balls, 0);
  if (total <= 0) return [];

  const wedges: Wedge[] = [];
  let cursor = 0;
  for (const row of live) {
    const span = (row.balls / total) * TAU;
    wedges.push({
      team: row.team,
      balls: row.balls,
      hue: hues.get(row.team) ?? 0,
      startRad: cursor,
      endRad: cursor + span,
    });
    cursor += span;
  }
  // Absorb float drift into the last wedge so the ring closes exactly. A hairline gap at the seam
  // is the kind of thing that only ever shows up on somebody else's monitor.
  const last = wedges[wedges.length - 1];
  if (last) last.endRad = TAU;
  return wedges;
}

/** The wedge under the pointer at `rotation`, or undefined when the wheel is empty. */
export function wedgeAtPointer(wedges: Wedge[], rotation: number): Wedge | undefined {
  if (wedges.length === 0) return undefined;
  // The pointer is fixed and the wheel turns beneath it, so look up the pointer's position
  // measured back through the rotation.
  const at = normalize(POINTER_RAD - rotation);
  return wedges.find((w) => at >= w.startRad && at < w.endRad) ?? wedges[wedges.length - 1];
}

/**
 * How far to turn so `team`'s wedge finishes under the pointer.
 *
 * Deterministic on purpose. Every viewer computes this from the same public inputs — the wedge
 * layout, which is the odds table, and the pick number — so the wheel cannot land somewhere
 * different on two screens. Nothing random, and nothing extra on the wire (ADR 0008).
 *
 * Always greater than `from`: a wheel that jumps backwards to its answer reads as a glitch, so the
 * spin is padded with whole turns until it is a forward journey of at least `minTurns`.
 */
export function landingRotation(
  wedges: Wedge[],
  team: string,
  pick: number,
  from = 0,
  minTurns = 3,
): number {
  const wedge = wedges.find((w) => w.team === team);
  if (!wedge) return from;
  const centre = (wedge.startRad + wedge.endRad) / 2;
  const target = normalize(POINTER_RAD - centre);
  // One extra turn on odd picks, so consecutive spins are not mechanically identical — still a
  // pure function of the pick, so still the same for everyone watching.
  const turns = minTurns + (pick % 2);
  let landing = target;
  while (landing < from + turns * TAU) landing += TAU;
  return landing;
}

/** Wrap into [0, TAU). */
function normalize(rad: number): number {
  const wrapped = rad % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}
