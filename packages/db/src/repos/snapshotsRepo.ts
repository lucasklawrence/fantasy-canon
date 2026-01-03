import { SnapshotMeta } from "@fantasy-canon/shared";

export interface SnapshotRecord extends SnapshotMeta {
  payload: unknown;
}

export interface SnapshotsRepo {
  save(record: SnapshotRecord): Promise<void>;
  listBySeason(leagueId: string, season: number): Promise<SnapshotRecord[]>;
}

export class InMemorySnapshotsRepo implements SnapshotsRepo {
  private readonly storage = new Map<string, SnapshotRecord[]>();

  save(record: SnapshotRecord): Promise<void> {
    const key = this.composeKey(record.leagueId, record.season);
    const existing = this.storage.get(key) ?? [];
    this.storage.set(key, [...existing, record]);
    return Promise.resolve();
  }

  listBySeason(leagueId: string, season: number): Promise<SnapshotRecord[]> {
    const key = this.composeKey(leagueId, season);
    return Promise.resolve(this.storage.get(key) ?? []);
  }

  private composeKey(leagueId: string, season: number): string {
    return `${leagueId}-${season}`;
  }
}
