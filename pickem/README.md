# pickem

A weekly NFL pick'em briefing (straight-up picks) with a graded history. It doesn't pick for
you: it puts the betting market's view next to everything that might make the favorite a bad
pick, so you can decide when to go against it, then keeps score of whether that worked.

A separate uv/Python project inside the monorepo, like `orchestration/`. It has its own CI
(`.github/workflows/pickem.yml`) and its own schedule (`pickem-snapshot.yml`); the TypeScript CI
ignores this folder.

## What it pulls (all free, no keys)

| Source                                 | Used for                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------- |
| ESPN site API `scoreboard` + `summary` | DraftKings moneylines (open and current), spread, total, ESPN FPI, injury report, weather, recent results, standings |
| nflverse `snap_counts_<season>.csv`    | Who is actually a starter (60%+ of snaps in their best 3 games) and who played last week |
| nflverse `injuries_<season>.csv`       | Practice participation (DNP / Limited / Full), once Wednesday reports are filed |

Market probability is the moneyline with the bookmaker margin removed. Flags fire on: starting QB
out or questionable, 2+ O-line starters out, 2+ starters newly out, a depleted position group, a
5+ point line move or a flipped favorite, FPI disagreeing with the market by 8+ points, a 3+ day
rest gap, wind or rain outdoors, and neutral sites. Each flag records whether it argues against
the favorite.

## Commands

Run from `pickem/` (uv installs Python 3.12+ on first run):

```bash
uv run python -m pickem snapshot     # fetch, save history/<season>/wNN/snapshots/<time>.json, render out/latest.html
uv run python -m pickem grade        # grade every week that has snapshots but no final results
uv run python -m pickem run          # grade, then snapshot (what the schedule runs)
uv run python -m pickem render       # re-render out/latest.html from saved history, no network
uv run python -m pickem alerts --dry-run    # what changed since the last look (prints instead of posting)
uv run python -m pickem checkin --dry-run   # the weekly fantasy check-in
uv run pytest -q                     # tests (no network: sources are stubbed)
uv run ruff check . && uv run ruff format --check .
```

`--week N` overrides the week for `snapshot` and `grade`. With no week, `snapshot` briefs ESPN's
current week, or the next one once every game is final.

## History

`pickem-snapshot.yml` runs Tuesday, Thursday and Sunday morning and commits new JSON straight to
`main`:

- `history/<season>/wNN/snapshots/*.json`: the full briefing at each run, about 56 KB each.
- `history/<season>/wNN/results.json`: once games are final, each game's winner graded against
  the **last snapshot taken before its kickoff** (no hindsight), with that snapshot's favorite,
  FPI favorite and flags.

## Discord alerts and your fantasy teams

`pickem-alerts.yml` posts to a Discord channel through the bot when something changes since the
last look: a starter's injury status gets worse, a line moves 4+ points or the favorite flips, or
one of your fantasy lineups has a problem (a starter on bye, out or questionable, or a bench
player projecting 3+ points higher at that slot). Players whose games have started are skipped.
It runs Wed-Sat twice a day, hourly Sunday morning and twice Monday; Tuesday's run posts the
weekly fantasy check-in (record, seed, last result, this week's matchup and projections, lineup
issues). Each alert posts once; what was sent lives in the Actions cache.

Because this repo is public, everything personal is a GitHub secret, nothing fantasy-related is
committed, and CI logs print only counts:

| Secret                   | Value                                                         |
| ------------------------ | ------------------------------------------------------------- |
| `DISCORD_TOKEN`          | the bot token (already set for the bot)                       |
| `PICKEM_DISCORD_CHANNEL` | the channel ID to post in (the bot must be able to post there) |
| `ESPN_S2`, `ESPN_SWID`   | your espn.com cookies (private leagues)                       |
| `PICKEM_LEAGUES`         | `leagueId:teamId,leagueId:teamId`                             |

### Your own projections

`usage.py` projects each of your skill players from opportunity rather than results: a weighted
average of the last four games' targets, carries and pass attempts (40/30/20/10, newest first),
times points per opportunity pulled toward the position average (25 targets, 40 carries or 60
attempts of average efficiency blended in), times the team's scoring environment (the market's
implied team total over the slate average, to the 0.7 power). Data: nflverse
`stats_player_week_<season>.csv` and snap counts. Gaps of 3+ points from ESPN are flagged with a
reason (target share trend, scoring environment) in the check-in and on the My teams tab.

Each run logs every player's last pre-kickoff ESPN and usage projections to
`.state/projections/` (Actions cache, never committed), and the Tuesday check-in scores both against
actual PPR points so you can see which one to trust on your roster.

Locally the same keys are read from the repo's gitignored `.env`; with them set, `render` adds a
**My teams** tab to the page.

## The page

`out/latest.html` is published as a claude.ai artifact (ask Claude to republish it after a
render; the link stays the same). It has a **This week** tab with every game's card and a
**Season** tab that scores your picks, the all-favorites baseline and each flag type against the
graded results. Your picks are stored in the artifact's own database (collection `picks`, one
document per week, id `<season>-wNN`), so they sync across devices and Claude can read them.
