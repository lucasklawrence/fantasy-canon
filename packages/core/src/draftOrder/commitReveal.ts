/**
 * Single-committer commit-reveal for a provably fair draw (ADR 0006).
 *
 * Before the ceremony the bot freezes the public lottery config, generates a secret seed, and
 * posts the config in plaintext plus one sha256 commitment over the canonical serialization of
 * the seed and that config together. After the final pick it reveals the seed; anyone recomputes
 * (a) the commitment from the revealed seed + the posted config — proving neither was swapped
 * after the fact — and (b) the full order via {@link verifyDraw} — proving the announced order
 * is exactly what the committed seed produces. Binding the config into the hash matters: a bare
 * `sha256(seed)` would let an operator alter the un-hashed bag between commitment and draw and
 * still pass verification, so the commitment locks everything the draw consumes.
 *
 * A single bot-side committer sidesteps the last-revealer bias of multi-party schemes entirely.
 * The residual trust — the operator could grind seeds before committing — is accepted for the
 * MVP; ADR 0006 records the trust model and a cheap hardening if the league ever wants one.
 */
import { createHash } from 'node:crypto';
import { ballCountForTeam, computeDraftOrder } from './engine.js';
import type { LotteryDraw, LotteryInput } from './types.js';

/** The public lottery configuration — everything except the secret seed. */
export type LotteryConfig = Omit<LotteryInput, 'seed'>;

/**
 * Version tag baked into every commitment so a future draw-algorithm change can never be passed
 * off as this one.
 */
export const DRAW_ALGORITHM = 'fantasy-canon-draft-order-v1';

/**
 * The exact string the commitment hashes: a JSON document with fixed key order carrying the
 * algorithm version, the seed, and each team's *resolved* ball count (base + bonus, in draw
 * order — precisely what {@link buildBallBag} consumes). The bot posts this string, seed
 * redacted, alongside the commitment; auditors rebuild it after the reveal and hash it.
 */
export function commitmentPreimage(seed: string, config: LotteryConfig): string {
  const baseBallCount = config.baseBallCount ?? 1;
  return JSON.stringify({
    algorithm: DRAW_ALGORITHM,
    seed,
    baseBallCount,
    teams: config.teams.map((team) => ({
      teamId: team.teamId,
      balls: ballCountForTeam(team, baseBallCount),
    })),
  });
}

/**
 * sha256 hex over {@link commitmentPreimage}. Post this before the draw; reveal the seed after.
 */
export function computeCommitment(seed: string, config: LotteryConfig): string {
  return createHash('sha256').update(commitmentPreimage(seed, config), 'utf8').digest('hex');
}

/** What {@link verifyDraw} hands back for auditing a completed ceremony. */
export interface DrawVerification {
  /** Commitment recomputed from the revealed seed + config — must equal the pre-draw post. */
  commitment: string;
  /** The draft order replayed from the revealed seed — must equal the announced order. */
  draws: LotteryDraw[];
}

/**
 * Replay a completed draw from the revealed seed and the public config. Compare `commitment`
 * against the pre-draw post and `draws` against the announced order to audit the ceremony.
 */
export function verifyDraw(seed: string, config: LotteryConfig): DrawVerification {
  return {
    commitment: computeCommitment(seed, config),
    draws: computeDraftOrder({ ...config, seed }),
  };
}
