import { createBotContext, loadEnv } from "../config.js";

describe("bot config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when required env vars are missing", () => {
    process.env = { ...originalEnv, DISCORD_APP_ID: "app-id", DISCORD_TOKEN: "" };
    expect(() => loadEnv()).toThrow(/DISCORD_TOKEN/);
  });

  it("loads env vars when provided", () => {
    process.env = {
      ...originalEnv,
      DISCORD_APP_ID: "app-id",
      DISCORD_TOKEN: "token",
      DATABASE_URL: "postgres://example.com",
      ESPN_LEAGUE_ID: "58246399"
    };

    const env = loadEnv();
    expect(env.discordAppId).toBe("app-id");
    expect(env.discordToken).toBe("token");
    expect(env.databaseUrl).toContain("postgres://");
    expect(env.defaultLeagueId).toBe("58246399");
  });

  it("creates bot context with version from package.json", () => {
    process.env = { ...originalEnv, DISCORD_APP_ID: "app-id", DISCORD_TOKEN: "token" };
    const context = createBotContext();
    expect(context.version).toMatch(/0\./);
    expect(context.env.discordToken).toBe("token");
  });
});
