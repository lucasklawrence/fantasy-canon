import {
  EspnClient,
  EspnClientOptions,
  FetchLeagueParams,
  FetchLeagueResult
} from "./types.js";

const DEFAULT_OPTIONS: Required<EspnClientOptions> = {
  retries: 2,
  retryDelayMs: 500
};

export class HttpEspnClient implements EspnClient {
  constructor(
    private readonly baseUrl = "https://lm-api-reads.fantasy.espn.com",
    private readonly options: EspnClientOptions = {}
  ) {}

  buildUrl(params: FetchLeagueParams): string {
    const { leagueId, season, view } = params;
    return `${this.baseUrl}/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=${view}`;
  }

  async fetchLeague(params: FetchLeagueParams): Promise<FetchLeagueResult> {
    const url = this.buildUrl(params);
    const retries = this.options.retries ?? DEFAULT_OPTIONS.retries;
    const retryDelayMs = this.options.retryDelayMs ?? DEFAULT_OPTIONS.retryDelayMs;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": "fantasy-canon/0.1" }
        });

        if (!response.ok) {
          throw new Error(`ESPN responded with status ${response.status}`);
        }

        const payload = await response.json();
        return { url, status: response.status, payload };
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await this.sleep(retryDelayMs);
          continue;
        }
      }
    }

    throw lastError ?? new Error("Unknown error during fetchLeague");
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
