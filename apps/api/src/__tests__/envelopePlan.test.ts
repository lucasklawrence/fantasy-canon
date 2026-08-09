import { describe, expect, it } from 'vitest';
import { ENVELOPE_LEAD_MS, ENVELOPE_MS, envelopeEligible } from '../client/envelopePlan.js';
import { FINISH_LEAD_MS } from '../client/exitBudget.js';

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
   * #244. Every visual's finale has to open before the finish sweeps the stage, and the amount of
   * room is the same for all of them — the last reveal is followed by the finish `FINISH_LEAD_MS`
   * later, full stop.
   *
   * Written over the whole key set rather than one visual at a time, because the wheel's lead was
   * added at 2400ms against an 1800ms gap and nothing complained: the existing checks named
   * `machine` and `race` explicitly, so a third visual was invisible to them. The `keys` assertion
   * is the part that matters — adding a fourth visual now fails here until someone states its
   * budget.
   */
  it('every visual opens its finale before the finish sweeps the stage', () => {
    expect(Object.keys(ENVELOPE_LEAD_MS).sort()).toEqual(['machine', 'race', 'wheel']);
    for (const [visual, lead] of Object.entries(ENVELOPE_LEAD_MS)) {
      expect(lead, `${visual} lead must fit the finish gap`).toBeLessThan(FINISH_LEAD_MS);
    }
  });
});
