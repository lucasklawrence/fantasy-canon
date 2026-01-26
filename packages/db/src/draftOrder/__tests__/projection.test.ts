import { describe, expect, it } from "vitest";
import { buildDraftOrderProjection } from "../projections.js";
import { DraftOrderSession } from "../types.js";

describe("buildDraftOrderProjection", () => {
  it("computes bonuses and draws deterministically", () => {
    const now = new Date();
    const session: DraftOrderSession = {
      id: "session-1",
      guildId: "guild-1",
      seed: "projection-seed",
      state: "GAME_OPEN",
      baseBallCount: 1,
      createdBy: "user-1",
      createdAt: now,
      updatedAt: now
    };

    const teams = [
      {
        id: "t1",
        sessionId: session.id,
        teamId: "alpha",
        baseBalls: 1,
        bonusBalls: 0,
        createdAt: now
      },
      {
        id: "t2",
        sessionId: session.id,
        teamId: "beta",
        baseBalls: 1,
        bonusBalls: 0,
        createdAt: now
      }
    ];

    const attempts = [
      {
        id: "a1",
        sessionId: session.id,
        teamId: "alpha",
        status: "valid" as const,
        reactionMs: 210,
        attemptAt: now
      },
      {
        id: "a2",
        sessionId: session.id,
        teamId: "beta",
        status: "valid" as const,
        reactionMs: 300,
        attemptAt: now
      }
    ];

    const projection = buildDraftOrderProjection({ session, teams, attempts });

    expect(projection.awards).toHaveLength(2);
    expect(projection.awards[0].teamId).toBe("alpha");
    expect(projection.teams[0].totalBalls).toBeGreaterThan(1);
    expect(projection.draws).toHaveLength(2);

    const projectionAgain = buildDraftOrderProjection({ session, teams, attempts });
    expect(projection.draws).toEqual(projectionAgain.draws);
  });
});
