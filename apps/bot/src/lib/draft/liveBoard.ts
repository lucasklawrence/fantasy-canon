/**
 * Controls a persistent **channel message** that mirrors the live draft board. Because it's a normal
 * bot-token message (not a slash-command interaction response), it can be edited for the whole draft
 * — past the 15-min interaction-token death that kills `/canon draft best|status` responses.
 *
 * Edits are **coalesced**: each new pick marks the board dirty and a single in-flight editor renders
 * the latest state, so a burst of auto-picks collapses into one queued edit instead of a backlog.
 * discord.js's REST layer already serializes message edits per-route and transparently waits out 429
 * `Retry-After` before resolving, so the only thing this controller must avoid is firing overlapping
 * edits — hence the `flushing` guard rather than any hard-coded cadence (there is no flat rate ceiling
 * to code against; the real limit is per-route buckets the library handles).
 */

import type { MessageEditOptions } from 'discord.js';

/** The slice of discord.js `Message` we need — structural so the controller is unit-testable. */
export interface EditableMessage {
  edit(payload: MessageEditOptions): Promise<unknown>;
}

export interface LiveBoardOptions {
  /** The already-posted channel message to keep in sync. */
  message: EditableMessage;
  /** Render the latest board payload from current session state (called fresh on each flush). */
  render: () => MessageEditOptions;
  /** Fired when an edit rejects (permissions, deleted message, …); the controller stays alive. */
  onError?: (error: unknown) => void;
}

export interface LiveBoardHandle {
  /** Note that the board is out of date; schedules a coalesced re-render + edit. */
  markDirty(): void;
  /** Stop updating (draft ended / replaced). Further `markDirty` calls are ignored. */
  stop(): void;
}

/**
 * Wrap a posted message in a dirty-flag editor. `markDirty()` is cheap and idempotent within a burst:
 * the first call starts a flush loop that keeps editing while the board is dirty, and concurrent calls
 * during an in-flight edit just re-arm the flag so the loop renders once more with the newest state.
 */
export function createLiveBoard(opts: LiveBoardOptions): LiveBoardHandle {
  let dirty = false;
  let flushing = false;
  let stopped = false;

  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      // Re-check `dirty` each turn: picks that land while an edit is in flight re-arm it, so the
      // latest state is rendered without queuing an edit per pick.
      while (dirty && !stopped) {
        dirty = false;
        try {
          await opts.message.edit(opts.render());
        } catch (error) {
          opts.onError?.(error);
          // A genuine edit failure (429s are handled by the REST layer, so this is 4xx/network).
          // Leave the loop; the next pick's markDirty() will retry rather than spinning here.
          break;
        }
      }
    } finally {
      flushing = false;
    }
  }

  return {
    markDirty() {
      if (stopped) return;
      dirty = true;
      void flush();
    },
    stop() {
      stopped = true;
    },
  };
}
