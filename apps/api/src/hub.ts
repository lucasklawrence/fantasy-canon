/**
 * The in-memory draft hub — the reusable core of the Activity backend, with no transport in it.
 *
 * Holds one live {@link DraftSession} + the loaded pool, ingests picks idempotently (via
 * `diffNewPicks`, so re-POSTing the same board is a no-op), and re-projects the {@link AdviceView}
 * with `buildAdviceView` on every change. Subscribers (the WebSocket shell) are notified with a fresh
 * snapshot whenever the board moves. Everything here is deterministic given its inputs — the HTTP/WS
 * server in `server.ts` is the only side-effectful part — so the hub unit-tests without a socket.
 */

import {
  applyPicks,
  buildAdviceView,
  createDraftSession,
  diffNewPicks,
  type AdpProvenance,
  type AdviceView,
  type DraftPick,
  type DraftSession,
  type PlayerTier,
} from '@fantasy-canon/core';

export interface DraftHubConfig {
  leagueSize: number;
  /** Your 1-based draft slot. */
  mySlot: number;
  rosterSlots: Record<string, number>;
  pool: PlayerTier[];
  /** ADP provenance, surfaced to the dashboard so stale market data is visible. */
  adp?: AdpProvenance;
}

/** What the backend serves and pushes: the projection plus a human status line. */
export interface HubSnapshot {
  view: AdviceView;
  status: string;
}

export interface IngestResult {
  /** Picks that were new (already-known picks are filtered out by name). */
  added: DraftPick[];
  /** Total picks on the board after ingest. */
  picks: number;
}

export interface DraftHub {
  snapshot(): HubSnapshot;
  /** The overall number a bare "next pick" entry would take. */
  nextOverall(): number;
  ingest(picks: DraftPick[]): IngestResult;
  reset(): void;
  /** Subscribe to board changes; returns an unsubscribe fn. */
  subscribe(listener: (snap: HubSnapshot) => void): () => void;
}

export function createDraftHub(config: DraftHubConfig): DraftHub {
  const { leagueSize, mySlot, rosterSlots, pool, adp } = config;
  const fresh = (): DraftSession =>
    createDraftSession({ leagueSize, myTeamId: mySlot, rosterSlots });

  let session = fresh();
  const listeners = new Set<(snap: HubSnapshot) => void>();

  function snapshot(): HubSnapshot {
    // `buildAdviceView` derives `complete` from the board itself (picks vs leagueSize×rounds).
    const view = buildAdviceView(session, pool, { adp });
    const status = view.complete
      ? 'draft complete'
      : session.picks.length === 0
        ? 'waiting for the first pick'
        : 'watching draft';
    return { view, status };
  }

  function emit(): void {
    const snap = snapshot();
    for (const listener of listeners) listener(snap);
  }

  return {
    snapshot,
    nextOverall: () => session.picks.length + 1,
    ingest(picks) {
      const added = diffNewPicks(session.draftedKeys, picks);
      if (added.length > 0) {
        session = applyPicks(session, added);
        emit();
      }
      return { added, picks: session.picks.length };
    },
    reset() {
      session = fresh();
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
