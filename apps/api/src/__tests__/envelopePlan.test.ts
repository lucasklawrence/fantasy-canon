import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_LEAD_MS,
  ENVELOPE_MS,
  envelopeEligible,
  finaleHoldMs,
  finaleSubject,
} from '../client/envelopePlan.js';
import { exitBudget, EXTRACT_CAP_MS, FINISH_LEAD_MS, FLIP_MS } from '../client/exitBudget.js';
import { REPLAY_DWELL_MS } from '../client/replayTimeline.js';

describe('envelopeEligible (#243)', () => {
  it('plays only for pick #1 — whenever it occurs, so both reveal orders work (#200)', () => {
    // worst-to-first ends on pick 1; first-to-last opens with it. Same rule either way.
    expect(envelopeEligible(1, null, false, false)).toBe(true);
    for (const pick of [2, 3, 12]) {
      expect(envelopeEligible(pick, null, false, false)).toBe(false);
    }
  });

  it('plays live and in full-pace replay, never in a catch-up sprint', () => {
    expect(envelopeEligible(1, null, false, false)).toBe(true);
    expect(envelopeEligible(1, 'replay', false, false)).toBe(true);
    // A catch-up compresses the timeline to reach the present — holding the viewer for a
    // ceremony overlay would be the opposite of what they asked for.
    expect(envelopeEligible(1, 'catchup', false, false)).toBe(false);
  });

  it('skips hidden tabs and reduced motion — the reveal state beneath is already correct', () => {
    expect(envelopeEligible(1, null, true, false)).toBe(false);
    expect(envelopeEligible(1, null, false, true)).toBe(false);
  });

  it('timing constants stay sane: the overlay outlives its own open animations', () => {
    // The card settles ~1.4s into the overlay's life; anything shorter than that plus a beat of
    // dwell would dismiss mid-animation. Guards accidental constant edits, not taste.
    expect(ENVELOPE_MS).toBeGreaterThanOrEqual(2500);
    expect(ENVELOPE_LEAD_MS.race).toBeGreaterThanOrEqual(900); // the lock park must land first
    expect(ENVELOPE_LEAD_MS.machine).toBeGreaterThanOrEqual(0);
  });

  /**
   * #244. Adding a visual must be a deliberate act. The wheel's lead shipped at 2400ms against an
   * 1800ms gap and nothing complained, because every check named `machine` and `race` explicitly —
   * a third visual was invisible to all of them. The `keys` assertion is the part that matters.
   *
   * The bound itself is now hygiene rather than correctness (the finish waits — see below), but a
   * lead longer than a natural reveal gap still means the ceremony is sitting on its hands.
   */
  it('every visual states a lead, and none of them dawdles', () => {
    expect(Object.keys(ENVELOPE_LEAD_MS).sort()).toEqual(['machine', 'race', 'wheel']);
    for (const [visual, lead] of Object.entries(ENVELOPE_LEAD_MS)) {
      expect(lead, `${visual} lead must fit the finish gap`).toBeLessThan(FINISH_LEAD_MS);
    }
  });

  /**
   * #243 live feedback, and the reason #269's invariant is gone rather than merely relaxed.
   *
   * That invariant said the machine's exit plus its lead had to finish inside `FINISH_LEAD_MS`, or
   * the overlay would dim a board the ball had already left. It held the lead to 100ms — which the
   * commissioner reported as no pause at all: the card lands and the screen is already dimming.
   *
   * The ordering is now guaranteed by the client holding the sweep instead of racing it, so the
   * arithmetic that follows is the new contract: the hold must COVER the worst real finale, and
   * must still be bounded, because a board that never arrives is worse than one that arrives early.
   */
  it('the finale hold covers the machine’s worst case, on both the live and replay gaps', () => {
    for (const gap of [FINISH_LEAD_MS, REPLAY_DWELL_MS]) {
      const exit = exitBudget(gap);
      const hold = finaleHoldMs(ENVELOPE_LEAD_MS.machine, exit.totalMs);
      expect(hold, `gap ${gap}`).toBeGreaterThanOrEqual(
        exit.totalMs + ENVELOPE_LEAD_MS.machine + ENVELOPE_MS,
      );
    }
  });

  it('the finale hold covers a stalled extraction, where the exit runs to its cap', () => {
    // The extraction resolves off the sim's rAF loop, which a throttled tab may barely run. The
    // caller arms the hold against that cap, so the worst case still fits.
    const hold = finaleHoldMs(ENVELOPE_LEAD_MS.machine, EXTRACT_CAP_MS + FLIP_MS);
    expect(hold).toBeGreaterThan(EXTRACT_CAP_MS + FLIP_MS + ENVELOPE_MS);
  });

  it('the finale hold stays bounded — a finale that never opens must not strand the board', () => {
    // Every visual, worst exit. Ten seconds is already generous for a 3.6s overlay; past that a
    // viewer is staring at a stage the ceremony has finished with, waiting on a timer.
    for (const [visual, lead] of Object.entries(ENVELOPE_LEAD_MS)) {
      const hold = finaleHoldMs(lead, EXTRACT_CAP_MS + FLIP_MS);
      expect(hold, `${visual} hold must stay bounded`).toBeLessThanOrEqual(10_000);
    }
  });

  /**
   * The finale is re-openable from the sealed board (live feedback), so "who is it about" has to
   * be answerable by a viewer who never saw the ceremony — a late joiner lands on 'finished' with
   * an order and no reveal history.
   */
  it('names the finale’s subject from whichever list the caller has', () => {
    const order = [
      { pick: 2, team: 'Geese' },
      { pick: 1, team: 'Ducks' },
      { pick: 3, team: 'Swans' },
    ];
    expect(finaleSubject(order)).toBe('Ducks'); // not the first entry — the one holding pick #1
    expect(finaleSubject([...order].reverse())).toBe('Ducks'); // order of the list is irrelevant
  });

  it('refuses to guess when the draw has produced no pick #1', () => {
    // A board mid-draw, and an empty one. Offering to re-open an envelope that was never sealed
    // would be a button that lies — the caller hides it on null.
    expect(
      finaleSubject([
        { pick: 12, team: 'Ducks' },
        { pick: 11, team: 'Geese' },
      ]),
    ).toBeNull();
    expect(finaleSubject([])).toBeNull();
  });

  it('treats a negative or absent leg as zero rather than shortening the hold', () => {
    // Defensive: `performance.now()` deltas and a re-planned exit can both hand this a negative.
    // Shortening the hold would release the board mid-ceremony, which is the bug it exists to fix.
    expect(finaleHoldMs(-500, -500)).toBe(ENVELOPE_MS);
    expect(finaleHoldMs(0, 0)).toBe(ENVELOPE_MS);
  });
});
