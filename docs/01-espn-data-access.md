# ESPN Data Access (Unofficial) — PRD Notes

**Date:** 2026-01-02

## The pattern

Public reads typically look like:

`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{SEASON}/segments/0/leagues/{LEAGUE_ID}?view={VIEW}`

Example (your league, 2025):

- `.../seasons/2025/segments/0/leagues/58246399?view=mTeam`
- You also referenced:
  - `.../seasons/2025/segments/0/leagues/58246399?view=mRoster`

> ESPN uses “views” to shape the response payload. You’ll often call the same base URL multiple times with different views to get complete data.

## What “views” usually give you (practical list)

This is not exhaustive; use it as a discovery checklist.

### League / teams

- `mTeam`: teams list, owners, records, points for/against, transaction counters, waiver ranks, etc.
- `mRoster`: roster entries by team; players, slots, acquisitions, injuries (varies).

### Schedule / matchups / scoring

- `mMatchup`: matchup weeks, opponent IDs, scores (varies).
- `mScoreboard`: current week scoreboard (useful in-season; historical may still work).
- `mBoxscore`: detailed player scoring per matchup/week (often needs additional params).

### Transactions / waivers

- `mTransactions`: adds/drops/trades/waiver claims, bid amounts, timestamps.

### Draft

- `mDraftDetail`: draft picks, keepers, order, auction/serpentine info.

> In practice: you’ll iterate: call the endpoint with a view, inspect JSON keys, add the view to your ingestion plan if it contains useful facts.

## Discovering what data you get (your exact question)

You can test “what data is returned” by:

1. Calling the league URL with one `view=` at a time.
2. Logging top-level keys + large nested keys.
3. Storing a sample response per view (per season) so you can diff later.

### Minimal “shape inspection” script (pseudo)

- fetch
- print `Object.keys(payload)`
- print keys under `payload.teams[i]`, `payload.schedule[i]`, etc
- save to `samples/{season}/{view}.json`

## Ingestion strategy

### Option A: Raw snapshot first (recommended)

- Store every response as immutable JSON:
  - `league_id`, `season`, `view`, `fetched_at`, `etag/hash`, `payload`
- Pros: easiest, future-proof, debug-friendly.
- Cons: queries are harder until you normalize.

### Option B: Normalize immediately

- Parse + write relational tables.
- Pros: analytics are easier
- Cons: schema churn early

**Best path:** do both — snapshots are the source of truth; normalization is derived.

## Rate limiting + caching

- Avoid spamming ESPN:
  - Cache by `(leagueId, season, view)` and only refetch if missing.
  - Use backoff on non-200.
- Offseason: you can fetch once and treat season data as mostly stable.

## Private leagues (future)

Private leagues often require:

- session cookies (e.g., `espn_s2`, `SWID`) pulled from your browser.
- Storing them securely (secret store), and never posting them to Discord.

For now you said **public**, so we skip cookies.

## Your config inputs (what I need from you later)

- League ID(s)
- Seasons range (you said 2020 → now)
- Discord server/channel for scheduled posts
- Your preferred “reset day/time” (weekly post schedule)
