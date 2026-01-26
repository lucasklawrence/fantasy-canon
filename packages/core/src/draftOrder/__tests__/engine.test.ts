import { describe, expect, it } from "vitest";
import { computeDraftOrder, deterministicIndex, scoreReactionGame } from "../index.js";

describe("deterministicIndex", () => {
  it("is stable for the same seed and draw index", () => {
    const first = deterministicIndex("seed-1", 0, 10);
    const second = deterministicIndex("seed-1", 0, 10);
    expect(first).toBe(second);
  });
});

describe("computeDraftOrder", () => {
  it("draws each team once using the seeded ball bag", () => {
    const draws = computeDraftOrder({
      seed: "order-seed",
      teams: [{ teamId: "a" }, { teamId: "b" }, { teamId: "c" }],
      baseBallCount: 1
    });

    expect(draws).toHaveLength(3);
    const teamIds = draws.map((d) => d.teamId);
    expect(new Set(teamIds).size).toBe(3);
  });

  it("is deterministic for the same input", () => {
    const first = computeDraftOrder({
      seed: "fixed-seed",
      teams: [{ teamId: "a" }, { teamId: "b" }, { teamId: "c" }],
      baseBallCount: 1
    });
    const second = computeDraftOrder({
      seed: "fixed-seed",
      teams: [{ teamId: "a" }, { teamId: "b" }, { teamId: "c" }],
      baseBallCount: 1
    });

    expect(first).toEqual(second);
  });
});

describe("scoreReactionGame", () => {
  it("awards +2 to fastest and +1 to second fastest valid attempt", () => {
    const result = scoreReactionGame([
      { teamId: "team-a", reactionMs: 200, status: "valid", attemptAt: new Date("2025-01-01") },
      { teamId: "team-b", reactionMs: 250, status: "valid", attemptAt: new Date("2025-01-01T00:00:01Z") },
      { teamId: "team-c", reactionMs: 0, status: "early", attemptAt: new Date("2025-01-01T00:00:02Z") }
    ]);

    expect(result.bonusByTeam["team-a"]).toBe(2);
    expect(result.bonusByTeam["team-b"]).toBe(1);
    expect(result.bonusByTeam["team-c"]).toBeUndefined();
  });
});
