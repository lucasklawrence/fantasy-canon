# Trusted Sources

Curated outlets the `fantasy-research` skill prioritizes during search and fetch.
Edit this file to tune what the research trusts — add/remove a line and it takes
effect on the next run. Group label is for humans; the skill passes the domains.

## Aggregators — ADP, consensus rankings, cheat sheets
- FantasyPros — https://www.fantasypros.com  (consensus ADP & expert rankings)
- ESPN Fantasy — https://www.espn.com/fantasy/football  (Mike Clay rankings, cheat sheets)
- Fantasy Football Calculator — https://fantasyfootballcalculator.com  (mock-draft ADP; check date — can be stale)

## Analytics — models, projections, advanced metrics
- PFF — https://www.pff.com  (grades, way-too-early boards, snap/route data)
- Draft Sharks — https://www.draftsharks.com  (3D value model, injury-adjusted)
- 4for4 — https://www.4for4.com  (mock recaps, tier-based strategy)
- RotoBaller — https://www.rotoballer.com  (sleepers/busts, waiver analysis)

## News / injury / depth charts
- CBS Sports Fantasy — https://www.cbssports.com/fantasy/football  (news + projection models)
- Yahoo Fantasy — https://sports.yahoo.com/fantasy  (news, expert takes)
- Rotowire — https://www.rotowire.com  (depth charts, injury news, snap counts)
- NFL.com — https://www.nfl.com  (official injury reports, transactions)

## Market ADP — sharpest live pricing
- Underdog Fantasy — https://underdogfantasy.com  (best-ball ADP, sharp market)
- Sleeper — https://sleeper.com  (redraft & best-ball ADP)

## Domain quick-list (skill passes these)
fantasypros.com, espn.com, fantasyfootballcalculator.com, pff.com, draftsharks.com,
4for4.com, rotoballer.com, cbssports.com, sports.yahoo.com, rotowire.com, nfl.com,
underdogfantasy.com, sleeper.com

## Notes on reliability (learned from prior runs)
- Fantasy Football Calculator's "current season" ADP page has been observed
  serving stale prior-September mock data re-labeled with the new year. Always
  verify the as-of date before trusting its numbers. (2026-07-19: the 12-team
  PPR board cleared this check — 2,415 mocks sampled July 12-19 — so the page
  is usable when the sample window is fresh. Its `round.pick` column is
  internally inconsistent, though; derive round/pick from ADP yourself.)
- "Way-too-early" PFF/CBS boards are mid-offseason vintage — discount until
  refreshed post-free-agency and post-draft.
- **FantasyPros consensus ADP is narrower than advertised** (checked 2026-07-19):
  the PPR overall page aggregated only BB10, Sleeper and Drafters — no ESPN,
  Yahoo, NFFC or CBS. Third-party descriptions claiming a broader source set
  reflect prior-season methodology. Composition should widen as home leagues
  ramp draft volume in August; re-check the "Pick Sources" list each run.
- **FantasyPros ADP is effectively unusable for our format** (deepened
  2026-07-20, verified by direct self-fetch): Drafters.com hosts only Best Ball
  / Pick'em / Condensed — no traditional redraft; BB10 is BestBall10s, which is
  **10-team, 20-round**, so its picks mismatch our board on two axes at once.
  The page also serves **only the top 5 rows unauthenticated** (registration
  fence), so the entire 90-200 ADP band is unobtainable there. Use FFC.
- **⚠️ Sanity-check ADP columns with DEEP players, never the top 5.** On the
  FantasyPros board, ranks 3-5 have `avg` exactly equal to `rank` (Chase 3/3.0,
  Nacua 4/4.0, JSN 5/5.0) — a top-5 spot-check therefore CANNOT detect
  rank-for-ADP column substitution. Use a player around pick 100 instead
  (Kelce, Purdy) where rank and ADP genuinely diverge.
- Watch for player-slug collisions: `fantasypros.com/nfl/players/dj-moore.php`
  returns a 39-year-old cornerback, not the Bills WR. Auto-pulled ADP from a
  guessed slug can be silently wrong. More cases (2026-07-20): RotoWire's
  `zach-charbonnet-4949` returned David Anderson; ESPN's `id/4429795/zach-charbonnet`
  returned Jahmyr Gibbs. **Always confirm team + position + age before trusting
  any auto-pulled figure.**
- **⚠️ ESPN depth charts are AUTO-GENERATED PROJECTIONS, not official team
  designations.** They misled us twice in one run (2026-07-20): listing an
  ACL-recovering Charbonnet as Seattle's "starter" over a first-round rookie,
  and naming Kyler Murray the Vikings' starter during an openly unresolved
  competition. Both carried "(Q)"-style flags that are easy to miss. For role
  questions use the **team's own site** plus beat reporting; ESPN charts are a
  weak prior at best. This artifact generated a phantom "80-pick arbitrage."
- Team **roster pages** are unreliable for injury designations — seahawks.com
  failed to render a known PUP designation for a player confirmed on PUP via a
  team news article. Prefer team news/transaction posts and nfl.com player pages.
- **Sample-size check on any deep ADP.** FFC reports `Times Drafted`; a player
  taken in only ~3% of mocks (Charbonnet, 70 of 2,448) has an ADP conditional on
  being drafted at all, so his true market value is WORSE than the number. Always
  read Times Drafted and Std Dev alongside a late-round ADP before calling it a price.
- **Budget exhaustion is now a documented pattern, not bad luck** — three
  consecutive runs burned the 200-call WebSearch budget before verification,
  leaving verifiers unable to hunt dissent. Direct WebFetch compensates fine for
  ADP tables and official rosters (you can name the URL), but is structurally
  incapable of answering questions that require FINDING an unknown article or
  empirical study. Put "reserve search budget for verification" in the prompt,
  and run open-ended literature questions SEPARATELY from lookup questions.
- **The ESPN rankings hub URL contains no player data** — `.../page/FFPreseasonRank26main/...`
  returns only position-category links. The actual numbers live on leaf pages
  (e.g. `/story/_/id/48711830`). Never cite the hub for a valuation.
- **Format mismatch is the recurring trap.** DraftSharks/Underdog, 4for4, BB10
  and Drafters are best-ball (inflates high-variance pass-catchers and rookies);
  CBS expert mocks are half-PPR (understates rookie WR cost). Prefer the FFC
  12-team PPR board and NFFC figures — they are natively our format.
- **⚠️ FFC rank-vs-ADP column trap** (cost us 4 coverage areas on 2026-07-20):
  the FFC board has a `#` rank column AND a separate `Overall` decimal-ADP
  column. Page-summarizing fetches routinely return the RANK where ADP is
  expected — the tell is an integer part exactly equal to the rank (Purdy
  "106.2" vs true 101.2; Kelce "112" vs 99.5). This silently corrupts every
  round calculation and caused correct claims to be voted down as refuted.
  **Always instruct the fetch to name the decimal-ADP column explicitly and
  restate the sample window**, and sanity-check a few known players against a
  second surface before trusting a tier boundary.
- FFC also contradicts itself across surfaces: its `round.pick` column conflicts
  with its own player pages, and player pages truncate ADP and relabel it as a
  pick number (Price's "73rd selection overall" = ADP 73.8 = the 76th pick).
  Derive round/pick from raw ADP as `ceil(ADP / league_size)`.
- A workflow that exhausts its WebSearch budget (200/200) mid-run will still
  report "confirmed" verdicts, but those rest on direct fetches without
  adversarial dissent-hunting. Check the caveats for budget exhaustion before
  treating a 3-0 vote as strongly verified.
