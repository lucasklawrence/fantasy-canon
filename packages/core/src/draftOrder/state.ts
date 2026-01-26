import { DraftOrderState } from "./types.js";

const transitions: Record<DraftOrderState, DraftOrderState[]> = {
  CREATED: ["GAME_OPEN", "CANCELLED", "EXPIRED"],
  GAME_OPEN: ["LOTTERY_RUNNING", "CANCELLED", "EXPIRED"],
  LOTTERY_RUNNING: ["FINALIZED", "CANCELLED"],
  FINALIZED: [],
  CANCELLED: [],
  EXPIRED: []
};

export function assertTransition(current: DraftOrderState, next: DraftOrderState): void {
  const allowed = transitions[current] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`Invalid state transition from ${current} to ${next}`);
  }
}

export function canTransition(current: DraftOrderState, next: DraftOrderState): boolean {
  return transitions[current]?.includes(next) ?? false;
}

export function isTerminalState(state: DraftOrderState): boolean {
  return state === "FINALIZED" || state === "CANCELLED" || state === "EXPIRED";
}
