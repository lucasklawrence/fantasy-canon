/**
 * Deterministic, replayable randomness for the lottery draw.
 *
 * Each draw hashes `` `${seed}:${drawIndex}` `` with sha256, reads the first four digest bytes as
 * a big-endian uint32, and reduces it `% bagSize`. Anyone holding the revealed seed can replay
 * every draw with a few lines of code — that auditability is the point of the scheme.
 *
 * The modulo reduction carries a bias toward low indices below `bagSize / 2^32` — under 2^-26
 * for any realistic bag of ≤ 64 balls. ADR 0006 accepts that deliberately: rejection sampling
 * would be unbiased but makes independent re-implementation harder, and at this magnitude the
 * bias is unobservable over the league's lifetime. The draw semantics are kept exactly as
 * shipped on the `draftOrder` branch.
 */
import { createHash } from 'node:crypto';

/** The bag index drawn at `drawIndex` for `seed`, in `[0, bagSize)`. Pure and deterministic. */
export function deterministicIndex(seed: string, drawIndex: number, bagSize: number): number {
  if (bagSize <= 0) {
    throw new Error('bagSize must be greater than zero');
  }
  if (drawIndex < 0) {
    throw new Error('drawIndex cannot be negative');
  }

  const digest = createHash('sha256').update(`${seed}:${drawIndex}`).digest();
  return digest.readUInt32BE(0) % bagSize;
}
