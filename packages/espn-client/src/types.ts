import { SeasonYear } from '@fantasy-canon/shared';

export interface FetchLeagueParams {
  leagueId: string;
  season: SeasonYear;
  view: string;
  filter?: unknown;
  scoringPeriodId?: number;
}

export interface FetchLeagueResult {
  url: string;
  status: number;
  payload: unknown;
}

export interface EspnClientOptions {
  retries?: number;
  retryDelayMs?: number;
  cookies?: {
    espnS2?: string;
    swid?: string;
  };
}

export interface EspnClient {
  fetchLeague(params: FetchLeagueParams): Promise<FetchLeagueResult>;
}

export class EspnFetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly bodySnippet?: string,
  ) {
    super(message);
  }
}
