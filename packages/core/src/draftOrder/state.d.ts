import { DraftOrderState } from "./types.js";
export declare function assertTransition(current: DraftOrderState, next: DraftOrderState): void;
export declare function canTransition(current: DraftOrderState, next: DraftOrderState): boolean;
export declare function isTerminalState(state: DraftOrderState): boolean;
