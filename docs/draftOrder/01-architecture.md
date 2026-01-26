# Architecture

## Components
- apps/bot: Discord commands and interactions
- packages/core: Deterministic draft engine and game logic
- packages/db: Persistence and event log
- apps/api (Phase 2): Replay + Discord Activities backend

## Principle
Event-driven system. UI is a projection of persisted events.
