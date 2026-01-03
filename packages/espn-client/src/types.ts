import { SeasonYear } from "@fantasy-canon/shared";

export interface FetchLeagueParams {
  leagueId: string;
  season: SeasonYear;
  view: string;
}

export interface FetchLeagueResult {
  url: string;
  status: number;
  payload: unknown;
}

export interface EspnClientOptions {
  retries?: number;
  retryDelayMs?: number;
}

export interface EspnClient {
  fetchLeague(params: FetchLeagueParams): Promise<FetchLeagueResult>;
}
