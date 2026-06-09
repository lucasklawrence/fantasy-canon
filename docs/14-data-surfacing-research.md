# Data Surfacing Research — Discord UX, Engagement & Analytics

> Deep-research synthesis (2026-06-09) on how a Discord-first ESPN fantasy companion should surface
> data, split into **(A) private competitive-edge analytics** for an individual manager and **(B) public
> league-wide fun** (banter callouts + polished shareable recaps). Findings are web-sourced and
> adversarially fact-checked (23 of 25 verified claims confirmed; 2 refuted, noted below). This doc is
> the rationale; the tracking issues derived from it are listed in [§7](#7-tracked-work).

## 0. TL;DR

Two buckets that map cleanly onto Discord's interaction model:

- **(A) Competitive edge → ephemeral slash-command replies.** Luck/expected-wins, lineup efficiency
  (points left on bench), all-play record, schedule strength, FAAB/trade value — delivered privately
  (`MessageFlags.Ephemeral`) so a manager scouts their own team and opponents without leaking intel.
- **(B) League-wide fun → public, scheduled rituals + rendered cards.** A fixed weekly broadcast cadence
  of automated trophies/callouts and an end-of-season awards recap, posted to the league channel where
  banter happens.

The single biggest structural gap today: **the bot only responds to slash commands — it never
broadcasts on a schedule.** Bucket (B)'s entire backbone (proven by every prior-art bot) is cron-driven
channel posts, which don't exist yet.

## 1. Discord UX mechanics (verified, high-confidence)

These are platform constraints — get them right once in shared infra.

1. **Defer within 3s; the window then extends to 15min.** An interaction token is valid only 3 seconds
   for the initial response. `deferReply()` shows "thinking…" and buys 15 minutes for edits/follow-ups.
   ESPN fetches + `@resvg/resvg-js` rendering routinely exceed 3s, so defer at the top of every
   data-heavy handler, then `editReply` with the card.
   _Sources: discordjs.guide/slash-commands/response-methods, docs.discord.com/developers/interactions._
   **Status: already done** — every `/canon` subcommand defers ephemerally.

2. **Ephemeral is set up-front and can't be toggled after the first response.** `flags:
MessageFlags.Ephemeral` hides a reply from everyone but the invoker. The public-vs-private decision
   must be made before the first response — so bucket (A) vs (B) needs to be a command option or a
   "share to channel" button, not a post-hoc switch. _Source: discordjs.guide/slash-commands/response-methods._

3. **Component caps:** 40 total components/message (Components V2), ≤5 buttons per Action Row, one select
   per row, **25 options per select menu, 25 choices per autocomplete**. A 12-team league fits in one
   select; multi-season or roster-level pickers need pagination or autocomplete filtering.
   _Sources: docs.discord.com/developers/components/reference, discordjs.guide/slash-commands/autocomplete._

4. **Autocomplete is stricter than commands: 3s, no defer.** Async/API-sourced suggestions (team/player
   names) must come from a **local cache**, not a live ESPN call. _Source: discordjs.guide/slash-commands/autocomplete._

5. **Components V2 vs embeds is an either/or per message.** Setting `IS_COMPONENTS_V2` (`1<<15`) is
   irreversible for that message and disables `content`/`embeds`/poll/stickers; attachments don't show
   unless surfaced through a component (MediaGallery/Container). Our rendered SVG→PNG cards are
   attachments — so either stay on **embeds + attachment** (simplest, recommended default) or fully adopt
   V2 and expose the card via a component. **Never mix the two in one message.**
   _Sources: docs.discord.com/developers/components/reference, message.style/docs/features/components-v2._

> ⚠️ **Refuted:** the common "8MB upload limit regardless of tier" claim is false — the ceiling depends on
> the uploader/boost tier and has changed over time (0-3 vote). Don't hardcode 8MB; treat card PNG size as
> a soft budget and verify the current limit. _(Open question — see §6.)_

## 2. Engagement & game-design patterns (verified)

- **Fixed weekly broadcast cadence is the core engagement mechanic** — proven by the 306★ open-source
  `dtcarls/fantasy_football_chat_bot`: Mon close scores/scoreboard → Tue trophies + power rankings → Wed
  standings + waiver report → Thu matchups → Sun players-to-monitor + score updates. These are
  cron-driven public posts, not on-demand commands. _Source: github.com/dtcarls/fantasy_football_chat_bot._
- **Weekly trophies are the primary banter engine — ~10 categories, not 4.** GameDayBot auto-posts:
  👑 High score, 💩 Low score, 😱 Biggest blowout, 😅 Closest win, 🍀 Luckiest, 😡 Unluckiest, 📈
  Overachiever (actual − projected), 📉 Underachiever, 🤖 Best Manager (optimal-lineup %), 🤡 Worst
  Manager. _(The narrower 4-category framing was refuted, 1-2.)_ These double as analytics. _Sources:
  gamedaybot.com, dtcarls repo._
- **Power rankings should be a transparent, published formula** so they feel objective and debate-worthy
  — and you should tell readers to watch the **gap between teams, not the absolute number.** Proven
  blends: quality-of-wins + points + margins + playoff odds (GameDayBot); 2-step-dominance/points/margin
  weighted 80/15/5 (dtcarls); `((avg*6)+((high+low)*2)+(winPct*400))/10` (FF Wrapped). _Sources:
  gamedaybot.com, dtcarls repo, ffwrapped.com._
- **Make social/banter a first-class designed feature**, co-located with the data. Sleeper centers its
  whole product on a chat feed that mixes adds/drops/waivers/reports with gifs/polls/trash-talk, and
  treats trash talk as a co-equal designed use case. _(The "chat causes engagement" claim is Sleeper
  marketing, 2-1 — treat as design rationale, not proof.)_ Implication: post analytics **into the league
  channel where banter already happens**; don't silo stats. _Source: support.sleeper.com._
- **Offseason needs its own content drops** (magazines, awards, draft-lottery spectacle) to keep leagues
  active — relevant since this bot is positioned as an offseason companion. _(Open question on which
  mechanics best drive offseason retention — §6.)_

## 3. Analytics surfacing (verified)

- **Expected Wins via Monte Carlo** — FF Wrapped simulates 10,000 randomized weekly matchups, then charts
  actual vs expected; a large gap = (un)lucky schedule. Maps directly onto our existing
  `metrics/luckIndex` and `luckGraph`. _Source: ffwrapped.com._
- **All-play record** ("Wins vs. All %") — compare each team's weekly score against _every_ other team's
  that week. Reveals true strength independent of schedule; can even seed a "highest skill" side-pot.
  _Source: fantasyleaguegoat.com._
- **FF Wrapped's analytics taxonomy** is a ready-made menu of surfaces to build: Standings, Power
  Rankings, Expected Wins, Roster Management (points left on bench), Playoffs, Weekly Report, Start/Sit,
  Schedule Simulator, Trade Lab, Draft, League History, Manager Profiles, year-end Wrapped. Several map to
  private (A) commands; others to public (B) posts. _(FF Wrapped is Sleeper-oriented; adapt to ESPN data
  shapes.) Source: ffwrapped.com._
- **Visualization framing:** bump charts are the canonical season-long rank-movement viz (rank on inverted
  y-axis, direct line-end labels beat a side legend, ~10-12 lines is the readable ceiling — fine for a
  12-team league), but **bump charts hide magnitude** so pair with a line/bar when point gaps matter.
  _Source: domo.com/learn/charts/bump-charts._

## 4. Bucket A — Private competitive-edge (ephemeral commands)

Delivered as `MessageFlags.Ephemeral` slash replies; opponent intel stays private. Map to FF Wrapped's
private surfaces, adapted to ESPN public-league data:

| Surface                | Metric                                                          | Status today                                         |
| ---------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| **Lineup efficiency**  | Points left on bench / optimal-lineup % per week                | ✗ not built                                          |
| **Expected wins**      | Monte Carlo actual-vs-expected, my team highlighted             | partial (luck index ≈ points-rank vs wins-rank only) |
| **All-play record**    | My W-L vs the whole field each week                             | ✗ not built                                          |
| **Schedule strength**  | Avg opponent strength, remaining SOS                            | ✗ not built                                          |
| **Opponent scout**     | Opponent record/roster/tendencies (autocomplete picker, cached) | ✗ not built                                          |
| **FAAB / trade value** | My FAAB pace + spend ROI                                        | partial (`/canon faabpace`, `/canon bids`)           |

## 5. Bucket B — Public league-wide fun (scheduled posts + cards)

Two sub-modes, both public:

**Banter / rivalry callouts (cron-driven, text/embed):**

- Weekly trophies (~10 categories above) auto-posted Tuesday.
- Power rankings with published formula + gap commentary.
- Close-scores, players-to-monitor, waiver report on the weekly cadence.
- Existing `/canon rivalry|rivalries|streaks|homeaway|tradeblock|manager-archetypes` already produce
  banter — they just need a **scheduled public surface**, not only on-demand ephemeral replies.

**Polished shareable recaps (rendered SVG→PNG cards):**

- Power-ranking card (bump chart for season-long movement).
- Weekly recap / matchup card (projection vs actual).
- End-of-season **Wrapped-style awards recap** — ~14-15 named categories mixing serious honors (MVP,
  Most Improved, Comeback) with banter (Bust, Touchdown Merchant, One Week Wonder, Houdini). _(Template
  from a single secondary source, 2-1 — category names illustrative, not prescriptive. Source:
  rotowire.com fantasy awards.)_
- We already have `luckGraph`, `draftProphecyGraph`, `faabPaceGraph`, `leaderboardCard` to build on.

## 6. Open questions

1. **Current attachment/file-size ceiling** for bot PNG uploads (8MB claim refuted) — does it depend on
   server boost tier? Verify before assuming a budget.
2. **Scheduling mechanism:** real cron/scheduler (dtcarls pattern) vs Discord scheduled events — and how
   to post webhook-style messages **not** tied to a slash-command interaction (the 15-min token window
   doesn't apply to bot-initiated channel sends, but we have no posting path today).
3. **ESPN public-league data limits:** which competitive-edge metrics (projection deltas, opponent
   optimal-lineup) are computable **without** private-league cookies? (ESPN public API doesn't expose ROS
   projections.)
4. **Offseason retention:** no independent evidence on which mechanic (trophies vs power rankings vs polls
   vs banter) best drives _offseason_ engagement specifically — worth measuring once live.

## 7. Tracked work

Issues derived from this doc:

- **Foundational:** #51 — Scheduled channel broadcasting (the missing backbone for all of bucket B).
- **Bucket A (private edge):** #52 — Lineup efficiency / points-left-on-bench; #53 — Expected Wins
  (Monte Carlo) upgrade; #54 — All-play record; #55 — Opponent scout with cached autocomplete.
- **Bucket B (public fun):** #56 — Weekly trophies engine (~10 categories); #57 — Transparent
  power-ranking formula + bump-chart card; #58 — End-of-season Wrapped awards recap card.
- **UX infra:** #59 — Embeds-vs-V2 decision + "share to channel" button; #60 — Button pagination for
  long list commands.

Rough sequencing: **#51 first** (unblocks all public posting), then the bucket-A metrics (#52/#53/#54)
which feed the #56 trophies, then the bucket-B surfaces (#56/#57/#58); UX infra (#59/#60) can land
alongside any of them.

## Sources

Primary: discordjs.guide (response-methods, autocomplete), docs.discord.com (interactions, components),
github.com/dtcarls/fantasy_football_chat_bot, gamedaybot.com, ffwrapped.com, support.sleeper.com.
Secondary: message.style (Components V2), domo.com (bump charts), rotowire.com (awards), fantasypros.com
(tools), fantasyleaguegoat.com (luck/all-play). Full citation list with per-claim verification votes in
the research run output (workflow `wf_457ef486-99c`).
