# Fantasy Canon – Storyline Commands PRD

## Overview
This document defines Product Requirements for a set of **storyline-driven Discord commands** that do **not depend on ESPN transaction history**. These commands rely on data already available via `mTeam`, `mRoster`, `mDraftDetail`, and league status fields.

Goals:
- Deliver fun, defensible narratives (“canon”) from historical ESPN data
- Work for past seasons and private leagues
- Avoid blocked ESPN endpoints
- Feel intentional, not like degraded versions of transaction-based features

---

## Shared Assumptions & Data Sources

### Required Views
- `mTeam` (primary)
- `mRoster` (optional for some extensions)
- `mDraftDetail` (draft prophecy)

### Common Fields Used
- `teams[].record.overall.{wins,losses,pointsFor,pointsAgainst,streakType,streakLength}`
- `teams[].draftDayProjectedRank`
- `teams[].transactionCounter.*`
- `teams[].tradeBlock.players`
- `teams[].owners / members`
- `status.currentMatchupPeriod`
- `status.finalScoringPeriod`

---

## 1. /canon luck

### Purpose
Surface **luck and injustice narratives** based on points vs outcomes.

### Logic
- Compute league averages for `pointsFor`
- Compare each team’s points rank vs win rank

### Metrics
- Luck Index = rank(pointsFor) − rank(wins)

### Output
- Unluckiest team
- Luckiest team
- Optional top/bottom 3 list

### Example Copy
> "Team DFV scored the 2nd most points but finished 7–7. Canon declares this an injustice."

---

## 2. /canon draft-prophecy

### Purpose
Evaluate how draft expectations compared to reality.

### Logic
- Use `draftDayProjectedRank` vs final rank (or win % / points)

### Metrics
- Draft Delta = projectedRank − finalRank

### Output
- Biggest overperformer (steal)
- Biggest underperformer (bust)
- Optional draft accuracy score (league-level)

### Example Copy
> "Projected 9th. Finished 2nd. The prophecy was wrong."

---

## 3. /canon streaks

### Purpose
Highlight momentum, collapses, and late-season runs.

### Logic
- Use `record.overall.streakType` and `streakLength`

### Output
- Longest win streak
- Longest losing streak
- Current streak leaders

### Example Copy
> "Team TONG rode a 5-game win streak into the playoffs."

---

## 4. /canon manager-archetypes

### Purpose
Classify managers by **behavior**, not results.

### Data Used
- `transactionCounter.acquisitions`
- `transactionCounter.drops`
- `transactionCounter.moveToActive`
- `transactionCounter.moveToIR`

### Archetypes
- Wire Addict (high acquisitions)
- Lineup Tinkerer (moveToActive)
- IR Surgeon (moveToIR)
- Minimalist (low activity)

### Output
- One archetype per team (or awards)

### Example Copy
> "Team BBC made 47 adds. Canon names them Wire Addict."

---

## 5. /canon tradeblock

### Purpose
Tell the story of **intent**, not outcomes.

### Data Used
- `tradeBlock.players[].status`

### Metrics
- Count ON_THE_BLOCK
- Count UNTOUCHABLE

### Output
- Most players on the block
- Most untouchables
- Optional per-team summary

### Example Copy
> "Team Int listed 6 players on the block. The rebuild was real."

---

## 6. /canon homeaway

### Purpose
Expose home/away splits and matchup weirdness.

### Data Used
- `record.home`
- `record.away`

### Metrics
- Win % home vs away

### Output
- Home merchant
- Road warriors

### Example Copy
> "Team ABNB went 6–1 at home, 1–6 away. Canon calls them a home merchant."

---

## 7. /canon champ

### Purpose
Crown the season’s champion with context.

### Logic
- Identify champion via final rank / playoff result (implementation-dependent)

### Enhancements
- Points scored by champ
- Draft rank vs finish
- FAAB spent (total)

### Output
- Champion announcement embed

### Example Copy
> "Team DFV is canon champion of 2025. The record stands."

---

## Non-Goals
- No transaction-level analysis
- No per-week FAAB timing (requires snapshots)
- No speculative narratives

---

## Future Extensions
- Add snapshot-based versions (weekly luck, churn)
- Attach visual embeds (bars, emojis, badges)
- Persist awards across seasons for legacy stats

---

## Definition of Done
- Each command works for historical seasons
- Each command produces deterministic output
- Clear copy explaining *why* a result occurred
- No dependency on `transactions` endpoint

---

## Appendix: FAAB Utilities (transaction-backed)

These rely on `mTransactions2` (waiver bids only) and `mSettings.acquisitionSettings.acquisitionBudget` when available.

### /canon faabpace
- **Purpose:** Show FAAB spend/left pace vs the season budget.
- **Inputs:** `season` (required), `mode` (`spent|left`, default `spent`), optional `budget` override, optional `leagueid`.
- **Logic:** Sum executed waiver bids (WAIVER/WAIVER_ERROR/WAIVER_ADJUSTMENT, bidAmount > 0) per team; dedupe by `id`. Budget comes from settings unless overridden. Pace label uses front-half vs back-half spend.
- **Output:** Ranked list of teams with total spent/left, pace classification, weeks tracked.

### /canon leaderboard metric:faab
- **Purpose:** Rank FAAB spend totals for a season.
- **Inputs:** `metric` fixed `faab`, `season` (required), optional `limit`, optional `leagueid`.
- **Logic:** Prefer `transactionCounter.acquisitionBudgetSpent`; fallback to waiver bid sums as above.
- **Output:** Top teams with spend and remaining (when available).

### /canon bids
- **Purpose:** Surface close or lopsided waiver bids on the same player.
- **Inputs:** `season` (required), `mode` (`close|lopsided`, default `close`), optional `threshold`, optional `limit`, optional `leagueid`.
- **Logic:** Group waiver bids by player; compare spread or ratio; show top N interesting cases.
- **Output:** Player label with bid breakdown per team and spread/ratio descriptor.

