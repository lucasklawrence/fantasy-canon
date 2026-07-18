import { assertTransition, canTransition, isTerminalState } from '../state.js';
import type { DraftOrderState } from '../types.js';

describe('draft-order state machine', () => {
  it('allows the happy path CREATED → GAME_OPEN → LOTTERY_RUNNING → FINALIZED', () => {
    expect(() => {
      assertTransition('CREATED', 'GAME_OPEN');
      assertTransition('GAME_OPEN', 'LOTTERY_RUNNING');
      assertTransition('LOTTERY_RUNNING', 'FINALIZED');
    }).not.toThrow();
  });

  it('allows cancelling before finalization but not after', () => {
    expect(canTransition('CREATED', 'CANCELLED')).toBe(true);
    expect(canTransition('GAME_OPEN', 'CANCELLED')).toBe(true);
    expect(canTransition('LOTTERY_RUNNING', 'CANCELLED')).toBe(true);
    expect(canTransition('FINALIZED', 'CANCELLED')).toBe(false);
  });

  it('rejects skipping states or leaving a terminal state', () => {
    expect(() => assertTransition('CREATED', 'FINALIZED')).toThrow('Invalid state transition');
    expect(() => assertTransition('FINALIZED', 'GAME_OPEN')).toThrow('Invalid state transition');
    expect(() => assertTransition('CANCELLED', 'CREATED')).toThrow('Invalid state transition');
  });

  it('flags exactly FINALIZED, CANCELLED, and EXPIRED as terminal', () => {
    const terminal: DraftOrderState[] = ['FINALIZED', 'CANCELLED', 'EXPIRED'];
    const active: DraftOrderState[] = ['CREATED', 'GAME_OPEN', 'LOTTERY_RUNNING'];
    for (const state of terminal) {
      expect(isTerminalState(state)).toBe(true);
    }
    for (const state of active) {
      expect(isTerminalState(state)).toBe(false);
    }
  });
});
