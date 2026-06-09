# Fantasy Canon – Visual Output PRD

## Scope

Server-side visual rendering for Discord: graphs and Canon Cards.

---

## Feature Set

- Graphs (Luck, Draft Prophecy)
- Canon Cards (Team, Champ, Season)
- Shared rendering infrastructure

---

## Implementation Tasks

### 1. Renderer Infrastructure

**Packages:** `packages/renderer`, `packages/shared`

- [ ] Decide renderer backend (node-canvas vs vega-lite)
- [x] Add base `renderImage(spec)` API
- [x] Define shared color palette + fonts
- [x] Standardize output sizes (1200x675, 1080x1080)
- [x] Add error-safe fallback (text-only)

---

### 2. Graph: Luck

**Core:** `packages/core/metrics/luckIndex.ts`  
**Renderer:** `packages/renderer/graphs/luckGraph.ts`

- [ ] Compute expected wins line
- [x] Map teams to scatter points (stub spec)
- [ ] Label outliers
- [ ] Export PNG
- [x] Add `/canon graph luck` command

---

### 3. Graph: Draft Prophecy

**Core:** `packages/core/storylines/draft.ts`

- [ ] Calculate delta: projected vs final rank
- [ ] Build slope chart renderer
- [ ] Highlight biggest miss
- [x] Add `/canon graph draft-prophecy`

---

### 4. Canon Cards

**Renderer:** `packages/renderer/cards/*`

- [ ] Define CardSpec interface
- [ ] Team card layout
- [ ] Champ card layout
- [ ] Archetype badge system
- [ ] `/canon card team`
- [ ] `/canon card champ`

---

## Definition of Done

- All visuals render deterministically
- Discord embeds attach images
- Commands degrade gracefully
