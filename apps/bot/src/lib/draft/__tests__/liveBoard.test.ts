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

  it('reports an edit failure via onError without throwing, and retries on the next pick', async () => {
    const onError = vi.fn();
    let fail = true;
    const edit = vi.fn((): Promise<void> =>
      fail ? Promise.reject(new Error('edit rejected')) : Promise.resolve(),
    );
    const board = createLiveBoard({ message: { edit }, render: () => ({ content: 'x' }), onError });

    board.markDirty();
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);

    // The controller isn't wedged after a failure — a later pick edits again.
    fail = false;
    board.markDirty();
    await settle();
    expect(edit).toHaveBeenCalledTimes(2);
  });
});
