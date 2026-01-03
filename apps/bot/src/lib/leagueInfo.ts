import { BotContext } from "../config.js";

export interface LeagueInfo {
  leagueId: string;
  name?: string;
}

/**
 * Fetch league settings to get the league name. Falls back to ID when name is missing.
 */
export async function getLeagueInfo(
  context: BotContext,
  leagueId: string,
  season: number
): Promise<LeagueInfo> {
  const existing = await context.snapshotsRepo.listBySeason(leagueId, season);
  const cached = existing.find((s) => s.view === "mSettings");
  if (cached) {
    const name = extractName(cached.payload);
    return { leagueId, name };
  }
  const payload = await fetchSettings(context, leagueId, season);
  const name = extractName(payload);
  return { leagueId, name };
}

async function fetchSettings(
  context: BotContext,
  leagueId: string,
  season: number
): Promise<unknown | undefined> {
  try {
    const res = await context.espnClient.fetchLeague({ leagueId, season, view: "mSettings" });
    await context.snapshotsRepo.save({
      leagueId,
      season,
      view: "mSettings",
      fetchedAt: new Date(),
      payload: res.payload
    });
    return res.payload;
  } catch {
    // Swallow fetch errors; callers should fall back to leagueId when name is unavailable.
    return undefined;
  }
}

function extractName(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const settings = (payload as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object") return undefined;
  const name = (settings as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name : undefined;
}
