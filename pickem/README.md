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

## The page

`out/latest.html` is published as a claude.ai artifact (ask Claude to republish it after a
render; the link stays the same). It has a **This week** tab with every game's card and a
**Season** tab that scores your picks, the all-favorites baseline and each flag type against the
graded results. Your picks are stored in the artifact's own database (collection `picks`, one
document per week, id `<season>-wNN`), so they sync across devices and Claude can read them.
