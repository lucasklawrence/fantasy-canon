import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpEspnClient, EspnFetchError } from '../packages/espn-client/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATHS = [
  // Current working directory (preferred when running from repo root)
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'apps', 'bot', '.env'),
  // Fallback to paths relative to this script to work when invoked from elsewhere
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', 'apps', 'bot', '.env'),
];

ENV_PATHS.forEach((envPath) => {
  dotenv.config({ path: envPath });
});

interface CliOptions {
  leagueId: string;
  season: number;
  view?: string;
  probe?: boolean;
  limit?: number;
  offset?: number;
  scoringPeriodId?: number;
  legacy?: boolean;
}

function parseArgs(): CliOptions | undefined {
  const args = process.argv.slice(2);
  let leagueId = process.env.ESPN_LEAGUE_ID ?? '';
  let season = Number.NaN;
  let view: string | undefined = 'mTeam';
  let probe = false;
  let limit: number | undefined;
  let offset: number | undefined;
  let scoringPeriodId: number | undefined;
  let legacy = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === '--league' || arg === '-l') && args[i + 1]) {
      leagueId = args[i + 1];
      i += 1;
    } else if ((arg === '--season' || arg === '-s') && args[i + 1]) {
      season = Number.parseInt(args[i + 1], 10);
      i += 1;
    } else if ((arg === '--view' || arg === '-v') && args[i + 1]) {
      view = args[i + 1];
      i += 1;
    } else if (arg === '--probe') {
      probe = true;
    } else if ((arg === '--limit' || arg === '-n') && args[i + 1]) {
      limit = Number.parseInt(args[i + 1], 10);
      i += 1;
    } else if ((arg === '--offset' || arg === '-o') && args[i + 1]) {
      offset = Number.parseInt(args[i + 1], 10);
      i += 1;
    } else if ((arg === '--week' || arg === '--scoringPeriodId' || arg === '-w') && args[i + 1]) {
      scoringPeriodId = Number.parseInt(args[i + 1], 10);
      i += 1;
    } else if (arg === '--legacy') {
      legacy = true;
    }
  }

  if (!leagueId || Number.isNaN(season)) {
    return undefined;
  }

  return { leagueId, season, view, probe, limit, offset, scoringPeriodId, legacy };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  if (!opts) {
    console.log('Usage:');
    console.log(
      '  pnpm debug:espn -- --league <id> --season <year> --view <mTeam|mTransactions|...>',
    );
    console.log(
      '  pnpm debug:espn -- --league <id> --season <year> --view mTransactions2 --limit 50 --offset 0',
    );
    console.log('  pnpm debug:espn -- --league <id> --season <year> --probe   # try common views');
    console.log('Defaults: league from ESPN_LEAGUE_ID, view mTeam');
    return;
  }

  const client = new HttpEspnClient(undefined, {
    cookies: {
      espnS2: process.env.ESPN_S2,
      swid: process.env.ESPN_SWID,
    },
  });

  if (opts.probe) {
    await probeViews(client, opts.leagueId, opts.season);
    return;
  }

  const view = opts.view ?? 'mTeam';
  if (process.env.DEBUG_ESPN === '1') {
    console.log('Env cookies present:', {
      ESPN_S2: Boolean(process.env.ESPN_S2),
      ESPN_SWID: Boolean(process.env.ESPN_SWID),
    });
  }

  try {
    if (opts.legacy) {
      await fetchLegacy(opts);
      return;
    }

    const res = await client.fetchLeague({
      leagueId: opts.leagueId,
      season: opts.season,
      view,
      scoringPeriodId: opts.scoringPeriodId,
      filter: buildFilter(view, opts.limit, opts.offset),
    });

    const payload = res.payload as Record<string, unknown>;
    const keys = Object.keys(payload ?? {});
    const text = JSON.stringify(payload);
    const bytes = Buffer.byteLength(text, 'utf8');

    console.log(`URL: ${res.url}`);
    console.log(`Status: ${res.status}`);
    console.log(`Top-level keys: ${keys.join(', ') || 'none'}`);
    console.log(`Payload bytes: ${bytes}`);

    if (view === 'mTeam' && Array.isArray(payload.teams)) {
      console.log(`Teams: ${payload.teams.length}`);
    }
    if (view === 'mTransactions' || view === 'mTransactions2' || view === 'kona_transactions') {
      const txs = Array.isArray((payload as { transactions?: unknown }).transactions)
        ? (payload as { transactions: unknown[] }).transactions
        : undefined;
      if (txs) {
        console.log(`Transactions: ${txs.length}`);
      } else {
        console.log('Transactions key missing or not an array.');
      }
    }

    console.log('Snippet:', text.slice(0, 400));
  } catch (error) {
    if (error instanceof EspnFetchError) {
      console.error('Fetch failed:', error.message);
      console.error('URL:', error.url);
      if (error.bodySnippet) {
        console.error('Body snippet:', error.bodySnippet);
      }
    } else {
      console.error('Unexpected error:', error);
    }
    process.exitCode = 1;
  }
}

async function probeViews(client: HttpEspnClient, leagueId: string, season: number): Promise<void> {
  const views = [
    'mTeam',
    'mTransactions',
    'mTransactions2',
    'mTransaction',
    'kona_transactions',
    'mRoster',
    'mDraftDetail',
    'mScoreboard',
  ];

  for (const view of views) {
    try {
      const res = await client.fetchLeague({
        leagueId,
        season,
        view,
        filter: buildFilter(view),
        scoringPeriodId: view === 'mTransactions2' ? 1 : undefined,
      });
      const payload = res.payload as Record<string, unknown>;
      const keys = Object.keys(payload ?? {});
      const maybeTransactions = (payload as { transactions?: unknown }).transactions;
      const transactions = Array.isArray(maybeTransactions) ? maybeTransactions : undefined;
      console.log(`View ${view}: status ${res.status}, keys [${keys.join(', ')}]`);
      if (transactions) {
        console.log(`  transactions: ${transactions.length}`);
      }
    } catch (error) {
      if (error instanceof EspnFetchError) {
        console.log(
          `View ${view}: failed status ${error.status} ${
            error.bodySnippet ? `body: ${error.bodySnippet.slice(0, 120)}` : ''
          }`,
        );
      } else {
        console.log(`View ${view}: error ${String(error)}`);
      }
    }
  }
}

function buildFilter(view: string, limit?: number, offset?: number): unknown {
  const isTransactionsView =
    view === 'mTransactions' || view === 'mTransactions2' || view === 'kona_transactions';
  if (!isTransactionsView) {
    return undefined;
  }
  const hasLimit = Number.isFinite(limit);
  const hasOffset = Number.isFinite(offset);
  const filter: Record<string, unknown> = {
    transactions: {
      // ESPN is happy without limit; only include when the caller explicitly requests it.
      ...(hasLimit ? { limit } : {}),
      ...(hasOffset ? { offset } : {}),
      filterType: {
        value: ['FREEAGENT', 'WAIVER', 'WAIVER_ERROR'],
      },
    },
  };
  if (hasLimit) {
    (filter.transactions as Record<string, unknown>).sort = [
      {
        sortId: 'executionDate',
        sortPriority: 1,
        sortAsc: false,
      },
    ];
  }
  return filter;
}

async function fetchLegacy(opts: CliOptions): Promise<void> {
  const view = opts.view ?? 'mTransactions2';
  const scoringPeriodId = opts.scoringPeriodId;
  const season = opts.season;
  const leagueId = opts.leagueId;
  const url = new URL(`https://fantasy.espn.com/apis/v3/games/ffl/leagueHistory/${leagueId}`);
  url.searchParams.set('seasonId', String(season));
  url.searchParams.set('view', view);
  if (typeof scoringPeriodId === 'number') {
    url.searchParams.set('scoringPeriodId', String(scoringPeriodId));
  }

  const filter = buildFilter(view, opts.limit, opts.offset);
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'fantasy-canon/0.1',
    'x-fantasy-filter': filter ? JSON.stringify(filter) : '',
  };
  if (process.env.ESPN_S2 && process.env.ESPN_SWID) {
    headers.cookie = `espn_s2=${process.env.ESPN_S2}; SWID=${process.env.ESPN_SWID}`;
  }
  if (!headers['x-fantasy-filter']) {
    delete headers['x-fantasy-filter'];
  }

  const res = await fetch(url.toString(), { headers, redirect: 'follow' });
  const text = await res.text();
  console.log('Legacy URL:', url.toString());
  console.log('Status:', res.status);
  console.log('Headers:', { ...headers, cookie: headers.cookie ? '[set]' : '[missing]' });
  if (!res.ok) {
    console.log('Body snippet:', text.slice(0, 300));
    process.exitCode = 1;
    return;
  }
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(json);
    const txs = Array.isArray((json as { transactions?: unknown }).transactions)
      ? (json as { transactions: unknown[] }).transactions
      : undefined;
    console.log(`Top-level keys: ${keys.join(', ') || 'none'}`);
    console.log('Transactions:', txs ? txs.length : 'missing');
    console.log('Snippet:', text.slice(0, 400));
  } catch {
    console.log('Raw body:', text.slice(0, 400));
  }
}

void main();
