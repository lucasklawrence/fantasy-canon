-- Draft Order Lottery schema

-- Sessions are immutable after finalization; enforcement handled in application layer.
CREATE TABLE IF NOT EXISTS draft_order_sessions (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  league_id TEXT,
  seed TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CREATED', 'GAME_OPEN', 'LOTTERY_RUNNING', 'FINALIZED', 'CANCELLED', 'EXPIRED')),
  base_ball_count INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  reroll_of UUID REFERENCES draft_order_sessions (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS draft_order_sessions_guild_state_idx ON draft_order_sessions (guild_id, state);

CREATE TABLE IF NOT EXISTS draft_order_teams (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES draft_order_sessions (id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  display_name TEXT,
  manager_id TEXT,
  base_balls INTEGER NOT NULL DEFAULT 1,
  bonus_balls INTEGER NOT NULL DEFAULT 0,
  pick_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, team_id)
);

CREATE INDEX IF NOT EXISTS draft_order_teams_session_idx ON draft_order_teams (session_id);

CREATE TABLE IF NOT EXISTS draft_order_events (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES draft_order_sessions (id) ON DELETE CASCADE,
  seq BIGSERIAL NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS draft_order_events_session_seq_idx ON draft_order_events (session_id, seq);

CREATE TABLE IF NOT EXISTS draft_order_game_attempts (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES draft_order_sessions (id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid', 'early', 'invalid')),
  reaction_ms INTEGER,
  raw_input JSONB,
  attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, team_id)
);

CREATE INDEX IF NOT EXISTS draft_order_game_attempts_session_idx ON draft_order_game_attempts (session_id);
