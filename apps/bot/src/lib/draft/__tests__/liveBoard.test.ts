import type { MessageEditOptions } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { createLiveBoard, type EditableMessage } from '../liveBoard.js';

/** Flush pending microtasks + timers so the coalescing loop can drain. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createLiveBoard', () => {
  it('coalesces a burst of markDirty calls into fewer edits, rendering the latest state last', async () => {
    let releaseFirst!: () => void;
    const firstEditInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let renders = 0;
    const edited: unknown[] = [];
    const edit = vi.fn(async (payload: unknown) => {
      edited.push(payload);
      // Hold the first edit open so the burst below lands while it's in flight.
      if (edited.length === 1) await firstEditInFlight;
    });
    const message: EditableMessage = { edit };

    const board = createLiveBoard({ message, render: () => ({ content: `render ${++renders}` }) });

    board.markDirty(); // starts the flush; first edit begins and parks on firstEditInFlight
    board.markDirty();
    board.markDirty();
    board.markDirty(); // three more picks land while the first edit is still in flight

    releaseFirst();
    await settle();

    // 4 markDirty calls collapsed to 2 edits (one in flight + one coalesced for the rest)...
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edited.length).toBeLessThan(4);
    // ...and the final edit reflects the newest render, not a stale one.
    expect(edited[edited.length - 1]).toEqual({ content: 'render 2' });
  });

  it('stops editing after stop()', async () => {
    const edit = vi.fn((): Promise<void> => Promise.resolve());
    const board = createLiveBoard({ message: { edit }, render: () => ({ content: 'x' }) });

    board.stop();
    board.markDirty();
    await settle();

    expect(edit).not.toHaveBeenCalled();
  });

  it('surfaces an edit failure via onError without throwing', async () => {
    const onError = vi.fn();
    const edit = vi.fn((): Promise<void> => Promise.reject(new Error('edit rejected')));
    const board = createLiveBoard({
      message: { edit },
      render: () => ({ content: 'x' }),
      onError,
      retryDelayMs: 10_000, // long enough that the retry can't fire during the test
    });

    board.markDirty();
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    board.stop(); // clear the pending retry timer
  });

  it('recovers a pick stranded by a failed edit via a delayed retry (no further markDirty)', async () => {
    let releaseFirst!: () => void;
    const firstEditInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const onError = vi.fn();
    const committed: unknown[] = [];
    let attempt = 0;
    let renders = 0;
    const edit = vi.fn((payload: MessageEditOptions): Promise<void> => {
      attempt += 1;
      // First edit stays in flight, then rejects — while a second pick lands behind it.
      if (attempt === 1) {
        return firstEditInFlight.then(() => {
          throw new Error('boom');
        });
      }
      committed.push(payload.content);
      return Promise.resolve();
    });

    const board = createLiveBoard({
      message: { edit },
      render: () => ({ content: `render ${++renders}` }),
      onError,
      retryDelayMs: 10,
    });

    board.markDirty(); // first edit begins and parks on firstEditInFlight
    board.markDirty(); // a pick lands while the (doomed) first edit is still in flight
    releaseFirst();
    await settle();

    // The failed edit re-armed dirty; nothing else marks the board, so only the retry can recover it.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 40));

    // The retry fired on its own and committed the latest render — the update wasn't stranded.
    expect(edit).toHaveBeenCalledTimes(2);
    expect(committed).toEqual(['render 2']);
    board.stop();
  });
});
