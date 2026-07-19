import { scoreReactionGame } from '../miniGame.js';
import type { ReactionAttempt } from '../types.js';

const T0 = new Date('2026-07-01T00:00:00Z');

/** Attempt at a fixed offset (seconds) from the round epoch, so dedupe order is deterministic. */
function attempt(
  teamId: string,
  status: ReactionAttempt['status'],
  reactionMs: number | undefined,
  atSeconds: number,
): ReactionAttempt {
  return { teamId, status, reactionMs, attemptAt: new Date(T0.getTime() + atSeconds * 1000) };
}

describe('scoreReactionGame', () => {
  it('awards +2 to the fastest and +1 to the second-fastest valid attempt, +0 beyond', () => {
    const result = scoreReactionGame([
      attempt('sharks', 'valid', 200, 1),
      attempt('ducks', 'valid', 250, 2),
      attempt('vipers', 'valid', 300, 3),
      attempt('bears', 'valid', 350, 4),
    ]);

    expect(result.bonusByTeam).toEqual({ sharks: 2, ducks: 1 });
    expect(result.awards.map((a) => [a.teamId, a.rank, a.bonusBalls])).toEqual([
      ['sharks', 1, 2],
      ['ducks', 2, 1],
    ]);
    expect(result.ranking.map((a) => [a.teamId, a.rank, a.bonusBalls])).toEqual([
      ['sharks', 1, 2],
      ['ducks', 2, 1],
      ['vipers', 3, 0],
      ['bears', 4, 0],
    ]);
  });

  it('dedupes to each team’s first attempt — a spent false start is not overridden by a later click', () => {
    const result = scoreReactionGame([
      attempt('sharks', 'early', undefined, 1),
      attempt('sharks', 'valid', 150, 2),
      attempt('ducks', 'valid', 400, 3),
      attempt('ducks', 'valid', 100, 4),
    ]);

    // Sharks burned their attempt jumping the gun; Ducks' first (slower) click is the one kept.
    expect(result.bonusByTeam).toEqual({ ducks: 2 });
    expect(result.ranking).toHaveLength(1);
    expect(result.ranking[0]).toMatchObject({ teamId: 'ducks', reactionMs: 400, rank: 1 });
  });

  it('excludes early and invalid attempts, and valid attempts without a recorded time', () => {
    const result = scoreReactionGame([
      attempt('sharks', 'early', undefined, 1),
      attempt('ducks', 'invalid', 500, 2),
      attempt('vipers', 'valid', undefined, 3),
      attempt('bears', 'valid', 320, 4),
    ]);

    expect(result.bonusByTeam).toEqual({ bears: 2 });
    expect(result.ranking.map((a) => a.teamId)).toEqual(['bears']);
  });

  it('breaks reaction-time ties deterministically by teamId', () => {
    const forward = scoreReactionGame([
      attempt('vipers', 'valid', 250, 1),
      attempt('ducks', 'valid', 250, 2),
      attempt('sharks', 'valid', 250, 3),
    ]);
    const reversed = scoreReactionGame([
      attempt('sharks', 'valid', 250, 1),
      attempt('ducks', 'valid', 250, 2),
      attempt('vipers', 'valid', 250, 3),
    ]);

    const order = forward.ranking.map((a) => a.teamId);
    expect(order).toEqual(['ducks', 'sharks', 'vipers']);
    expect(reversed.ranking.map((a) => a.teamId)).toEqual(order);
    expect(forward.bonusByTeam).toEqual({ ducks: 2, sharks: 1 });
  });

  it('returns an empty result for no attempts or no valid attempts', () => {
    expect(scoreReactionGame([])).toEqual({ ranking: [], awards: [], bonusByTeam: {} });
    const allEarly = scoreReactionGame([
      attempt('sharks', 'early', undefined, 1),
      attempt('ducks', 'early', undefined, 2),
    ]);
    expect(allEarly).toEqual({ ranking: [], awards: [], bonusByTeam: {} });
  });
});
