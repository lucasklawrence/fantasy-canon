import {
  EspnClient,
  EspnClientOptions,
  EspnFetchError,
  FetchLeagueParams,
  FetchLeagueResult
} from "./types.js";

const DEFAULT_OPTIONS: Required<EspnClientOptions> = {
  retries: 2,
  retryDelayMs: 500,
  cookies: {
    espnS2: undefined,
    swid: undefined
  }
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
        const headers: Record<string, string> = {
          "User-Agent": "fantasy-canon/0.1",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "X-Fantasy-Platform": "kona-PROD",
          "X-Fantasy-Source": "kona"
        };

        const cookieHeader = this.buildCookieHeader();
        if (cookieHeader) {
          headers.Cookie = cookieHeader;
        }

        const response = await fetch(url, {
          headers
        });

        if (!response.ok) {
          const bodySnippet = await this.safeReadBody(response);
          throw new EspnFetchError(
            `ESPN responded with status ${response.status}`,
            response.status,
            url,
            bodySnippet
          );
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

  private buildCookieHeader(): string | undefined {
    const cookies = this.options.cookies ?? DEFAULT_OPTIONS.cookies;
    const parts: string[] = [];
    if (cookies.espnS2) {
      parts.push(`espn_s2=${cookies.espnS2}`);
    }
    if (cookies.swid) {
      parts.push(`SWID=${cookies.swid}`);
    }
    if (parts.length === 0) {
      return undefined;
    }
    return parts.join("; ");
  }

  private async safeReadBody(response: Response): Promise<string | undefined> {
    try {
      const text = await response.text();
      return text.slice(0, 300);
    } catch {
      return undefined;
    }
  }
}
