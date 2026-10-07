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
| nflverse `stats_player_week_<season>.csv` | Targets, carries, attempts and actual PPR points for the projection log |
| ESPN fantasy public player pool (`leaguedefaults/3`) | ESPN's weekly PPR projection for the ~300 most-rostered QB/RB/WR/TE; no login, no league |

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
uv run python -m pickem run          # grade, snapshot, log projections (what the schedule runs)
uv run python -m pickem project      # log ESPN vs usage projections for this week (frozen per game at kickoff)
uv run python -m pickem backtest --week N   # rebuild a past week's projection log, marked as a backtest
uv run python -m pickem verify       # prove history was committed pregame and every grade reproduces
uv run python -m pickem render       # re-render out/latest.html from saved history, no network
uv run python -m pickem alerts --dry-run    # what changed since the last look (prints instead of posting)
uv run python -m pickem checkin --dry-run   # the weekly fantasy check-in
uv run pytest -q                     # tests (no network: sources are stubbed)
uv run ruff check . && uv run ruff format --check .
```

`--week N` overrides the week for `snapshot`, `grade` and `project`. With no week, `snapshot` briefs ESPN's
current week, or the next one once every game is final.

## History

`pickem-snapshot.yml` commits new JSON straight to `main` on a weekly rhythm (UTC, safe in both
EDT and EST), then runs `verify`:

| When           | Why                                                                 |
| -------------- | ------------------------------------------------------------------- |
| Tue 14:00      | grade last week's pick'em; first look at the new week                |
| Thu 14:00      | grade last week's projections (nflverse stats land mid-week); practice reports |
| Thu 22:30      | before Thursday night                                                |
| Sun 12:00      | before London / early games                                         |
| Sun 16:20      | inactives are out, before the 1pm ET games                           |
| Sun 19:40      | before the 4pm ET games                                             |
| Sun 23:30      | before Sunday night                                                 |
| Mon 22:30      | before Monday night                                                 |

Files:

- `history/<season>/wNN/snapshots/*.json`: the full briefing at each run, about 56 KB each.
- `history/<season>/wNN/results.json`: once games are final, each game's winner graded against
  the **last snapshot taken before its kickoff** (no hindsight), with that snapshot's favorite,
  FPI favorite and flags.
- `history/<season>/wNN/projections.json`: the projection log (below). Each player's row is
  frozen once his game kicks off.
- `history/<season>/wNN/projection_results.json`: that log scored against actual PPR points.

## Projection log (public, verifiable)

Every scheduled run logs, for the ~300 most-rostered skill players, **ESPN's PPR projection** beside
the **usage projection** (below), a naive **last-four-games average**, and the inputs (targets,
carries, implied team total). Nothing in it comes from a private league, so it's committed. Once
nflverse publishes the week's stats, each method is scored on players who played:

- average miss in points for ESPN, usage, a 50/50 blend, the declared **70/30** (70% ESPN), and the
  naive average;
- **fades**: usage 3+ points under ESPN. How often did the player finish under ESPN's number,
  against the base rate for everyone (`below_rate`)?
- **boosts**: usage 3+ over. How often did he beat ESPN's number?

**How to check it yourself.** `python -m pickem verify` does both checks. Timing: for every logged
row it finds the earliest commit with those exact numbers and checks it predates kickoff, using
GitHub's push log (which can't be backdated) when available. Grading: it re-scores every week from
the committed log plus public nflverse stats, and re-grades the pick'em from committed snapshots plus
ESPN finals. A grade that doesn't reproduce fails the run. Rows that can't be shown to be pregame
are listed as unproven. The scheduled workflow runs it after every commit.

**What the backtest says so far (weeks 2-4, 680 player-games).** These were rebuilt on
2026-10-07: ESPN's stored projection for each week, with usage computed only from earlier weeks
and closing lines. They aren't timing-proven, and the live weeks are the real test.

| Method              | Avg miss (pts) |
| ------------------- | -------------- |
| ESPN                | 5.41           |
| Usage               | 5.85           |
| 70/30 ESPN/usage    | 5.38           |
| Last-4-games avg    | 6.42           |

ESPN beats usage on its own in every week and position except RBs in week 4. When usage is 3+
**lower**, the player finished under ESPN's number 65% of the time (91/141), against 57% for
everyone, a modest fade signal. When usage is 3+ **higher**, he beat ESPN 42% of the time (51/122),
the same as everyone. In practice: treat ESPN as the default, read a "usage lower" gap as a reason
to check the player, and don't start someone just because usage likes him. The model's settings
and the 70/30 split were fixed on 2026-10-07, before any live week, and tuning on three weeks
didn't beat ESPN either (best usage-only miss 5.70).

**Weekly routine.** Nothing to run: the schedule logs before every kickoff window, grades
Tuesday (pick'em) and Thursday (projections), and verifies after each commit. The Tuesday Discord
check-in carries one line on the season's record so far. The **Season** tab shows it week by week
after a `render`.

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

Each run also logs your own players' last pre-kickoff ESPN and usage projections to
`.state/projections/` (Actions cache, never committed, because rosters are private), and the
Tuesday check-in scores both on your roster. The public projection log above is the bigger,
verifiable sample.

Locally the same keys are read from the repo's gitignored `.env`; with them set, `render` adds a
**My teams** tab to the page.

## The page

`out/latest.html` is published as a claude.ai artifact (ask Claude to republish it after a
render; the link stays the same). It has a **This week** tab with every game's card and a
**Season** tab that scores your picks, the all-favorites baseline, each flag type, and the
projection log against the graded results. Your picks are stored in the artifact's own database (collection `picks`, one
document per week, id `<season>-wNN`), so they sync across devices and Claude can read them.
