import { buildFaabLeaderboard } from "../faab.js";

describe("buildFaabLeaderboard", () => {
  it("sorts entries by amount descending and caps to default 12", () => {
    const result = buildFaabLeaderboard({
      season: 2025,
      entries: [
        { teamId: 1, amount: 100 },
        { teamId: 2, amount: 150 },
        { teamId: 3, amount: 90 }
      ]
    });

    expect(result).toEqual([
      { teamId: 2, amount: 150 },
      { teamId: 1, amount: 100 },
      { teamId: 3, amount: 90 }
    ]);
  });

  it("respects custom limit", () => {
    const result = buildFaabLeaderboard({
      season: 2025,
      limit: 2,
      entries: [
        { teamId: 1, amount: 200 },
        { teamId: 2, amount: 50 },
        { teamId: 3, amount: 75 }
      ]
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ teamId: 1, amount: 200 });
  });
});
