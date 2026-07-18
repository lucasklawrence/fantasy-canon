/**
 * Draft-order lottery ceremony orchestration (#164, ADR 0006).
 *
 * Pure-ish flow logic: no discord.js imports. The command layer injects an {@link CeremonyIo}
 * that posts to the channel and a sleep, so the whole ceremony — commit → paced worst-to-first
 * reveal → board → seed reveal — is unit-testable with an instant clock and a post collector.
 *
 * Fairness protocol (ADR 0006 + the #174 hardening):
 *  1. The commitment post carries the frozen config in plaintext plus
 *     `computeCommitment(secretSeed, config)`. It goes out before any draw, in every code path.
 *  2. The draw seed is `composeDrawSeed(secretSeed, commitMessageId)` — the salt is the
 *     commitment post's own Discord message id, which does not exist until the commitment is
 *     irrevocably posted, so the operator cannot grind seeds against it.
 *  3. After the last reveal the secret seed is posted with verify-it-yourself instructions.
 *  4. Aborts after the commitment must reveal the aborted secret publicly (ADR 0006 abort
 *     policy) — a discarded draw is visible, never hidden. A committed seed is never reused.
 *
 * Ceremony posts are append-only: this module only ever emits new posts, never edits.
 */
import { randomBytes } from 'node:crypto';
import {
  assertTransition,
  ballCountForTeam,
  composeDrawSeed,
  computeCommitment,
  computeDraftOrder,
  computePickOdds,
  DraftOrderState,
  DRAW_ALGORITHM,
  LotteryConfig,
  LotteryDraw,
  TeamPickOdds,
} from '@fantasy-canon/core';
import {
  renderLotteryBoardCard,
  renderLotteryOddsCard,
  renderLotteryRevealCard,
} from '@fantasy-canon/renderer';

/** One ceremony message. `kind` is semantic metadata for tests/logging; adapters post `content` + `image`. */
export interface CeremonyPost {
  kind: 'preview' | 'commitment' | 'beat' | 'reveal' | 'board' | 'seed-reveal' | 'abort';
  content?: string;
  image?: { name: string; data: Buffer };
}

export interface PostedMessage {
  id: string;
}

/** Channel adapter injected by the command layer (or a collector in tests). */
export interface CeremonyIo {
  post(post: CeremonyPost): Promise<PostedMessage>;
}

export interface CeremonySession {
  guildId: string;
  title: string;
  createdAt: number;
  state: DraftOrderState;
  config: LotteryConfig;
  /** teamId → display name for every team in the config. */
  names: Map<string, string>;
  secretSeed?: string;
  commitment?: string;
  commitMessageId?: string;
  drawSeed?: string;
  draws?: LotteryDraw[];
  abort: AbortController;
}

export interface RunCeremonyOptions {
  /** Pause between the drum-roll beat and the reveal for each pick. */
  delayMs: number;
  /** Injected for tests; defaults to a real abortable timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injected for tests; defaults to 32 hex chars from crypto randomness. */
  seedSource?: () => string;
}

/** Thrown out of {@link runCeremony} when the commissioner aborts mid-ceremony. */
export class CeremonyAborted extends Error {
  constructor() {
    super('Ceremony aborted');
    this.name = 'CeremonyAborted';
  }
}

const sessions = new Map<string, CeremonySession>();

export function getCeremony(guildId: string): CeremonySession | undefined {
  return sessions.get(guildId);
}

export function setCeremony(session: CeremonySession): void {
  sessions.set(session.guildId, session);
}

export function clearCeremony(guildId: string): void {
  sessions.delete(guildId);
}

/** Test hook — wipe all in-memory ceremonies. */
export function resetCeremoniesForTests(): void {
  sessions.clear();
}

/**
 * Create a session in `CREATED`. Validates the config eagerly (duplicate teams, empty bag,
 * odds-DP team cap) so setup fails fast instead of mid-ceremony.
 */
export function createCeremony(
  guildId: string,
  title: string,
  config: LotteryConfig,
  names: Map<string, string>,
): CeremonySession {
  computePickOdds(config.teams, config.baseBallCount);
  const seenNames = new Set<string>();
  for (const name of names.values()) {
    const key = name.toLowerCase();
    if (seenNames.has(key)) {
      throw new Error(`Duplicate team name "${name}" — names must be unique for the ceremony.`);
    }
    seenNames.add(key);
  }
  return {
    guildId,
    title,
    createdAt: Date.now(),
    state: 'CREATED',
    config,
    names,
    abort: new AbortController(),
  };
}

function displayName(session: CeremonySession, teamId: string): string {
  return session.names.get(teamId) ?? teamId;
}

function totalBalls(config: LotteryConfig): number {
  return config.teams.reduce(
    (sum, team) => sum + ballCountForTeam(team, config.baseBallCount ?? 1),
    0,
  );
}

function pct(probability: number): number {
  return probability * 100;
}

/** Odds rows for the preview card, longest odds last (best ball count first). */
export function oddsRows(
  session: CeremonySession,
): { team: string; balls: number; firstPct: number; top3Pct: number }[] {
  const odds = computePickOdds(session.config.teams, session.config.baseBallCount);
  const byTeam = new Map(odds.map((o) => [o.teamId, o]));
  return session.config.teams
    .map((team) => {
      const teamOdds = byTeam.get(team.teamId) as TeamPickOdds;
      const top3 = teamOdds.probabilities.slice(0, 3).reduce((sum, p) => sum + p, 0);
      return {
        team: displayName(session, team.teamId),
        balls: ballCountForTeam(team, session.config.baseBallCount ?? 1),
        firstPct: pct(teamOdds.probabilities[0]),
        top3Pct: pct(top3),
      };
    })
    .sort((a, b) => b.balls - a.balls || a.team.localeCompare(b.team));
}

/** The public odds-preview post for the setup phase. */
export async function buildPreviewPost(session: CeremonySession): Promise<CeremonyPost> {
  const image = await renderLotteryOddsCard({
    title: session.title,
    subtitle: `${session.config.teams.length} teams • ${totalBalls(session.config)} balls in the hopper`,
    rows: oddsRows(session),
  });
  return {
    kind: 'preview',
    content: [
      `🏈 **${session.title}** — the hopper is set.`,
      'These odds are frozen by this preview — the commitment will bind exactly this bag. Any change requires a fresh preview before the draw can start.',
      'Commissioner: run `/canon draftorder begin` to seal the bag and start the reveal.',
    ].join('\n'),
    image: { name: 'lottery-odds.png', data: image },
  };
}

/** Mark the odds preview as publicly posted: CREATED → GAME_OPEN (the #166 mini-game window). */
export function markPreviewPosted(session: CeremonySession): void {
  assertTransition(session.state, 'GAME_OPEN');
  session.state = 'GAME_OPEN';
}

function commitmentContent(session: CeremonySession): string {
  const config = session.config;
  // Each line binds display name ↔ teamId — the hash preimage uses teamIds, so auditors need
  // this mapping in the public record to tie the replayed order back to the announced names.
  const ballLines = config.teams.map(
    (team) =>
      `• ${displayName(session, team.teamId)} (\`${team.teamId}\`) — ${ballCountForTeam(team, config.baseBallCount ?? 1)} ball(s)`,
  );
  return [
    `🔒 **${session.title} — commitment**`,
    `Algorithm: \`${DRAW_ALGORITHM}\` • Base balls: ${config.baseBallCount ?? 1}`,
    ...ballLines,
    `Commitment: \`${session.commitment}\``,
    'The draw seed is `<secret>|<this message id>` — the id is stamped by Discord only after this post exists, so the seed could not be chosen to rig the draw. The secret is revealed after the last pick; then anyone can replay the whole draw.',
    'If the commissioner aborts this ceremony, the secret behind this commitment is revealed anyway — a discarded draw is always visible.',
  ].join('\n');
}

function verificationContent(session: CeremonySession): string {
  const config = session.config;
  const ballList = config.teams
    .map((team) => `${team.teamId}:${ballCountForTeam(team, config.baseBallCount ?? 1)}`)
    .join(', ');
  return [
    `🔓 **${session.title} — seed reveal**`,
    `Secret seed: \`${session.secretSeed}\``,
    `Public salt (commitment message id): \`${session.commitMessageId}\``,
    `Draw seed = \`secret|salt\` = \`${session.drawSeed}\``,
    '**Verify it yourself:**',
    `1. Rebuild the commitment: sha256 of \`{"algorithm":"${DRAW_ALGORITHM}","seed":"<secret>","baseBallCount":${config.baseBallCount ?? 1},"teams":[{teamId, balls}…]}\` with balls \`${ballList}\` — it must equal the hash on the commitment post.`,
    '2. Replay the draw: `verifyHardenedDraw(secret, salt, config)` from `@fantasy-canon/core` (each draw hashes `sha256(drawSeed:drawIndex)`, first 4 bytes → big-endian uint32 → mod bag size, drawn team leaves the bag).',
    '3. The replayed order must match the picks revealed above, worst to first.',
  ].join('\n');
}

async function revealFrames(
  session: CeremonySession,
  draws: LotteryDraw[],
  odds: TeamPickOdds[],
  pick: number,
): Promise<{ beat: CeremonyPost; reveal: CeremonyPost }> {
  const draw = draws.find((d) => d.pick === pick) as LotteryDraw;
  const oddsByTeam = new Map(odds.map((o) => [o.teamId, o]));
  const unrevealedDraws = draws.filter((d) => d.pick <= pick).sort((a, b) => a.pick - b.pick);
  const unrevealed = unrevealedDraws.map((d) => displayName(session, d.teamId));
  const remainingAfter = unrevealedDraws
    .filter((d) => d.teamId !== draw.teamId)
    .map((d) => displayName(session, d.teamId));
  const team = session.config.teams.find((t) => t.teamId === draw.teamId);
  const balls = team ? ballCountForTeam(team, session.config.baseBallCount ?? 1) : 0;
  const oddsPct = pct(oddsByTeam.get(draw.teamId)?.probabilities[pick - 1] ?? 0);

  const beatImage = await renderLotteryRevealCard({
    phase: 'beat',
    title: session.title,
    subtitle: 'The Ceremony • live from the hopper',
    pick,
    remaining: unrevealed,
  });
  const revealImage = await renderLotteryRevealCard({
    phase: 'reveal',
    title: session.title,
    subtitle: 'The Ceremony • live from the hopper',
    pick,
    remaining: remainingAfter,
    team: displayName(session, draw.teamId),
    balls,
    oddsPct,
  });
  return {
    beat: {
      kind: 'beat',
      content: `🥁 Revealing pick **#${pick}**…`,
      image: { name: `lottery-beat-${pick}.png`, data: beatImage },
    },
    reveal: {
      kind: 'reveal',
      content: `🏀 Pick **#${pick}** goes to **${displayName(session, draw.teamId)}** (${balls} ball(s), ${oddsPct.toFixed(1)}% chance at this slot).`,
      image: { name: `lottery-reveal-${pick}.png`, data: revealImage },
    },
  };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(session: CeremonySession): void {
  if (session.abort.signal.aborted) {
    throw new CeremonyAborted();
  }
}

async function postAbortDisclosure(session: CeremonySession, io: CeremonyIo): Promise<void> {
  // ADR 0006 abort policy: a committed seed is revealed even when the draw is discarded.
  const wouldHaveBeen = (session.draws ?? [])
    .map((d) => `#${d.pick} ${displayName(session, d.teamId)}`)
    .join(' · ');
  await io.post({
    kind: 'abort',
    content: [
      `⛔ **${session.title} — aborted.**`,
      `The committed secret is revealed anyway (nothing stays hidden): \`${session.secretSeed}\``,
      session.commitMessageId
        ? `Public salt (commitment message id): \`${session.commitMessageId}\` — draw seed \`${session.drawSeed}\`.`
        : 'The ceremony aborted before the commitment posted — no draw seed existed.',
      wouldHaveBeen ? `The discarded draw would have been: ${wouldHaveBeen}.` : '',
      'A re-run starts from a fresh commitment; this seed is never reused.',
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

/**
 * Run the ceremony end to end: commitment → paced worst-to-first reveal → final board →
 * seed reveal. Resolves with the draws on success; throws {@link CeremonyAborted} after
 * posting the abort disclosure if the commissioner aborts.
 */
export async function runCeremony(
  session: CeremonySession,
  io: CeremonyIo,
  options: RunCeremonyOptions,
): Promise<LotteryDraw[]> {
  const sleep = options.sleep ?? defaultSleep;
  const seedSource = options.seedSource ?? (() => randomBytes(16).toString('hex'));

  // An abort that raced `begin` (before anything was committed or posted) exits here — no
  // transition, no seed, no disclosure owed.
  throwIfAborted(session);
  assertTransition(session.state, 'LOTTERY_RUNNING');
  session.state = 'LOTTERY_RUNNING';

  // COMMIT — before any draw, in every code path. The draw seed cannot exist earlier: its salt
  // is the id Discord assigns to this very post.
  session.secretSeed = seedSource();
  session.commitment = computeCommitment(session.secretSeed, session.config);
  try {
    throwIfAborted(session);
    const committed = await io.post({ kind: 'commitment', content: commitmentContent(session) });
    session.commitMessageId = committed.id;
    session.drawSeed = composeDrawSeed(session.secretSeed, committed.id);
    session.draws = computeDraftOrder({ ...session.config, seed: session.drawSeed });
    const odds = computePickOdds(session.config.teams, session.config.baseBallCount);

    // REVEAL — worst to first.
    for (let pick = session.config.teams.length; pick >= 1; pick -= 1) {
      throwIfAborted(session);
      const frames = await revealFrames(session, session.draws, odds, pick);
      await io.post(frames.beat);
      await sleep(options.delayMs, session.abort.signal);
      throwIfAborted(session);
      await io.post(frames.reveal);
    }

    // Past this point aborts are deliberately ignored: every pick is already public, so the
    // only remaining duty is disclosure — and the board + seed-reveal posts disclose *more*
    // than the abort path would. Finishing is the correct response to a late abort.
    // BOARD
    const boardImage = await renderLotteryBoardCard({
      title: session.title,
      subtitle: `Sealed by commitment ${(session.commitment ?? '').slice(0, 12)}…`,
      entries: session.draws
        .slice()
        .sort((a, b) => a.pick - b.pick)
        .map((draw) => {
          const team = session.config.teams.find((t) => t.teamId === draw.teamId);
          const teamOdds = odds.find((o) => o.teamId === draw.teamId);
          return {
            pick: draw.pick,
            team: displayName(session, draw.teamId),
            balls: team ? ballCountForTeam(team, session.config.baseBallCount ?? 1) : undefined,
            oddsPct: teamOdds ? pct(teamOdds.probabilities[draw.pick - 1]) : undefined,
          };
        }),
    });
    await io.post({
      kind: 'board',
      content: `📌 **${session.title} — final draft order.** Pin this one.`,
      image: { name: 'lottery-board.png', data: boardImage },
    });

    // SEED REVEAL
    await io.post({ kind: 'seed-reveal', content: verificationContent(session) });
    assertTransition(session.state, 'FINALIZED');
    session.state = 'FINALIZED';
    return session.draws;
  } catch (error) {
    if (session.state === 'LOTTERY_RUNNING') {
      session.state = 'CANCELLED';
      try {
        await postAbortDisclosure(session, io);
      } catch (disclosureError) {
        // Never mask the original failure with a disclosure failure — log and fall through.
        console.error('[draftorder] failed to post the abort disclosure:', disclosureError);
      }
    }
    throw error;
  }
}

/** Commissioner abort: flips the signal; the running ceremony posts the disclosure and stops. */
export function requestAbort(session: CeremonySession): void {
  session.abort.abort();
}
