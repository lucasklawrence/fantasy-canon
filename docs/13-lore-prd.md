# Fantasy Canon – League Lore & Memory PRD

## Scope

Persistent league history, rivalries, and legacy narratives.

---

## Feature Set

- Canon Timeline
- Rivalries
- Legacy Awards
- Champion History

---

## Implementation Tasks

### 1. Canon Event Model

**DB:** `packages/db`

- [ ] Create `canon_events` table
- [ ] Repo: `canonEventsRepo`
- [ ] Event types enum
- [ ] Write on command execution

---

### 2. Timeline Command

**Bot:** `/canon timeline`

- [ ] Query events chronologically
- [ ] Pagination
- [ ] Season filtering
- [ ] Auto-write champ + luck events

---

### 3. Rivalries

**Core:** `packages/core/storylines/rivalries.ts`

- [ ] Compute H2H dominance
- [ ] Win differential metric
- [ ] Streak tracking
- [ ] `/canon rivalry teamA teamB`
- [ ] `/canon rivalries`

---

### 4. Legacy Awards

**Core:** `packages/core/storylines/legacy.ts`

- [ ] Most unlucky seasons
- [ ] Most dominant manager
- [ ] Archetype leaderboard
- [ ] `/canon legacy`

---

### 5. Champion Archive

- [ ] Persist champs per season
- [ ] `/canon champ history`
- [ ] Auto-insert on ingest

---

## Definition of Done

- Lore persists across restarts
- Commands work retroactively
- No ESPN live dependency
