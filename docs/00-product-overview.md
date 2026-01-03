# PRD: Fantasy Canon (Discord Bot + Storyline Engine)

**Owner:** Lucas Lawrence  
**Date:** 2026-01-02  
**Status:** Draft (ready to scaffold)

## 1) Problem
Most fantasy leagues have *years* of hilarious history that gets lost in screenshots and group chat memory. The offseason is the perfect time to re-surface: who always starts slow, who wins on waivers, who dominates points-for but gets unlucky, who has the “best bad team,” etc.

## 2) Goal
Create a Discord bot + data pipeline that:
- Pulls ESPN fantasy league history (public league, 2020+).
- Converts seasons into **time-based narratives** and **visuals**.
- Posts automated weekly “This week in league history” content.
- Supports on-demand story queries via slash commands.

## 3) Non-goals (v1)
- Live-season lineup optimization or betting advice.
- Multi-platform support (Yahoo/Sleeper) in v1.
- Full web dashboard (optional later).

## 4) Users
- League members in a Discord server.
- Commissioner/admin who sets up the league + seasons to track.

## 5) Success metrics
- Bot installs and retains usage in offseason:
  - ≥ 10 weekly automated posts during offseason.
  - ≥ 30 slash command invocations/month (league size ~12).
- “Shareability”:
  - ≥ 5 posts/month forwarded to other channels / group chats.

## 6) Core product pillars
1. **Canon**: factual, data-backed storylines (“what happened”).
2. **Receipts**: clickable data + “prove it” drill-down.
3. **Entertainment**: fun titles, arcs, rivalries, and stats cards.
4. **Automation**: scheduled posts so the bot lives even when no one prompts it.

## 7) Data scope (public ESPN league)
- Seasons: 2020 → current
- League: `58246399`
- Example endpoint you provided (2025):
  - `.../seasons/2025/segments/0/leagues/58246399?view=mTeam`

## 8) MVP (what ships first)
**MVP1 (Week 1–2):**
- ESPN fetcher (league + teams)
- Storage of raw JSON snapshots
- Discord bot scaffolding (slash commands + config)
- 3 storylines:
  - Waiver spend leaderboard (season)
  - Points-for vs record “luck index”
  - Biggest win / biggest loss (weekly)

**MVP2 (Week 3–4):**
- Matchups + weekly recap engine
- Automated scheduled posts (weekly)
- Visual cards (PNG) posted in Discord

## 9) Risks / constraints
- ESPN endpoints are unofficial and may rate-limit or change.
- Public league access is easiest; private leagues require cookies/session.
- Data volume is moderate, but you want repeatable ingestion across seasons.

## 10) Open decisions (fill later)
- Hosting: single VPS vs serverless (Cloud Run) vs always-on small node.
- Storage: Postgres (Supabase) vs local SQLite for MVP.
- Viz style: minimalist stat cards vs richer dashboards.

## 11) Out of the box “league myth” ideas
- “King of close games”
- “Waiver wizard”
- “Draft day prophet”
- “The heartbreak artist” (lost the most close games)
- “Boom/Bust” team volatility
- Rivalries (head-to-head over time)
