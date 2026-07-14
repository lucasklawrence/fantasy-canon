/**
 * In-memory registry of live draft sessions, keyed by Discord channel (one draft per channel). Holds
 * the session reducer state plus the loaded pool and any ESPN capture plumbing, so `pick`, `best`,
 * `status`, and `stop` all operate on the same running draft that `start` created.
 *
 * Intentionally process-local and ephemeral — a draft lasts an hour or two and doesn't need to
 * survive a bot restart. If persistence is ever wanted, this is the one place to swap.
 */

import type { DraftSession, FadeEntry, PlayerTier } from '@fantasy-canon/core';
import type { AdpProvenance } from '../draftPool.js';
import type { EspnSinkDraftSource } from './espnSinkSource.js';
import type { DraftPollerHandle } from './poller.js';
import type { LiveBoardHandle } from './liveBoard.js';

export type DraftSourceKind = 'manual' | 'espn';

export interface LiveDraft {
  session: DraftSession;
  pool: PlayerTier[];
  fades: FadeEntry[];
  adp?: AdpProvenance;
  teams: number;
  slot: number;
  sourceKind: DraftSourceKind;
  /** ESPN capture sink + poller, present only for `source:espn` drafts. */
  sink?: EspnSinkDraftSource;
  poller?: DraftPollerHandle;
  /** Self-updating channel board (`/canon draft board`), present once posted. Edits past 15-min tokens. */
  liveBoard?: LiveBoardHandle;
  createdAt: number;
}

const drafts = new Map<string, LiveDraft>();

export function getDraft(key: string): LiveDraft | undefined {
  return drafts.get(key);
}

export function setDraft(key: string, draft: LiveDraft): void {
  drafts.set(key, draft);
}

/** Tear down a draft: stop polling, close the capture sink, and forget it. */
export async function endDraft(key: string): Promise<boolean> {
  const draft = drafts.get(key);
  if (!draft) return false;
  draft.poller?.stop();
  draft.liveBoard?.stop();
  await draft.sink?.close();
  drafts.delete(key);
  return true;
}
