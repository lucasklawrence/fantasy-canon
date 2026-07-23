---
date: 2026-07-20
topic: FAAB empirics & endgame roster construction — an evidence audit
league:
  {
    sport: NFL,
    size: 12,
    type: snake,
    roster: redraft,
    scoring: full-PPR,
    season: 2026,
    ir_slots: 2,
    faab: 500,
    pos_caps: { RB: 6, WR: 6 },
  }
workflow_run_id: wf_28219de5-f4c
stats: { sources_fetched: 15, claims_extracted: 49, claims_verified: 25, confirmed: 17, refuted: 8 }
sources_trusted: [fantasypros.com, 4for4.com, draftsharks.com, nfl.com]
coverage: 1a ANSWERED (as a correction); 1b, 1c, 1d, 2a, 2b, 2c = NO PUBLISHED DATA
outcome: negative result — the industry has not measured these questions
---

# FAAB & Roster Construction: An Evidence Audit

### 12-team snake · redraft · full-PPR · $500 FAAB · 6 RB / 6 WR caps

## ⚡ Takeaway

**This run's main product is a correction and a negative result.** The widely-cited "$11 median Week 1 bid" comes from an article assuming a **$1,000** budget — so it's **1.1% of budget ≈ $5.50 in your league**, not the ~$55 I told you earlier today. And on every other question asked — Week 1 over/underpricing, add retention, early-spend vs late-hold outcomes, RB/WR counts, late-round dart hit rates, bench composition — **no published empirical data exists.** The prescriptions circulating range from 30% to 80% of budget, contradict each other, and none carries a dataset.

---

## ⚠️ Correction to my own earlier guidance

I told you this morning that "$11 median winning bid ≈ 11% of a standard $100 budget ≈ $55 in your league." **That was wrong by a factor of ten**, and I stated it confidently enough that it went into the skill config. Now fixed.

The source (Paul Brenton, FantasyPros, Sept 2025) states its assumption verbatim: _"For both redraft and dynasty, I am using a $1,000 FAAB budget, but you can adjust this for your specific league or convert to a percentage."_

An internal-consistency check settles it independently of that sentence — the article contains dollar figures arithmetically impossible on $100: *"splashes soaring as high as $766"*, _"$300-600 splash when a clear difference maker emerged"*, *"If you spend $400 or more, it needs to be on a locked-in starter."_

| Figure                              | On $1,000             | % of budget            | **In your $500 league**          |
| ----------------------------------- | --------------------- | ---------------------- | -------------------------------- |
| Median Week 1 winning bid (redraft) | $11                   | 1.1%                   | **≈ $5.50**                      |
| Full-season average bid             | $14                   | 1.4%                   | ≈ $7                             |
| Position medians: WR / RB / QB / TE | $29 / $21 / $21 / $20 | 2.9 / 2.1 / 2.1 / 2.0% | ≈ $14.50 / $10.50 / $10.50 / $10 |
| Top observed "conviction" splash    | $766                  | 76.6%                  | ≈ $383                           |

**The lesson generalizes:** don't assume $100. Read each source's stated budget. That rule is now in the skill config with this case as the worked example.

**Dataset provenance** `confidence: high · 3-0` — 600,000+ adds from the **2024 season only**, pooled across dynasty and redraft; 12,227 is the Week 1 redraft subset. **Platform, data provider and sampling methodology are all undisclosed**, so it isn't reproducible. It also never states the sampled leagues' actual budgets, so we can't tell whether real $1,000 leagues were observed or $100 data was rescaled — though the 1.1% conversion holds either way.

---

## The negative results

Each of these was asked directly and came back empty. Per the brief, they're reported as gaps rather than padded with another opinion.

**Q1b — Are Week 1 waivers over- or underpriced vs Weeks 2-4? NO PUBLISHED DATA.** `3-0`
No week-by-week bid distribution is published anywhere located. A tempting inference — that the $11 Week 1 median sitting below the $14 season average proves Week 1 overpayment is a right-tail phenomenon — was **refuted 0-3**: a Week 1 _median_ against a whole-season _average_ is not a like-for-like comparison. The raw material exists in Brenton's dataset; the weekly breakdown was never published.

**Q1c — What fraction of Week 1 adds survive to Week 4? NO PUBLISHED DATA.** `3-0`
The only durability statement found anywhere is qualitative: _"Plenty of players added in Week 1 were back on waivers by Weeks 3-4."_ No rate. NFL.com's public Trends tool was checked twice and exposes only rostered %, adds and drops — no bid amounts, no per-add longitudinal tracking.

**Q1d — Does early-spend or late-hold win more championships? NO OUTCOME EVIDENCE.** `3-0 / 2-1`
Only opinion exists, and the prescriptions **contradict each other violently**:

| Source      | Prescription                   | In your $500 league |
| ----------- | ------------------------------ | ------------------- |
| 4for4       | 75-80% on one early breakout   | $375-400            |
| FantasyPros | 30-40% on a guy you like early | $150-200            |
| SharkSnip   | hold; deploy bulk in Weeks 4-9 | —                   |

None carries a dataset, sample size or backtest. FantasyPros' rationale is a metaphor (_"your FAAB is like a new car; it depreciates"_). 4for4's is two anecdotes it _itself_ concedes were "once-in-a-blue-moon" outliers before generalizing from them anyway. Note 4for4's 75-80% is a wild outlier against the ~1.1% observed median — which is itself reason for skepticism.

**The one outcome-flavored stat is a selection artifact.** `confidence: high · 3-0` 4for4 offers "19.3% of teams with Bucky Irving made their fantasy championship" (2024) and "23% with Kyren Williams made the title game" (2023). **In a 12-team league the unconditional base rate of reaching a title game is ~16.7%** — so 19.3% is about a 2.6-point uplift. More fundamentally, both players are _retrospectively famous league-winners_: conditioning on known successes says nothing about the ex-ante value of an aggressive-bidding policy, whose return depends on the misses the article never shows.

**Q2a — How many RBs vs WRs out of the draft? NOT ANSWERED EMPIRICALLY.** `3-0`
The only prescription located is a DraftSharks FAQ: _"You should typically draft 5, 6 or 7 RBs and WRs in traditional formats with a 16-round draft."_ No data behind it, and it's ambiguous as to per-position vs combined — though since the article assumes a 16-round draft with 1QB/2RB/2WR/1TE/1FLEX/1K/1DST, "5-7 at each" is the only sensible reading. **That brushes your 6/6 caps without exceeding them.** The article never mentions positional caps at all. Heavily entangled with Draft War Room / subscribe CTAs.
_Two attempts to derive this from FFC ADP were refuted (1-2 and 0-3)_ — arithmetic errors, plus mock-draft data with undisclosed roster size and no autodraft filtering is revealed behavior at best, not outcome data.

**Q2b — Late-round darts vs safe floor: hit rates? NO PUBLISHED DATA, after four runs.** `3-0`
DraftSharks asserts _"Leagues are won by nailing one or two breakout late-round picks. Think Drake Maye or Harold Fannin."_ Two cherry-picked hits with no denominator is definitionally not a hit rate. Following the article's own link to where supporting data would live found the same pattern — one anecdote, zero backtests.

**The nearest thing to real data must NOT be cited.** `confidence: high · 3-0` FantasyFootballBlueprint publishes RB 14% / WR 11% / TE 9% / QB 17% "starter-worthy" rates after Round 10. It rests on an **unvalidated proprietary in-house metric ("Value Over Average")**, discloses no sample size, no league count, no platform, no scoring format, no procedure, and doesn't even name the season ("last season's"). Its own "full breakdown here" link leads to a 2021 post with no formula or dataset. A counter-hypothesis was tested and rejected: this is _not_ Football Outsiders' documented DVOA. In fairness it does define its outcome variable (sustained top-12 QB/TE, top-24 RB/WR) — but nothing about sample or procedure, so it's unreplicable.

**Q2c — Optimal bench composition? NO PUBLISHED DATA.** `3-0`
One qualitative archetype list ("league-winning upside, injury-away RBs, rookie breakouts, explosive WRs") with no counts, ratios or outcome data. A deliberately neutral second fetch demanding every number on the page returned none. That source also interleaves **Best Ball** guidance into redraft advice — Best Ball has no waiver wire and is structurally inapplicable here.

---

## Methodological finding: the advice is commercially entangled

`confidence: high · 3-0`

**Four of the five prescriptive sources publish their advice adjacent to, or as house methodology for, a paid product.** DraftSharks frames late-round upside as "1 of 7 key tenets of our fantasy football draft strategy" surrounded by "FIRE UP YOUR DRAFT WAR ROOM NOW!" CTAs. SharkSnip (anonymous editorial byline) promotes a paid-picks signup and a "FAAB Kelly" template. FantasyFootballBlueprint sells eBooks and a proprietary player-flagging system, and its byline is internally inconsistent (displayed author vs post handle). FantasyOwner is an unbylined SEO help page. 4for4 is itself a subscription product.

Framed as _commercially entangled and empirically unsupported_ — co-location with a CTA doesn't prove motive, but it's exactly the pattern to discount.

---

## 🔴 Caveats

1. **The "no data" verdicts rest on a starved search phase.** For the **fourth consecutive run**, the 200-call WebSearch budget was fully exhausted during search, before any verifier ran. This cuts asymmetrically: the "what does document X say" findings are at the _strongest_ evidence class (direct primary-source reading), but the NO-DATA verdicts should be read as **"not found by four runs of targeted search," not proof of nonexistence.**
2. **Source quality is low by necessity, and that's fine here.** Only two of seven substantive sources are from the trusted list. But every weak source is cited _only as evidence about its own contents_ in support of a negative claim — a weak source is the correct and only evidence for what that weak source says. None is used as authority for a fact about football.
3. **No independent corroboration exists for the $11/$14 medians.** Brenton's 600k sample is the only real dataset in the corpus: single season, single undisclosed provider, unreproducible. NFL.com was checked and eliminated as a fallback. If those figures are wrong, nothing catches it.
4. **Format flag:** Brenton pools dynasty and redraft; only the _add counts_ are broken out by format, so treat the $11/$14 medians as redraft-labeled but not format-audited.
5. **Low time sensitivity.** These are claims about fixed documents. The units correction and the evidence gap don't decay.

## Open questions / follow-ups

- **Highest value:** did Brenton disclose platform/methodology/actual league budgets in a companion piece or podcast? That determines whether the corpus's only real dataset is usable at all.
- Does _any_ source publish a per-week FAAB bid distribution? One table would resolve 1b outright, and Brenton's dataset plainly contains the raw material.
- Has any platform with native FAAB data (Sleeper, ESPN, Yahoo, MFL, FFPC) published a retention study? This is trivially computable from their own transaction logs, which makes its absence from public literature genuinely surprising.
- Does a rigorous late-round hit-rate backtest exist _outside_ mainstream fantasy media — an academic paper, Kaggle/GitHub analysis, or a data-community post with published code? The brief welcomed these, but the starved search never swept that space.

## Sources

**The one real dataset**

- https://www.fantasypros.com/2025/09/fantasy-football-waiver-wire-pickups-win-championships/ (Brenton; 600k adds, 2024, $1,000 budget assumption)

**Prescriptive — opinion only, commercially entangled**

- https://www.4for4.com/2025/preseason/ultimate-guide-waiver-wire-faab-strategy-2025
- https://www.fantasypros.com/2025/08/fantasy-football-strategy-faab-waiver-wire-advice/
- https://sharksnip.com/blog/fantasy-waiver-wire-faab-strategy
- https://draftsharks.com/article/fantasy-football-draft-strategy-guide · /kb/best-way-to-draft-fantasy-football
- https://www.fantasyowner.com/help/balancing-floor-vs-upside/

**Do not cite as evidence**

- https://www.fantasyfootballblueprint.com/2025/08/07/the-myth-of-the-late-round-sleeper/ (proprietary unvalidated metric)

**Checked and eliminated**

- https://fantasy.nfl.com/research/trends (no FAAB bid data at any week/season setting)
