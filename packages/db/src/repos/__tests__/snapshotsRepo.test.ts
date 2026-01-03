import { InMemorySnapshotsRepo } from "../snapshotsRepo.js";

describe("InMemorySnapshotsRepo", () => {
  it("stores and retrieves snapshots by league and season", async () => {
    const repo = new InMemorySnapshotsRepo();
    const now = new Date();

    await repo.save({
      leagueId: "league-1",
      season: 2025,
      view: "mTeam",
      fetchedAt: now,
      payload: { ok: true }
    });

    await repo.save({
      leagueId: "league-1",
      season: 2024,
      view: "mRoster",
      fetchedAt: now,
      payload: { ok: false }
    });

    const results2025 = await repo.listBySeason("league-1", 2025);
    expect(results2025).toHaveLength(1);
    expect(results2025[0].view).toBe("mTeam");

    const results2024 = await repo.listBySeason("league-1", 2024);
    expect(results2024).toHaveLength(1);
    expect(results2024[0].view).toBe("mRoster");
  });
});
