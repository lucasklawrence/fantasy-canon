/**
 * Deterministic, replayable randomness for the lottery draw.
 *
 * Each draw hashes `` `${seed}:${drawIndex}` `` with sha256, reads the first four digest bytes as
 * a big-endian uint32, and reduces it `% bagSize`. Anyone holding the revealed seed can replay
 * every draw with a few lines of code — that auditability is the point of the scheme.
 *
 * The modulo reduction carries a bias toward low indices of at most `2^32 % bagSize / 2^32` —
 * on the order of 2^-27 for league-scale bag sizes (tens of balls). That is negligible for a
 * once-a-year 12-team lottery and not worth trading away simple, auditable replay math (e.g. for
 * rejection sampling), so we keep the draw semantics exactly as shipped on the `draftOrder`
 * branch.
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
