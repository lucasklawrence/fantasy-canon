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

function record(commitment: string, overrides: Partial<PersistedCeremony> = {}): PersistedCeremony {
  return {
    guildId: 'guild-1',
    channelId: 'chan-1',
    title: '2026 Draft Lottery',
    config: { teams: [{ teamId: 'a' }, { teamId: 'b' }], baseBallCount: 1 },
    names: [
      ['a', 'Alpha'],
      ['b', 'Bravo'],
    ],
    secretSeed: 'seed-hex',
    commitment,
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
    store.saveCommitted(record('commit-1'));

    // A fresh store instance reads the same file — survives a "restart".
    const reopened = createFileCeremonyStore({ filePath });
    const pending = reopened.loadPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      commitment: 'commit-1',
      channelId: 'chan-1',
      secretSeed: 'seed-hex',
      commitMessageId: 'msg-1',
    });
  });

  it('keys by commitment so a second run for the same guild does not clobber the first', () => {
    const store = createFileCeremonyStore({ filePath });
    // Same guild, two distinct commitments (e.g. a failed-disclosure run + its re-run).
    store.saveCommitted(record('commit-old'));
    store.saveCommitted(record('commit-new'));
    expect(store.loadPending()).toHaveLength(2);

    // Overwriting the same commitment updates in place (pre-post record → post-update record).
    store.saveCommitted(record('commit-new', { commitMessageId: 'msg-2' }));
    expect(store.loadPending()).toHaveLength(2);
    expect(store.loadPending().find((r) => r.commitment === 'commit-new')?.commitMessageId).toBe(
      'msg-2',
    );

    store.remove('commit-old');
    const left = store.loadPending();
    expect(left).toHaveLength(1);
    expect(left[0].commitment).toBe('commit-new');
  });

  it('is empty (never throws) when the file is missing or corrupt', () => {
    const store = createFileCeremonyStore({ filePath });
    expect(store.loadPending()).toEqual([]);
    expect(() => store.remove('nope')).not.toThrow();

    writeFileSync(path.join(dir, 'corrupt.json'), '{not json');
    const corrupt = createFileCeremonyStore({ filePath: path.join(dir, 'corrupt.json') });
    expect(corrupt.loadPending()).toEqual([]);
  });

  it('skips damaged records so one bad entry cannot hide the valid ones', () => {
    const badFile = path.join(dir, 'mixed.json');
    writeFileSync(
      badFile,
      JSON.stringify({ bad: null, alsoBad: { guildId: 'g' }, good: record('commit-good') }),
    );
    const store = createFileCeremonyStore({ filePath: badFile });
    const pending = store.loadPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].commitment).toBe('commit-good');
  });
});
