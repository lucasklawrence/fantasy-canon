import { randomUUID } from "node:crypto";
import {
  DraftOrderAttemptStatus,
  DraftOrderEvent,
  DraftOrderEventType,
  DraftOrderGameAttempt,
  DraftOrderSession,
  DraftOrderSessionState,
  DraftOrderTeam
} from "./types.js";

export interface DraftOrderSessionCreate {
  id?: string;
  guildId: string;
  channelId?: string;
  leagueId?: string;
  seed: string;
  state?: DraftOrderSessionState;
  baseBallCount?: number;
  rerollOf?: string;
  createdBy: string;
  createdAt?: Date;
  expiresAt?: Date;
}

export interface DraftOrderSessionUpdate {
  state?: DraftOrderSessionState;
  finalizedAt?: Date;
  cancelledAt?: Date;
  updatedAt?: Date;
}

export interface DraftOrderTeamCreate {
  id?: string;
  sessionId: string;
  teamId: string;
  displayName?: string;
  managerId?: string;
  baseBalls?: number;
  bonusBalls?: number;
  createdAt?: Date;
}

export interface DraftOrderEventCreate<TPayload = unknown> {
  id?: string;
  sessionId: string;
  type: DraftOrderEventType;
  payload: TPayload;
  createdBy?: string;
  createdAt?: Date;
}

export interface DraftOrderAttemptCreate {
  id?: string;
  sessionId: string;
  teamId: string;
  status: DraftOrderAttemptStatus;
  reactionMs?: number;
  rawInput?: unknown;
  attemptAt?: Date;
}

export interface DraftOrderStore {
  createSession(session: DraftOrderSessionCreate): Promise<DraftOrderSession>;
  getSession(id: string): Promise<DraftOrderSession | undefined>;
  updateSession(id: string, update: DraftOrderSessionUpdate): Promise<DraftOrderSession>;
  listSessionsByGuild(guildId: string): Promise<DraftOrderSession[]>;

  addTeam(team: DraftOrderTeamCreate): Promise<DraftOrderTeam>;
  listTeams(sessionId: string): Promise<DraftOrderTeam[]>;

  recordAttempt(attempt: DraftOrderAttemptCreate): Promise<DraftOrderGameAttempt>;
  listAttempts(sessionId: string): Promise<DraftOrderGameAttempt[]>;

  appendEvent<TPayload = unknown>(event: DraftOrderEventCreate<TPayload>): Promise<DraftOrderEvent<TPayload>>;
  listEvents(sessionId: string): Promise<DraftOrderEvent[]>;
}

const TERMINAL_STATES: DraftOrderSessionState[] = ["FINALIZED", "CANCELLED", "EXPIRED"];

function assertNotTerminal(session: DraftOrderSession): void {
  if (TERMINAL_STATES.includes(session.state)) {
    throw new Error(`Session ${session.id} is closed and cannot be modified`);
  }
}

export class InMemoryDraftOrderStore implements DraftOrderStore {
  private readonly sessions = new Map<string, DraftOrderSession>();
  private readonly teams = new Map<string, DraftOrderTeam[]>();
  private readonly events = new Map<string, DraftOrderEvent[]>();
  private readonly attempts = new Map<string, DraftOrderGameAttempt[]>();

  async createSession(session: DraftOrderSessionCreate): Promise<DraftOrderSession> {
    const now = session.createdAt ?? new Date();
    const id = session.id ?? randomUUID();
    const record: DraftOrderSession = {
      id,
      guildId: session.guildId,
      channelId: session.channelId,
      leagueId: session.leagueId,
      seed: session.seed,
      state: session.state ?? "CREATED",
      baseBallCount: session.baseBallCount ?? 1,
      rerollOf: session.rerollOf,
      createdBy: session.createdBy,
      createdAt: now,
      updatedAt: now,
      expiresAt: session.expiresAt
    };

    this.sessions.set(id, record);
    this.teams.set(id, []);
    this.events.set(id, []);
    this.attempts.set(id, []);
    return record;
  }

  async getSession(id: string): Promise<DraftOrderSession | undefined> {
    return this.sessions.get(id);
  }

  async updateSession(id: string, update: DraftOrderSessionUpdate): Promise<DraftOrderSession> {
    const existing = this.sessions.get(id);
    if (!existing) {
      throw new Error(`Session not found: ${id}`);
    }
    assertNotTerminal(existing);

    const next: DraftOrderSession = {
      ...existing,
      ...update,
      updatedAt: update.updatedAt ?? new Date()
    };

    this.sessions.set(id, next);
    return next;
  }

  async listSessionsByGuild(guildId: string): Promise<DraftOrderSession[]> {
    return Array.from(this.sessions.values()).filter((session) => session.guildId === guildId);
  }

  async addTeam(team: DraftOrderTeamCreate): Promise<DraftOrderTeam> {
    const session = this.sessions.get(team.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${team.sessionId}`);
    }
    assertNotTerminal(session);

    const existingTeams = this.teams.get(team.sessionId) ?? [];
    if (existingTeams.some((t) => t.teamId === team.teamId)) {
      throw new Error(`Team ${team.teamId} already registered for session ${team.sessionId}`);
    }

    const record: DraftOrderTeam = {
      id: team.id ?? randomUUID(),
      sessionId: team.sessionId,
      teamId: team.teamId,
      displayName: team.displayName,
      managerId: team.managerId,
      baseBalls: team.baseBalls ?? session.baseBallCount,
      bonusBalls: team.bonusBalls ?? 0,
      createdAt: team.createdAt ?? new Date()
    };

    this.teams.set(team.sessionId, [...existingTeams, record]);
    return record;
  }

  async listTeams(sessionId: string): Promise<DraftOrderTeam[]> {
    return [...(this.teams.get(sessionId) ?? [])];
  }

  async recordAttempt(attempt: DraftOrderAttemptCreate): Promise<DraftOrderGameAttempt> {
    const session = this.sessions.get(attempt.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${attempt.sessionId}`);
    }
    assertNotTerminal(session);

    const sessionTeams = this.teams.get(attempt.sessionId) ?? [];
    if (!sessionTeams.some((team) => team.teamId === attempt.teamId)) {
      throw new Error(`Team ${attempt.teamId} is not registered for session ${attempt.sessionId}`);
    }

    const attempts = this.attempts.get(attempt.sessionId) ?? [];
    if (attempts.some((a) => a.teamId === attempt.teamId)) {
      throw new Error(`Team ${attempt.teamId} already attempted mini-game for session ${attempt.sessionId}`);
    }

    const record: DraftOrderGameAttempt = {
      id: attempt.id ?? randomUUID(),
      sessionId: attempt.sessionId,
      teamId: attempt.teamId,
      status: attempt.status,
      reactionMs: attempt.reactionMs,
      rawInput: attempt.rawInput,
      attemptAt: attempt.attemptAt ?? new Date()
    };

    this.attempts.set(attempt.sessionId, [...attempts, record]);
    return record;
  }

  async listAttempts(sessionId: string): Promise<DraftOrderGameAttempt[]> {
    return [...(this.attempts.get(sessionId) ?? [])];
  }

  async appendEvent<TPayload = unknown>(event: DraftOrderEventCreate<TPayload>): Promise<DraftOrderEvent<TPayload>> {
    const session = this.sessions.get(event.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${event.sessionId}`);
    }

    const events = this.events.get(event.sessionId) ?? [];
    const seq = events.length + 1;
    const record: DraftOrderEvent<TPayload> = {
      id: event.id ?? randomUUID(),
      sessionId: event.sessionId,
      seq,
      type: event.type,
      payload: event.payload,
      createdBy: event.createdBy,
      createdAt: event.createdAt ?? new Date()
    };

    this.events.set(event.sessionId, [...events, record]);
    return record;
  }

  async listEvents(sessionId: string): Promise<DraftOrderEvent[]> {
    return [...(this.events.get(sessionId) ?? [])];
  }
}
