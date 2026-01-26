# Codex Implementation Prompt

You are implementing the Draft Order Lottery feature.

Use the documents in this directory as the source of truth.

Rules:
- Follow the data model exactly
- Implement deterministic RNG with seed
- Enforce state machine transitions
- Persist all actions as events
- Slash commands must match command schema

Start with:
1. DB migrations
2. Core engine (packages/core)
3. Slash commands in apps/bot
