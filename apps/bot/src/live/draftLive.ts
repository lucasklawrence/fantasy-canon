/**
 * Local live-draft advisor entrypoint (`pnpm -C apps/bot run live -- --slot 8`).
 *
 * Attaches read-only to a Chrome you already have open on your ESPN draft, watches the pick-history
 * DOM, and serves a localhost dashboard that shows the best available pick + alternatives, updating
 * as picks land. It never touches the ESPN tab — no clicks, no pick submission (ADR 0004, Tier B).
 * You still make every pick yourself; this just does the "who's the best guy left" math live.
 *
 * Setup (once, before your draft):
 *   1. Fully quit Chrome, then relaunch it with remote debugging on, e.g.
 *        Windows:  chrome.exe --remote-debugging-port=9222
 *        macOS:    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
 *   2. Open your ESPN draft room in that Chrome (https://fantasy.espn.com/football/draft…).
 *   3. Run this with your draft slot: `pnpm -C apps/bot run live -- --slot 8`
 *   4. Open the printed http://127.0.0.1:4599 in any browser and keep it on a second monitor/phone.
 *
 * Everything here is the side-effectful shell; the capture parsing, VBD projection, and dashboard
 * rendering are all pure modules with their own tests.
 */

import { chromium, type Browser, type Page } from 'playwright-core';
import {
  applyPicks,
  createDraftSession,
  diffNewPicks,
  type DraftSession,
} from '@fantasy-canon/core';
import { loadRankings, ROSTER_SLOTS } from '../lib/draftPool.js';
import { buildAdviceView } from './advice.js';
import { createPlaywrightReader } from './playwrightReader.js';
import { PlaywrightEspnDraftSource } from './playwrightSource.js';
import { startAdviceServer, type ServeState } from './server.js';

interface LiveConfig {
  slot: number;
  leagueSize: number;
  cdpUrl: string;
  port: number;
  pollMs: number;
}

function parseConfig(argv: string[]): LiveConfig {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.match(/^--([\w-]+)=(.*)$/);
    if (eq) {
      args.set(eq[1], eq[2]);
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.set(key, next);
        i += 1;
      } else {
        args.set(key, 'true');
      }
    }
  }

  const num = (key: string, env: string | undefined, fallback: number): number => {
    const raw = args.get(key) ?? env;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const slot = num('slot', process.env.FANTASY_MY_SLOT, 0);
  const leagueSize = num('league', process.env.FANTASY_LEAGUE_SIZE, 12);
  if (!Number.isInteger(slot) || slot < 1 || slot > leagueSize) {
    throw new Error(
      `Your draft slot is required: pass --slot <1..${leagueSize}> (or set FANTASY_MY_SLOT). ` +
        `That's your position in the draft order.`,
    );
  }

  return {
    slot,
    leagueSize,
    cdpUrl: args.get('cdp') ?? process.env.FANTASY_CDP_URL ?? 'http://localhost:9222',
    port: num('port', process.env.FANTASY_LIVE_PORT, 4599),
    pollMs: num('poll', process.env.FANTASY_POLL_MS, 1500),
  };
}

/** Find the open ESPN draft-room page across the connected browser's contexts. */
function findEspnDraftPage(browser: Browser): Page | undefined {
  const pages = browser.contexts().flatMap((c) => c.pages());
  return (
    pages.find((p) => /fantasy\.espn\.com\/football\/draft/i.test(p.url())) ??
    pages.find((p) => /fantasy\.espn\.com/i.test(p.url()))
  );
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));

  console.log('Fantasy Canon — live draft advisor (read-only)');
  console.log(`  slot ${config.slot} of ${config.leagueSize} · CDP ${config.cdpUrl}`);

  const rankings = await loadRankings();
  if (rankings.players.length === 0) {
    console.warn(
      '  ⚠ no player pool loaded (no research board and ADP feed unreachable). ' +
        'Recommendations will be empty until the ADP feed is reachable.',
    );
  } else {
    const via = rankings.adp ? `ADP as of ${rankings.adp.asOf}` : 'research board only';
    console.log(`  pool: ${rankings.players.length} players (${via})`);
  }

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(config.cdpUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n✖ Could not attach to Chrome at ${config.cdpUrl}: ${message}`);
    console.error('  Launch Chrome with remote debugging first, e.g.:');
    console.error('    chrome.exe --remote-debugging-port=9222   (Windows)');
    console.error(
      '    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222   (macOS)',
    );
    console.error('  then open your ESPN draft room in that Chrome and re-run.');
    process.exit(1);
  }

  const page = findEspnDraftPage(browser);
  if (!page) {
    console.error('\n✖ No ESPN draft tab found in that Chrome.');
    console.error(
      '  Open https://fantasy.espn.com/football/draft… in the debugged Chrome, then re-run.',
    );
    // Explicit exit: once connectOverCDP succeeds its WebSocket keeps the event loop alive, so a
    // bare `return` here would hang the CLI instead of dropping back to the prompt.
    process.exit(1);
  }
  console.log(`  attached to: ${page.url()}`);

  const source = new PlaywrightEspnDraftSource(createPlaywrightReader(page), config.leagueSize);
  let session: DraftSession = createDraftSession({
    leagueSize: config.leagueSize,
    myTeamId: config.slot,
    rosterSlots: ROSTER_SLOTS,
  });

  let serve: ServeState = {
    status: 'watching draft',
    updatedAt: new Date().toISOString(),
    source: page.url(),
    view: buildAdviceView(session, rankings.players, { adp: rankings.adp }),
  };

  const server = await startAdviceServer(() => serve, { port: config.port });
  console.log(`\n▶ Dashboard: ${server.url}`);
  console.log(
    '  Keep this running during your draft. Ctrl+C to stop. (Nothing is ever sent to ESPN.)\n',
  );

  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const snapshot = await source.poll();
        const fresh = diffNewPicks(session.draftedKeys, snapshot.picks);
        if (fresh.length > 0) {
          session = applyPicks(session, fresh);
          for (const p of fresh) console.log(`  #${p.overall}  ${p.playerName}`);
        }

        // If ESPN's on-the-clock is ahead of what we've captured, some picks scrolled past
        // unread — surface it rather than silently misreport whose turn it is.
        const captured = session.picks.length + 1;
        const boardAt = snapshot.onTheClock;
        const status =
          snapshot.complete === true
            ? 'draft complete'
            : boardAt !== undefined && boardAt > captured
              ? `syncing… (captured ${session.picks.length}, board at pick ${boardAt})`
              : 'watching draft';

        serve = {
          status,
          updatedAt: new Date().toISOString(),
          source: page.url(),
          view: buildAdviceView(session, rankings.players, {
            adp: rankings.adp,
            complete: snapshot.complete === true,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        serve = {
          ...serve,
          status: `capture error: ${message}`,
          updatedAt: new Date().toISOString(),
        };
      } finally {
        busy = false;
      }
    })();
  }, config.pollMs);

  const shutdown = (): void => {
    clearInterval(timer);
    // Deliberately do NOT close the user's Chrome — we only ever attached read-only. Just drop the
    // server and disconnect our CDP session by exiting.
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  // Explicit: if we failed after attaching, the CDP socket would otherwise keep the process alive.
  process.exit(1);
});
