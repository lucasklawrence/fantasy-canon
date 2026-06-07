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
    const { leagueId, season, view, scoringPeriodId } = params;
    const url = new URL(
      `${this.baseUrl}/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`
    );
    url.searchParams.set("view", view);
    if (typeof scoringPeriodId === "number") {
      url.searchParams.set("scoringPeriodId", String(scoringPeriodId));
    }
    return url.toString();
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

        if (params.filter) {
          // Normalize/augment filter to ensure ESPN accepts limit-based requests.
          // Some callers provide `sortMap`; ESPN requires a recognized `sort` when
          // a `limit` is present. Copy `sortMap` to `sort` or add a default
          // sort on `executionDate` desc when missing.
          const filter = JSON.parse(JSON.stringify(params.filter)) as Record<string, unknown>;
          try {
            if (filter && filter.transactions) {
              const tx = filter.transactions as Record<string, unknown>;
              const hasLimit = tx.limit !== undefined && tx.limit !== null;
              const hasSort = tx.sort !== undefined && tx.sort !== null;
              const hasSortMap = tx.sortMap !== undefined && tx.sortMap !== null;
              if (hasSortMap && !hasSort) {
                try {
                  const sm = tx.sortMap as Record<string, { sortPriority?: unknown; sortAsc?: unknown }>;
                  const arr: unknown[] = Object.keys(sm).map((k) => {
                    const v = sm[k];
                    return {
                      sortId: k,
                      sortPriority: v && v.sortPriority !== undefined ? v.sortPriority : 1,
                      sortAsc: v && v.sortAsc !== undefined ? v.sortAsc : false
                    };
                  });
                  tx.sort = arr;
                } catch {
                  tx.sort = tx.sortMap;
                }
                // remove original sortMap to avoid confusing the API
                delete tx.sortMap;
              }
              if (hasLimit && !hasSort && !hasSortMap) {
                tx.sort = [
                  {
                    sortId: "executionDate",
                    sortPriority: 1,
                    sortAsc: false
                  }
                ];
              }
            }
          } catch {
            // If normalization fails for any reason, fall back to original filter
          }
          headers["x-fantasy-filter"] = JSON.stringify(filter);
        }

        if (process.env.DEBUG_ESPN === "1") {
          const maskedHeaders = {
            ...headers,
            Cookie: headers.Cookie ? "[set]" : "[missing]",
            "x-fantasy-filter": headers["x-fantasy-filter"] ?? "[missing]"
          };
          console.log("ESPN request", { url, headers: maskedHeaders });
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
