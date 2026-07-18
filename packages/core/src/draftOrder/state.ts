/**
 * Lifecycle state machine for a lottery ceremony:
 * `CREATED → GAME_OPEN → LOTTERY_RUNNING → FINALIZED`, with `CANCELLED`/`EXPIRED` as early
 * exits. `FINALIZED`, `CANCELLED`, and `EXPIRED` are terminal.
 */
import type { DraftOrderState } from './types.js';

const transitions: Record<DraftOrderState, DraftOrderState[]> = {
  CREATED: ['GAME_OPEN', 'CANCELLED', 'EXPIRED'],
  GAME_OPEN: ['LOTTERY_RUNNING', 'CANCELLED', 'EXPIRED'],
  LOTTERY_RUNNING: ['FINALIZED', 'CANCELLED'],
  FINALIZED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function assertTransition(current: DraftOrderState, next: DraftOrderState): void {
  if (!canTransition(current, next)) {
    throw new Error(`Invalid state transition from ${current} to ${next}`);
  }
}

export function canTransition(current: DraftOrderState, next: DraftOrderState): boolean {
  return transitions[current].includes(next);
}

export function isTerminalState(state: DraftOrderState): boolean {
  return transitions[state].length === 0;
}
