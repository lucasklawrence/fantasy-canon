import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "module";
import dotenv from "dotenv";
import { EspnClient, HttpEspnClient } from "@fantasy-canon/espn-client";
import {
  InMemoryLeagueConfigRepo,
  InMemorySnapshotsRepo,
  LeagueConfigRepo,
  SnapshotsRepo
} from "@fantasy-canon/db";
import { EnvConfig } from "@fantasy-canon/shared";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ENV_PATHS = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "apps", "bot", ".env"),
  path.resolve(__dirname, "..", ".env")
];

ENV_PATHS.forEach((envPath) => {
  dotenv.config({ path: envPath });
});

export interface BotContext {
  env: EnvConfig;
  version: string;
  espnClient: EspnClient;
  snapshotsRepo: SnapshotsRepo;
  leagueConfigRepo: LeagueConfigRepo;
}

export function loadEnv(): EnvConfig {
  const discordToken = process.env.DISCORD_TOKEN;
  const discordAppId = process.env.DISCORD_APP_ID;
  const databaseUrl = process.env.DATABASE_URL;
  const defaultLeagueId = process.env.ESPN_LEAGUE_ID;

  if (!discordToken) {
    throw new Error("DISCORD_TOKEN is required");
  }

  if (!discordAppId) {
    throw new Error("DISCORD_APP_ID is required");
  }

  return {
    discordToken,
    discordAppId,
    databaseUrl,
    defaultLeagueId
  };
}

export function createBotContext(): BotContext {
  const env = loadEnv();
  const version = pkg.version ?? "0.0.0";
  const espnClient: EspnClient = new HttpEspnClient();
  const snapshotsRepo = new InMemorySnapshotsRepo();
  const leagueConfigRepo = new InMemoryLeagueConfigRepo();

  return { env, version, espnClient, snapshotsRepo, leagueConfigRepo };
}
