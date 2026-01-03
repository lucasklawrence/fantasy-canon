export type CanonEventType = "champion" | "luck" | "draft" | "custom";

export interface CanonEventRecord {
  id: string;
  leagueId: string;
  season: number;
  type: CanonEventType;
  message: string;
  createdAt: Date;
}

export interface CanonEventCreate {
  leagueId: string;
  season: number;
  type: CanonEventType;
  message: string;
  createdAt?: Date;
}

export interface CanonEventsRepo {
  add(event: CanonEventCreate): Promise<CanonEventRecord>;
  list(params: { leagueId: string; season?: number; limit?: number; offset?: number }): Promise<CanonEventRecord[]>;
}

import crypto from "node:crypto";

export class InMemoryCanonEventsRepo implements CanonEventsRepo {
  private readonly events: CanonEventRecord[] = [];

  async add(event: CanonEventCreate): Promise<CanonEventRecord> {
    const record: CanonEventRecord = {
      id: crypto.randomUUID(),
      createdAt: event.createdAt ?? new Date(),
      ...event
    };
    this.events.push(record);
    return record;
  }

  async list(params: { leagueId: string; season?: number; limit?: number; offset?: number }): Promise<CanonEventRecord[]> {
    const { leagueId, season, limit = 20, offset = 0 } = params;
    const filtered = this.events
      .filter((e) => e.leagueId === leagueId)
      .filter((e) => (season ? e.season === season : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return filtered.slice(offset, offset + limit);
  }
}
