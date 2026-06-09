import { HttpEspnClient } from "../client.js";

describe("HttpEspnClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds the expected league URL", () => {
    const client = new HttpEspnClient("https://example.com");
    const url = client.buildUrl({ leagueId: "58246399", season: 2025, view: "mTeam" });
    expect(url).toBe(
      "https://example.com/apis/v3/games/ffl/seasons/2025/segments/0/leagues/58246399?view=mTeam"
    );
  });

  it("returns payload and status from a successful fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ hello: "world" })
    });
    globalThis.fetch = mockFetch;

    const client = new HttpEspnClient("https://example.com");
    const result = await client.fetchLeague({
      leagueId: "1",
      season: 2025,
      view: "mTeam"
    });

    expect(result.payload).toEqual({ hello: "world" });
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on failure up to the configured limit", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({})
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true })
      });
    globalThis.fetch = mockFetch;

    const client = new HttpEspnClient("https://example.com", { retries: 1, retryDelayMs: 0 });
    const result = await client.fetchLeague({
      leagueId: "123",
      season: 2025,
      view: "mTeam"
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.payload).toEqual({ ok: true });
  });
});
