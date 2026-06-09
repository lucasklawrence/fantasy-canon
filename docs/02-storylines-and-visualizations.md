# Storylines & Visualizations (Time-based)

This doc takes the data you showed (league + teams + transactionCounter + records) and turns it into “time-based” content that feels like narratives.

## A) Season arcs (macro timelines)

1. **Record arc over weeks**
   - Chart: team rank by week (line), or win/loss streak blocks.
   - Storyline: “Started 1–5 then went 8–3 the rest of the way.”

2. **Points-for momentum**
   - Chart: points scored per week + rolling average.
   - Storyline: “Offense peaked late, but too late.”

3. **Luck index over time**
   - Metric: (actual wins) – (expected wins based on weekly points rank).
   - Chart: cumulative luck line.
   - Storyline: “Best team that got jobbed.”

4. **Streak theater**
   - From schedule/matchups (compute streaks).
   - Storyline: “7-game heater” / “4-week drought.”

## B) Rivalries & head-to-head “canon”

1. **Nemesis detector**
   - For each pair: win/loss record + points differential across seasons.
   - Storyline: “You always lose to Keith by <10.”

2. **Close game heartbreak list**
   - Top N closest matchups all-time for each team.
   - Storyline: “The 0.6 point loss heard round the league.”

3. **Playoff revenge arc**
   - Identify playoff matchups and link to regular-season results.

## C) Transaction / waiver legend content

Your response includes `transactionCounter` with:

- acquisitions, drops
- acquisitionBudgetSpent
- matchupAcquisitionTotals by week
- moveToIR / moveToActive (lineup churn proxy)
- trades count

Ideas:

1. **Waiver war timeline**
   - Chart: FAAB spend per week per team.
   - Storyline: “Lucas (DFV) blew 433 early and still finished last.”

2. **Streamers of destiny**
   - Most adds in a single week.
   - Storyline: “Week 11: 4 pickups. Desperation mode.”

3. **Lineup churn index**
   - (moveToActive + moveToIR) / weeks
   - Storyline: “The tinkerer vs the set-and-forget.”

4. **Trade season**
   - Count trades by week, annotate trade deadlines.
   - Storyline: “Only 2 trades all year: league hates fun.”

## D) “Canonical moments” (weekly)

Once you ingest matchups:

- Biggest upset (low projected beats high projected)
- Highest scoring week, lowest scoring week
- “Player carried” week (one player % of team points)
- The “Bench tragedy” (bench outscored starter by X)

## E) Visualization formats for Discord (fast)

1. **Stat cards (PNG)** — title, 2–4 numbers, small sparkline
2. **Bar charts** — top 12 leaderboards
3. **Timeline strips** — week-by-week blocks (streaks / spend)
4. **Rivalry cards** — record, margin, last met

## F) MVP storyline set (recommended)

Ship these first because they’re fun and use easy data:

1. FAAB spend leaderboard (season + all-time)
2. Points-for vs record “luck index”
3. Acquisition frenzy weeks (from `matchupAcquisitionTotals`)
4. Tinkerer index (from moveToActive/moveToIR)

## Data needs mapping

- For arcs/rivalries/weekly moments: you’ll need schedule + scoring views (likely `mMatchup`/`mBoxscore` style).
- For waiver + churn: `mTeam` already gives useful ingredients.
