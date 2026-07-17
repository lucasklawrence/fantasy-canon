/**
 * Single-committer commit-reveal for a provably fair draw.
 *
 * Before the ceremony the bot picks a secret seed and posts only its commitment,
 * `sha256(seed)`. After the draw it reveals the seed. Any league member can then check that
 * (a) the revealed seed hashes to the posted commitment — so the seed wasn't swapped after the
 * fact — and (b) replaying the lottery from that seed reproduces the announced order. A single
 * bot-side committer sidesteps the last-revealer bias of multi-party schemes entirely.
 */
import { createHash } from 'node:crypto';
import { computeDraftOrder } from './engine.js';
import type { LotteryDraw, LotteryInput } from './types.js';

/** The public lottery configuration — everything except the secret seed. */
export type LotteryConfig = Omit<LotteryInput, 'seed'>;

/** What {@link verifyDraw} hands back for auditing a completed ceremony. */
export interface DrawVerification {
  /** Commitment recomputed from the revealed seed — must equal the bot's pre-draw post. */
  commitment: string;
  /** The draft order replayed from the revealed seed — must equal the announced order. */
  draws: LotteryDraw[];
}

/** sha256 hex of the seed. Post this before the draw; reveal the seed after. */
export function computeCommitment(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

/**
 * Replay a completed draw from the revealed seed and the public config. Compare `commitment`
 * against the pre-draw post and `draws` against the announced order to audit the ceremony.
 */
export function verifyDraw(seed: string, config: LotteryConfig): DrawVerification {
  return {
    commitment: computeCommitment(seed),
    draws: computeDraftOrder({ ...config, seed }),
  };
}
