/**
 * Ball numbering for the lottery hopper (#211) — the pure, DOM-free half of the physics work.
 *
 * The hopper renders the *actual bag*: exactly `totalBalls` balls, numbered 1..N in contiguous
 * per-team ranges in odds-table order — the same per-team counts the commitment binds (ADR 0006),
 * so a viewer can count a team's balls against the odds table and have the numbers mean something.
 *
 * Everything here is presentation-side derivation from already-public data. Nothing influences the
 * draw: the reveal names a *team*, and which of that team's balls the client shows as drawn is a
 * cosmetic choice — made deterministically from the public commitment so every viewer (and every
 * replay) shows the same ball.
 */

/** One team's slice of the bag: balls `start`..`end` inclusive, 1-based. */
export interface BallRange {
  team: string;
  start: number;
  end: number;
  /** Team hue in degrees — evenly spaced around the wheel so the pile shows proportions. */
  hue: number;
}

/**
 * Contiguous 1-based ranges in the given row order (the odds-table order the stage broadcasts).
 * Rows with zero balls get an empty range (`end < start`) rather than being dropped, so callers
 * can still find every team.
 */
export function assignBallRanges(rows: { team: string; balls: number }[]): BallRange[] {
  const ranges: BallRange[] = [];
  let next = 1;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    ranges.push({
      team: row.team,
      start: next,
      end: next + row.balls - 1,
      // Golden-angle spacing instead of even division: adjacent rows land far apart on the wheel,
      // so neighbouring teams in the table never read as near-identical colors in the pile.
      hue: Math.round((i * 137.508) % 360),
    });
    next += row.balls;
  }
  return ranges;
}

/** Compact label for the odds table: "#5–7", or "#5" for a single ball, or "" for none. */
export function rangeLabel(range: BallRange): string {
  if (range.end < range.start) return '';
  if (range.end === range.start) return `#${range.start}`;
  return `#${range.start}–${range.end}`;
}

/**
 * Which of the winning team's balls to show as drawn. Cosmetic only — the draw itself selected a
 * team (sealed by the commitment before the first ball moved) — but it must be *stable*: derived
 * from public data so poll repaints, replays, and every viewer agree on the number. FNV-1a over
 * `commitment:pick`, mapped into the range.
 */
export function drawnBallFor(commitment: string, pick: number, range: BallRange): number {
  const size = range.end - range.start + 1;
  if (size <= 0) return range.start;
  const text = `${commitment}:${pick}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return range.start + ((hash >>> 0) % size);
}

/**
 * Ball radius that packs `count` balls into a circular hopper of `hopperRadius` at ~42% area
 * coverage — a settled pile with breathing room, not a solid disc. Clamped so a 4-ball test bag
 * doesn't render beach balls and a 100-ball bag stays legible.
 */
export function ballRadius(count: number, hopperRadius: number): number {
  if (count <= 0) return 0;
  const packed = Math.sqrt((0.42 * hopperRadius * hopperRadius) / count);
  return Math.min(17, Math.max(6, packed));
}
