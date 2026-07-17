/**
 * The ping-pong-ball lottery: build a bag of per-team balls, then repeatedly draw one
 * (deterministically, see `rng.ts`), assign that team the next pick, and remove all of the
 * team's remaining balls. More balls → better odds of an early pick; every team is guaranteed
 * exactly one pick.
 */
import { deterministicIndex } from './rng.js';
import type { DraftOrderTeamInput, LotteryDraw, LotteryInput } from './types.js';

/** A ball's id: `teamId:ballNumber` (ball numbers are 1-based within a team). */
export function encodeBallId(teamId: string, ballNumber: number): string {
  return `${teamId}:${ballNumber}`;
}

/**
 * Total balls `team` puts in the bag: its `baseBalls` (or the lottery-wide `baseBallCount`)
 * plus any `bonusBalls`. Throws if the total isn't positive — a team with no balls could never
 * be drawn. Shared with the odds math (`odds.ts`) so both always agree on weights.
 */
export function ballCountForTeam(team: DraftOrderTeamInput, baseBallCount = 1): number {
  const base = team.baseBalls ?? baseBallCount;
  const bonus = team.bonusBalls ?? 0;
  const total = base + bonus;
  if (total <= 0) {
    throw new Error(`Team ${team.teamId} must have at least one ball`);
  }
  return total;
}

function assertValidTeamIds(teams: DraftOrderTeamInput[]): void {
  const seen = new Set<string>();
  for (const team of teams) {
    if (team.teamId.length === 0 || team.teamId.includes(':')) {
      throw new Error(
        `Invalid teamId "${team.teamId}": must be non-empty and must not contain ":" (the ball-id delimiter)`,
      );
    }
    if (seen.has(team.teamId)) {
      throw new Error(`Duplicate teamId detected: ${team.teamId}`);
    }
    seen.add(team.teamId);
  }
}

/** Every ball in the bag, in stable team-then-ball-number order. */
export function buildBallBag(teams: DraftOrderTeamInput[], baseBallCount = 1): string[] {
  assertValidTeamIds(teams);

  const bag: string[] = [];
  for (const team of teams) {
    const total = ballCountForTeam(team, baseBallCount);
    for (let i = 1; i <= total; i += 1) {
      bag.push(encodeBallId(team.teamId, i));
    }
  }
  return bag;
}

/**
 * Run the full lottery: one {@link LotteryDraw} per team, in pick order. Deterministic — the
 * same input always produces the same order, which is what makes the commit-reveal scheme
 * (`commitReveal.ts`) auditable.
 */
export function computeDraftOrder(input: LotteryInput): LotteryDraw[] {
  const { seed, teams, baseBallCount = 1 } = input;
  if (teams.length === 0) {
    throw new Error('At least one team is required to run the lottery');
  }

  let bag = buildBallBag(teams, baseBallCount);
  const draws: LotteryDraw[] = [];
  const drawnTeams = new Set<string>();
  let drawIndex = 0;

  while (bag.length > 0 && drawnTeams.size < teams.length) {
    const idx = deterministicIndex(seed, drawIndex, bag.length);
    const ballId = bag[idx];
    const teamId = ballId.slice(0, ballId.lastIndexOf(':'));

    draws.push({
      pick: draws.length + 1,
      drawIndex,
      ballId,
      teamId,
    });
    drawnTeams.add(teamId);

    bag = bag.filter((id) => !id.startsWith(`${teamId}:`));
    drawIndex += 1;
  }

  if (drawnTeams.size !== teams.length) {
    throw new Error('Lottery ended before every team received a pick');
  }

  return draws;
}
