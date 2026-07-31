/**
 * Ceremony sound (#216): the roll's timing plan is the one piece of logic that could quietly
 * regress when pacing changes — live windows run 5–20s, replay/catch-up compress to 2.5s, and the
 * plan has to stay sane at both extremes (and at pathological inputs). The synthesis itself is a
 * browser module verified by ear, like the hopper sim.
 */

import { describe, expect, it } from 'vitest';

import { rollPlan } from '../client/rollPlan.js';

describe('rollPlan', () => {
  it('peaks just before the reveal is due at live pacing', () => {
    const plan = rollPlan(20000);
    expect(plan.crescendoEndMs).toBe(19800);
    expect(plan.attackMs).toBe(300);
    expect(plan.autoStopMs).toBe(21500);
  });

  it('stays ordered at the compressed replay window', () => {
    const plan = rollPlan(2500);
    expect(plan.attackMs).toBeLessThan(plan.crescendoEndMs);
    expect(plan.crescendoEndMs).toBeLessThan(plan.autoStopMs);
    expect(plan.crescendoEndMs).toBe(2300);
  });

  it('clamps degenerate windows instead of producing a zero-length roll', () => {
    for (const windowMs of [0, 100, 500]) {
      const plan = rollPlan(windowMs);
      expect(plan.attackMs).toBeGreaterThan(0);
      expect(plan.attackMs).toBeLessThan(plan.crescendoEndMs);
      expect(plan.crescendoEndMs).toBeGreaterThanOrEqual(500);
      expect(plan.autoStopMs).toBeGreaterThan(plan.crescendoEndMs);
    }
  });

  it('always leaves the failsafe stop after the window, so an abandoned roll ends itself', () => {
    for (const windowMs of [800, 2500, 5000, 20000]) {
      expect(rollPlan(windowMs).autoStopMs).toBeGreaterThan(windowMs);
    }
  });
});
