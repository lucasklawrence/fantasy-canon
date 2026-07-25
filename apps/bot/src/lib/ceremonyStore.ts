/**
 * Durable store for committed-but-unfinalized lottery ceremonies (#176, ADR 0006).
 *
 * The ceremony's secret seed, commitment, and commit-message id live only in the bot process's
 * memory. If the bot restarts **after the commitment post but before the seed reveal**, that secret
 * is lost — the public commitment can never be opened, breaking the one promise commit-reveal
 * exists to keep. This persists the committed record so a restarted bot can still disclose the seed.
 *
 * Interim implementation per the issue: a single dependency-free JSON file (the `db` package is
 * still a `NoopDbClient`). The seed is only secret until reveal, so at-rest protection is a
 * nice-to-have, not required — but the file DOES hold a pre-reveal seed, so it must stay gitignored.
 * The {@link CeremonyStore} seam is injected into the ceremony runner + startup recovery so both
 * unit-test against an in-memory fake with no filesystem.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DraftOrderState, LotteryConfig } from '@fantasy-canon/core';

/** The subset of a ceremony session that must survive a restart to keep the disclosure promise. */
export interface PersistedCeremony {
  guildId: string;
  /** Origin channel — startup recovery posts the seed disclosure here. */
  channelId: string;
  title: string;
  config: LotteryConfig;
  /** teamId → display name, as entries (a `Map` isn't JSON-serializable). */
  names: [string, string][];
  secretSeed: string;
  commitment: string;
  commitMessageId: string;
  drawSeed?: string;
  state: DraftOrderState;
  createdAt: number;
}

export interface CeremonyStore {
  /** Persist (or overwrite) the committed record for a guild. */
  saveCommitted(record: PersistedCeremony): void;
  /** Drop a guild's record — called once the seed has been disclosed (finalize or abort). */
  remove(guildId: string): void;
  /** Every persisted record: each is a committed ceremony that never finalized (i.e. interrupted). */
  loadPending(): PersistedCeremony[];
}

export interface FileCeremonyStoreOptions {
  /** Overrides the default file location (used by tests). */
  filePath?: string;
}

/**
 * Default state file: `$FANTASY_STATE_DIR`, else `.data/` under the process's working directory.
 * A cwd dir (not a temp dir) so the record survives a host reboot, not just a process restart — a
 * lost record means an unopenable commitment. `.data/` is gitignored (it holds a pre-reveal seed).
 */
export function defaultStateFile(): string {
  const dir = process.env.FANTASY_STATE_DIR ?? path.join(process.cwd(), '.data');
  return path.join(dir, 'draftorder-ceremonies.json');
}

function readAll(filePath: string): Record<string, PersistedCeremony> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    // A corrupt/partial file must never crash startup — treat it as empty and move on.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, PersistedCeremony>;
    }
    return {};
  } catch {
    return {};
  }
}

function writeAll(filePath: string, records: Record<string, PersistedCeremony>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  // Write to a temp file then atomically rename, so a crash mid-write can't leave a half-written
  // state file (renameSync overwrites the destination on both POSIX and Windows).
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, filePath);
}

/** A JSON-file {@link CeremonyStore}, keyed by guildId (one active ceremony per guild). */
export function createFileCeremonyStore(options: FileCeremonyStoreOptions = {}): CeremonyStore {
  const filePath = options.filePath ?? defaultStateFile();
  return {
    saveCommitted(record) {
      const all = readAll(filePath);
      all[record.guildId] = record;
      writeAll(filePath, all);
    },
    remove(guildId) {
      const all = readAll(filePath);
      if (guildId in all) {
        delete all[guildId];
        writeAll(filePath, all);
      }
    },
    loadPending() {
      return Object.values(readAll(filePath));
    },
  };
}

/** An in-memory {@link CeremonyStore} for tests (no filesystem). */
export function createMemoryCeremonyStore(): CeremonyStore {
  const all = new Map<string, PersistedCeremony>();
  return {
    saveCommitted: (record) => void all.set(record.guildId, record),
    remove: (guildId) => void all.delete(guildId),
    loadPending: () => [...all.values()],
  };
}
