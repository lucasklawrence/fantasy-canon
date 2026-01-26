import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "module";
import dotenv from "dotenv";
import { EspnClient, HttpEspnClient } from "@fantasy-canon/espn-client";
import {
  InMemoryLeagueConfigRepo,
  InMemorySnapshotsRepo,
  InMemoryCanonEventsRepo,
  LeagueConfigRepo,
  SnapshotsRepo,
  CanonEventsRepo,
  InMemoryDraftOrderStore,
  DraftOrderStore
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
  canonEventsRepo: CanonEventsRepo;
  draftOrderStore: DraftOrderStore;
}

export function loadEnv(): EnvConfig {
  const discordToken = process.env.DISCORD_TOKEN;
  const discordAppId = process.env.DISCORD_APP_ID;
  const databaseUrl = process.env.DATABASE_URL;
  const defaultLeagueId = process.env.ESPN_LEAGUE_ID;
  const espnS2 = process.env.ESPN_S2;
  const espnSwid = process.env.ESPN_SWID;

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
    defaultLeagueId,
    espnS2,
    espnSwid
  };
}

export function createBotContext(): BotContext {
  const env = loadEnv();
  const version = pkg.version ?? "0.0.0";
  const espnClient: EspnClient = new HttpEspnClient(undefined, {
    cookies: {
      espnS2: env.espnS2,
      swid: env.espnSwid
    }
  });
  const snapshotsRepo = new InMemorySnapshotsRepo();
  const leagueConfigRepo = new InMemoryLeagueConfigRepo();
  const canonEventsRepo = new InMemoryCanonEventsRepo();
  const draftOrderStore = new InMemoryDraftOrderStore();

  return { env, version, espnClient, snapshotsRepo, leagueConfigRepo, canonEventsRepo, draftOrderStore };
}
