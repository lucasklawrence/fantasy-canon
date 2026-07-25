---
name: fantasy-research
description: Run a scoped, fact-checked fantasy football research report for our standing league (NFL, 12-team snake, full-PPR redraft) using the deep-research workflow, biased toward a curated list of trusted sources, and archive the cited result to research/. Use when the user wants weekly fantasy research, draft prep, waiver/start-sit ideas, or asks to "run fantasy research". Designed to be callable manually (/fantasy-research) or headlessly from a scheduler (Airflow).
argument-hint: "[topic] e.g. 'draft strategy' | 'week 3 waivers' | 'start-sit RB' (defaults to a general weekly update)"
---

# Fantasy Research

Produce a deep, multi-source, fact-checked fantasy football report for our standing league, prioritizing sources we trust, and **save the result to the research archive** so we build a season-long paper trail.

## Standing configuration (edit me)

This is our league. Bake it into every research run so we never re-answer scoping questions:

- **Sport:** NFL (fantasy football)
- **League size:** 12-team
- **Draft type:** snake
- **Roster type:** redraft (NOT keeper/dynasty)
- **Scoring:** full-PPR (1.0 point per reception)
- **Season:** the current NFL season (derive the year from today's date)
- **IR slots:** 2 (typical for this league — confirm if it matters materially).
  This makes injured-player bench stashes cheap: a player starting the season on
  IR costs no active roster spot. Note ESPN only permits an IR slot for players
  carrying a qualifying designation (OUT / IR / PUP per league settings) — not
  merely "questionable" — so a stash thesis must check the actual designation.
- **Roster size:** ~15-16 spots (not yet confirmed). Matters for endgame advice —
  and note best-ball ADP sources quote picks beyond Round 16 that do not exist
  in this format.
- **Positional roster limits:** RB 6, WR 6 (user-reported, *unconfirmed* — verify
  in league settings). If correct this **caps** the RB/WR bench question: you
  cannot hoard past 6 at either spot, and 6+6+QB+TE+K+DST = 16 fits a 16-man
  roster exactly. Treat roster-construction advice as bounded by these caps.
- **Waivers:** FAAB, **$500 for the season**. ⚠️ **Dollar figures never port —
  percentages do.** Published FAAB analysis uses *varying* assumed budgets, so
  you MUST read each source's stated budget before converting; do not assume
  $100. Worked example of the trap: FantasyPros' widely-cited "$11 median
  winning Week 1 bid" comes from an article assuming a **$1,000** budget, so it
  is 1.1% ≈ **$5.50** here — not the ~$55 you would get by assuming $100.
  Always state the source's assumed budget when quoting a figure.

> To change the league (different scoring, size, dynasty, etc.), edit this block — the rest of the skill reads from it.

## Trusted sources

Read `./sources.md` (sibling file in this skill directory) before running. It lists the outlets we trust, grouped by role (aggregators, analytics, news/injury, market ADP). You MUST pass these domains into the research so the search and fetch phases prefer them. Treat anything outside this list as lower-confidence corroboration, not a primary basis for a claim.

## How to run

1. **Resolve the topic.** Use the user's argument as the research focus. If no argument is given, default to a general weekly update: *"this week's most important fantasy-relevant developments — injuries, depth-chart changes, buy-low/sell-high values, waiver targets, and start/sit leverage."*

2. **Resolve the date.** Read today's date from context. Use it for the season year and for the archive filename. Do not call `Date.now()` anywhere.

3. **Read `sources.md`** and collect the trusted domains.

4. **Run the deep-research workflow**, weaving in the standing config and trusted sources:

   ```
   Workflow({
     name: "deep-research",
     args: "<topic>. CONTEXT: NFL fantasy football, 12-team snake, redraft, full-PPR
            scoring, <season> season. PRIORITIZE these trusted sources/domains and
            prefer them in search and fetch: <comma-separated domains from sources.md>.
            Prefer 2025-2026 / current-season material; flag any data that looks stale.
            Cover: current values/ADP shifts, injuries & depth charts, targets to
            buy, players to avoid, and actionable in-draft or in-week tactics."
   })
   ```

   The deep-research workflow runs in the background and notifies on completion. Wait for it, then read its full output file (the `.output` path in the task notification) — the truncated notification is not enough.

5. **Synthesize** the workflow's findings into a clean, sectioned, cited report. Lead with a one-line takeaway, then group by the topic's natural sections. Mark each finding's confidence. Always include a **Caveats** section (source disagreement, stale data, injuries) and list **refuted/killed claims** so we don't act on them.

6. **Archive the report.** This is the whole point of the skill — do not skip it:
   - Write the full report to `research/<YYYY-MM-DD>-<kebab-topic>.md` (repo root `research/`, not inside `.claude`). Use `research/TEMPLATE.md` as the structure.
   - Prepend a one-line entry to the top of the table in `research/INDEX.md`:
     `| <YYYY-MM-DD> | <topic> | <one-line takeaway> | [report](<filename>) |`
   - In the report's frontmatter, record: date, topic, league config, workflow run id, source count, and confirmed/refuted claim counts (from the workflow stats).

7. **Report back** to the user with the takeaway, the headline findings, the caveats, and the path to the archived file.

## Headless / scheduled use

When invoked non-interactively (e.g., from Airflow via `claude -p "/fantasy-research weekly"`):
- Do everything above without asking clarifying questions — the standing config already removes the need.
- Still write the archive file and update the index; that is the durable artifact the pipeline produces.
- Keep the final stdout summary short (takeaway + archive path) so it logs cleanly.

## Notes
- The deep-research **workflow script cannot write files** (no filesystem access in workflow scripts). The archive step is performed here, in the skill, after the workflow returns. Do not try to make the workflow write the report.
- If the deep-research workflow is unavailable, fall back to direct WebSearch/WebFetch over the trusted domains, then still archive a (clearly labeled lower-rigor) report.
