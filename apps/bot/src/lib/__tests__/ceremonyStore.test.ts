import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileCeremonyStore, type PersistedCeremony } from '../ceremonyStore.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fc-ceremony-store-'));
  filePath = path.join(dir, 'nested', 'draftorder-ceremonies.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(guildId: string, overrides: Partial<PersistedCeremony> = {}): PersistedCeremony {
  return {
    guildId,
    channelId: `chan-${guildId}`,
    title: '2026 Draft Lottery',
    config: { teams: [{ teamId: 'a' }, { teamId: 'b' }], baseBallCount: 1 },
    names: [
      ['a', 'Alpha'],
      ['b', 'Bravo'],
    ],
    secretSeed: 'seed-hex',
    commitment: 'commit-hex',
    commitMessageId: 'msg-1',
    drawSeed: 'seed-hex|msg-1',
    state: 'LOTTERY_RUNNING',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('createFileCeremonyStore', () => {
  it('round-trips a committed record (creating the parent dir)', () => {
    const store = createFileCeremonyStore({ filePath });
    store.saveCommitted(record('g1'));

    // A fresh store instance reads the same file — survives a "restart".
    const reopened = createFileCeremonyStore({ filePath });
    const pending = reopened.loadPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      guildId: 'g1',
      channelId: 'chan-g1',
      secretSeed: 'seed-hex',
      commitMessageId: 'msg-1',
    });
  });

  it('keys by guild, overwrites on re-save, and removes', () => {
    const store = createFileCeremonyStore({ filePath });
    store.saveCommitted(record('g1', { commitment: 'first' }));
    store.saveCommitted(record('g2'));
    store.saveCommitted(record('g1', { commitment: 'second' }));

    expect(store.loadPending()).toHaveLength(2);
    expect(store.loadPending().find((r) => r.guildId === 'g1')?.commitment).toBe('second');

    store.remove('g1');
    const left = store.loadPending();
    expect(left).toHaveLength(1);
    expect(left[0].guildId).toBe('g2');
  });

  it('is empty (never throws) when the file is missing or corrupt', () => {
    const store = createFileCeremonyStore({ filePath });
    expect(store.loadPending()).toEqual([]);
    expect(() => store.remove('nope')).not.toThrow();

    writeFileSync(path.join(dir, 'corrupt.json'), '{not json');
    const corrupt = createFileCeremonyStore({ filePath: path.join(dir, 'corrupt.json') });
    expect(corrupt.loadPending()).toEqual([]);
  });
});
