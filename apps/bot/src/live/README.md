# Live draft advisor (local, read-only)

A personal, on-your-machine tool that watches your **ESPN web** draft room and shows the best
available pick — recommendation, alternatives, positional needs, your roster — on a localhost
dashboard that updates as picks land. **You still make every pick yourself.**

This is **Tier B** of [ADR 0004](../../../../docs/decisions/0004-espn-draft-data-and-automation.md):
read-only live capture. It observes the draft-room DOM and never clicks, types, or submits anything
to ESPN.

## Use it

1. **Quit Chrome completely**, then relaunch it with remote debugging on:
   - Windows: `chrome.exe --remote-debugging-port=9222`
   - macOS: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222`
2. Open your ESPN draft room in that Chrome (`https://fantasy.espn.com/football/draft…`).
3. Run it with your draft slot (your position in the order):
   ```
   pnpm -C apps/bot run live -- --slot 8
   ```
4. Open the printed `http://127.0.0.1:4599` in any browser (a second monitor or your phone works
   well) and leave it up.

No research reports are needed — the pool is built from free FantasyFootballCalculator ADP for our
12-team full-PPR format. If you have `research/*.md` boards, they're merged in for tiers/notes.

### Options

| Flag / env                         | Default                 | What                              |
| ---------------------------------- | ----------------------- | --------------------------------- |
| `--slot` / `FANTASY_MY_SLOT`       | _(required)_            | Your 1-based draft slot.          |
| `--league` / `FANTASY_LEAGUE_SIZE` | `12`                    | Number of teams.                  |
| `--cdp` / `FANTASY_CDP_URL`        | `http://localhost:9222` | Chrome remote-debugging endpoint. |
| `--port` / `FANTASY_LIVE_PORT`     | `4599`                  | Dashboard port (binds 127.0.0.1). |
| `--poll` / `FANTASY_POLL_MS`       | `1500`                  | DOM poll interval, ms.            |

## How it's put together

| Piece                 | Role                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `playwrightReader.ts` | The only Playwright code: one read-only `page.evaluate` over the DOM. |
| `playwrightSource.ts` | Pure parse + accumulate reads into a `DraftSource` snapshot.          |
| `advice.ts`           | Pure projection: session → dashboard view (VBD via core).             |
| `server.ts`           | localhost dashboard (`/` page + `/state` JSON it polls).              |
| `draftLive.ts`        | Entry: attach over CDP, poll loop, serve — the side-effect shell.     |

Everything except the CDP attach and the in-page selectors is unit-tested. Those two are validated
on a live (ideally mock) draft — the DOM selectors mirror the proven
`apps/bot/assets/espn-draft-capture.user.js`, so if ESPN reshuffles its markup, retune the
`SCRAPE_EXPRESSION` string in `playwrightReader.ts`.
