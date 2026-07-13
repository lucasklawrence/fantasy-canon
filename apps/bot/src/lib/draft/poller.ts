/**
 * Drives any {@link DraftSource} into a live session: poll the source, diff its snapshot against
 * what the session already knows, and apply only the fresh picks. Works identically for the manual
 * source and the ESPN capture sink — the whole point of the {@link DraftSource} seam.
 *
 * {@link pollOnce} is the pure-ish unit (one drain); {@link runDraftPoller} just schedules it on an
 * interval and is what the `start source:espn` command uses to keep the session current as picks are
 * pushed in from the browser.
 */

import {
  applyPick,
  diffNewPicks,
  type DraftPick,
  type DraftSession,
  type DraftSource,
} from '@fantasy-canon/core';

export interface DraftPollerCallbacks {
  /** Read the current session (called fresh each pick so concurrent updates compose). */
  getSession: () => DraftSession;
  /** Commit an updated session. */
  setSession: (session: DraftSession) => void;
  /** Fired once per newly-applied pick. */
  onPick?: (pick: DraftPick, session: DraftSession) => void;
  /** Fired when a poll throws; the loop keeps going. */
  onError?: (error: unknown) => void;
}

/** Poll the source once and apply any picks the session hasn't seen. Returns the fresh picks. */
export async function pollOnce(
  source: DraftSource,
  callbacks: DraftPollerCallbacks,
): Promise<DraftPick[]> {
  const snapshot = await source.poll();
  const fresh = diffNewPicks(callbacks.getSession().draftedKeys, snapshot.picks);
  const applied: DraftPick[] = [];
  for (const pick of fresh) {
    const next = applyPick(callbacks.getSession(), pick);
    callbacks.setSession(next);
    callbacks.onPick?.(pick, next);
    applied.push(pick);
  }
  return applied;
}

export interface DraftPollerHandle {
  stop: () => void;
}

/** Poll `source` every `intervalMs`, draining new picks into the session until stopped. */
export function runDraftPoller(
  source: DraftSource,
  callbacks: DraftPollerCallbacks,
  intervalMs = 1500,
): DraftPollerHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pollOnce(source, callbacks);
    } catch (error) {
      callbacks.onError?.(error);
    }
    if (!stopped) timer = setTimeout(() => void loop(), intervalMs);
  };

  timer = setTimeout(() => void loop(), intervalMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
