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
import type { CeremonyStore, PersistedCeremony } from './ceremonyStore.js';

/** One ceremony message. `kind` is semantic metadata for tests/logging; adapters post `content` + `image`. */
export interface CeremonyPost {
  kind:
    | 'preview'
    | 'commitment'
    | 'beat'
    | 'reveal'
    | 'board'
    | 'seed-reveal'
    | 'abort'
    | 'minigame'
    | 'hype';
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
  /** Origin channel id — persisted at commit so startup recovery can disclose the seed there (#176). */
  channelId?: string;
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
  /** The mini-game's current contribution per team — subtracted before re-applying so a re-run never stacks on itself or clobbers setup-granted bonuses (#166). */
  miniGameBonuses?: Record<string, number>;
  /** True while a reaction round is collecting clicks — `begin` must wait (the bag is in flux). */
  miniGameActive?: boolean;
  /** How many hype posts have gone out — rotates the copy templates (#165). */
  hypeCount?: number;
  abort: AbortController;
}

export interface RunCeremonyOptions {
  /** Pause between the drum-roll beat and the reveal for each pick. */
  delayMs: number;
  /** Injected for tests; defaults to a real abortable timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injected for tests; defaults to 32 hex chars from crypto randomness. */
  seedSource?: () => string;
  /**
   * Durable store (#176): the committed record is saved once the commitment posts and removed once
   * the seed is disclosed (finalize or abort), so a crash in between leaves a record for startup
   * recovery. Omitted ⇒ no persistence (the pre-#176 in-memory-only behavior).
   */
  store?: CeremonyStore;
  /**
   * The lottery-machine reveal stage (#169). When present, the paced ball-by-ball reveal streams
   * to the Activity via this seam instead of the channel — the channel still gets the commitment,
   * final board, and seed reveal, so members outside the Activity audit the same draw. The bot
   * remains the single pacer; the stage is presentation-only.
   */
  stage?: RevealStage;
}

/** One row of the stage's pre-reveal odds table (matches the api's `LotteryOddsRow`). */
export interface StageOddsRow {
  team: string;
  balls: number;
  firstPct: number;
  top3Pct: number;
}

/**
 * The Activity reveal stage the ceremony paces (#169) — implemented over HTTP by
 * `lotteryStageClient.ts`, or by an in-memory collector in tests. Mirrors the api's
 * `/api/lottery/*` payloads.
 */
export interface RevealStage {
  start(start: {
    title: string;
    commitment: string;
    teamCount: number;
    totalBalls: number;
    delayMs: number;
    rows: StageOddsRow[];
    /** Lets the stage refuse a second guild's ceremony while another is armed/live. */
    guildId?: string;
  }): Promise<void>;
  beat(beat: { pick: number; remaining: string[] }): Promise<void>;
  reveal(reveal: {
    pick: number;
    team: string;
    balls: number;
    oddsPct: number;
    remaining: string[];
  }): Promise<void>;
  finish(finish: {
    order: { pick: number; team: string }[];
    verify: { secretSeed: string; salt: string; drawSeed: string; commitment: string };
  }): Promise<void>;
  abort(abort: { reason: string }): Promise<void>;
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

/**
 * Apply a scored reaction round onto the session's bag (#166): each team's bonus becomes its
 * setup-granted bonus plus its mini-game award. The previous round's contribution is subtracted
 * first, so re-running the round replaces only the mini-game's share and never erodes what the
 * commissioner granted at setup. Only legal while the bag is still mutable (`GAME_OPEN` —
 * before the commitment binds it). Re-validates the new bag eagerly, like `createCeremony`.
 */
export function applyMiniGameBonuses(
  session: CeremonySession,
  bonusByTeam: Record<string, number>,
): void {
  if (session.state !== 'GAME_OPEN') {
    throw new Error(`Mini-game bonuses can only be applied in GAME_OPEN (state: ${session.state})`);
  }
  const previous = session.miniGameBonuses ?? {};
  for (const team of session.config.teams) {
    const setupBonus = (team.bonusBalls ?? 0) - (previous[team.teamId] ?? 0);
    team.bonusBalls = setupBonus + (bonusByTeam[team.teamId] ?? 0);
  }
  session.miniGameBonuses = { ...bonusByTeam };
  computePickOdds(session.config.teams, session.config.baseBallCount);
}

/**
 * Countdown/hype copy (#165). Each template gets the frozen-bag facts; rotation is by
 * per-session post count so repeated hype days read fresh without any randomness.
 */
const HYPE_TEMPLATES: ((f: {
  title: string;
  teamCount: number;
  totalBalls: number;
  favorite: string;
  favoritePct: string;
  longShot: string;
  longShotPct: string;
}) => string)[] = [
  (f) =>
    `🎉 **${f.title}** is coming. ${f.teamCount} teams, ${f.totalBalls} balls, one hopper. Odds below — argue accordingly.`,
  (f) =>
    `🔮 The hopper doesn't lie: **${f.favorite}** holds the best shot at #1 (${f.favoritePct}%), while **${f.longShot}** needs a miracle (${f.longShotPct}%). Misery pays.`,
  (f) =>
    `⏳ Lottery night approaches. ${f.totalBalls} balls are already sealed in the hopper for **${f.title}** — nobody can touch them now.`,
  (f) =>
    `🍿 Reminder: **${f.title}** settles it live, worst to first. ${f.teamCount} destinies, one draw, zero do-overs.`,
];

/**
 * A commissioner-triggered hype post for a frozen (GAME_OPEN) bag: rotating countdown copy +
 * the same odds card the preview froze. Never changes the bag — it re-renders the exact
 * session config the commitment will bind.
 */
export async function buildHypePost(
  session: CeremonySession,
  note?: string,
): Promise<CeremonyPost> {
  const rows = oddsRows(session);
  const favorite = rows[0];
  const longShot = rows[rows.length - 1];
  const index = session.hypeCount ?? 0;
  session.hypeCount = index + 1;

  const template = HYPE_TEMPLATES[index % HYPE_TEMPLATES.length]({
    title: session.title,
    teamCount: session.config.teams.length,
    totalBalls: totalBalls(session.config),
    favorite: favorite.team,
    favoritePct: favorite.firstPct.toFixed(1),
    longShot: longShot.team,
    longShotPct: longShot.firstPct.toFixed(1),
  });
  const image = await renderLotteryOddsCard({
    title: session.title,
    subtitle: `${session.config.teams.length} teams • ${totalBalls(session.config)} balls in the hopper`,
    rows,
  });
  return {
    kind: 'hype',
    content: [
      template,
      note,
      'The bag is frozen — these are exactly the odds the commitment will bind.',
    ]
      .filter(Boolean)
      .join('\n'),
    image: { name: 'lottery-hype.png', data: image },
  };
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

/** Per-pick reveal facts shared by the channel frames and the Activity stage (#169). */
interface RevealData {
  teamName: string;
  balls: number;
  oddsPct: number;
  /** Undrawn teams *including* the one about to be revealed (the drum-roll view). */
  remaining: string[];
  /** Undrawn teams after this reveal. */
  remainingAfter: string[];
}

function revealData(
  session: CeremonySession,
  draws: LotteryDraw[],
  odds: TeamPickOdds[],
  pick: number,
): RevealData {
  const draw = draws.find((d) => d.pick === pick) as LotteryDraw;
  const oddsByTeam = new Map(odds.map((o) => [o.teamId, o]));
  const unrevealedDraws = draws.filter((d) => d.pick <= pick).sort((a, b) => a.pick - b.pick);
  const remaining = unrevealedDraws.map((d) => displayName(session, d.teamId));
  const remainingAfter = unrevealedDraws
    .filter((d) => d.teamId !== draw.teamId)
    .map((d) => displayName(session, d.teamId));
  const team = session.config.teams.find((t) => t.teamId === draw.teamId);
  const balls = team ? ballCountForTeam(team, session.config.baseBallCount ?? 1) : 0;
  const oddsPct = pct(oddsByTeam.get(draw.teamId)?.probabilities[pick - 1] ?? 0);
  return { teamName: displayName(session, draw.teamId), balls, oddsPct, remaining, remainingAfter };
}

async function revealFrames(
  session: CeremonySession,
  data: RevealData,
  pick: number,
): Promise<{ beat: CeremonyPost; reveal: CeremonyPost }> {
  const beatImage = await renderLotteryRevealCard({
    phase: 'beat',
    title: session.title,
    subtitle: 'The Ceremony • live from the hopper',
    pick,
    remaining: data.remaining,
  });
  const revealImage = await renderLotteryRevealCard({
    phase: 'reveal',
    title: session.title,
    subtitle: 'The Ceremony • live from the hopper',
    pick,
    remaining: data.remainingAfter,
    team: data.teamName,
    balls: data.balls,
    oddsPct: data.oddsPct,
  });
  return {
    beat: {
      kind: 'beat',
      content: `🥁 Revealing pick **#${pick}**…`,
      image: { name: `lottery-beat-${pick}.png`, data: beatImage },
    },
    reveal: {
      kind: 'reveal',
      content: `🏀 Pick **#${pick}** goes to **${data.teamName}** (${data.balls} ball(s), ${data.oddsPct.toFixed(1)}% chance at this slot).`,
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

/** Snapshot the committed fields of a session for the durable store (#176). Only called post-seed. */
function toPersisted(session: CeremonySession): PersistedCeremony {
  return {
    guildId: session.guildId,
    channelId: session.channelId ?? '',
    title: session.title,
    config: session.config,
    names: [...session.names.entries()],
    secretSeed: session.secretSeed ?? '',
    commitment: session.commitment ?? '',
    commitMessageId: session.commitMessageId,
    drawSeed: session.drawSeed,
    state: session.state,
    createdAt: session.createdAt,
  };
}

/** Best-effort removal of a persisted record by commitment — a failed delete must not crash. */
function unpersist(store: CeremonyStore | undefined, commitment: string | undefined): void {
  if (!store || !commitment) return;
  try {
    store.remove(commitment);
  } catch (error) {
    console.error('[draftorder] failed to clear persisted ceremony state:', error);
  }
}

/**
 * The disclosure a restarted bot posts for a ceremony that committed but never finalized (#176).
 * Pure so it unit-tests without a client. It reveals the seed (keeping the commit-reveal promise)
 * and tells the channel the run was interrupted and a re-run starts fresh.
 */
export function interruptedDisclosureContent(record: PersistedCeremony): string {
  return [
    `🔓 **${record.title} — interrupted run, seed revealed.**`,
    'The bot restarted after posting the commitment below but before the reveal, so this draw was never completed.',
    `Committed hash: \`${record.commitment}\``,
    `Secret seed: \`${record.secretSeed}\``,
    record.commitMessageId
      ? `Public salt (commitment message id): \`${record.commitMessageId}\`${record.drawSeed ? ` — draw seed \`${record.drawSeed}\`` : ''}.`
      : '',
    'Anyone can verify the commitment against this seed. A fresh ceremony starts from a new commitment; this seed is never reused.',
  ]
    .filter(Boolean)
    .join('\n');
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
  // Persist the seed BEFORE the commitment goes public (#176) and FAIL CLOSED: a crash after the
  // post lands but before we could record the seed would otherwise leave a public, unopenable
  // commitment. Nothing is public yet, so on a write failure roll back and refuse to start rather
  // than post a commitment we can't back up.
  if (options.store) {
    try {
      options.store.saveCommitted(toPersisted(session));
    } catch (persistError) {
      session.state = 'GAME_OPEN';
      const message = persistError instanceof Error ? persistError.message : String(persistError);
      throw new Error(`refusing to start the draw: could not persist ceremony state (${message})`, {
        cause: persistError,
      });
    }
  }
  // The stage that actually STARTED for this run — reset on a failed start so neither the reveal
  // loop nor the abort path below ever notifies a stage that isn't showing this ceremony.
  let liveStage: RevealStage | undefined;
  try {
    throwIfAborted(session);
    const committed = await io.post({ kind: 'commitment', content: commitmentContent(session) });
    session.commitMessageId = committed.id;
    session.drawSeed = composeDrawSeed(session.secretSeed, committed.id);
    session.draws = computeDraftOrder({ ...session.config, seed: session.drawSeed });
    // Update the record with the salt (commit-message id) + draw seed. Already public, so this is
    // best-effort — a failed update still leaves the pre-post record for startup recovery.
    try {
      options.store?.saveCommitted(toPersisted(session));
    } catch (persistError) {
      console.error('[draftorder] failed to update persisted ceremony state:', persistError);
    }
    const odds = computePickOdds(session.config.teams, session.config.baseBallCount);

    // Open the Activity stage (#169). If it can't even start, fall back to the in-channel reveal
    // so the ceremony never stalls on a presentation surface; later transient stage failures are
    // logged and skipped (the channel board + seed reveal remain the authoritative record).
    liveStage = options.stage;
    if (liveStage) {
      try {
        await liveStage.start({
          title: session.title,
          commitment: session.commitment,
          teamCount: session.config.teams.length,
          totalBalls: totalBalls(session.config),
          delayMs: options.delayMs,
          rows: oddsRows(session),
          guildId: session.guildId,
        });
      } catch (stageError) {
        console.error(
          '[draftorder] stage unavailable, falling back to channel reveal:',
          stageError,
        );
        liveStage = undefined;
      }
    }
    const safeStage = async (send: () => Promise<void>): Promise<void> => {
      try {
        await send();
      } catch (stageError) {
        console.error('[draftorder] stage push failed (continuing):', stageError);
      }
    };

    // REVEAL — worst to first: to the Activity stage when open, else as channel card posts.
    for (let pick = session.config.teams.length; pick >= 1; pick -= 1) {
      throwIfAborted(session);
      const data = revealData(session, session.draws, odds, pick);
      const stage = liveStage;
      if (stage) {
        await safeStage(() => stage.beat({ pick, remaining: data.remaining }));
        await sleep(options.delayMs, session.abort.signal);
        throwIfAborted(session);
        await safeStage(() =>
          stage.reveal({
            pick,
            team: data.teamName,
            balls: data.balls,
            oddsPct: data.oddsPct,
            remaining: data.remainingAfter,
          }),
        );
      } else {
        const frames = await revealFrames(session, data, pick);
        await io.post(frames.beat);
        await sleep(options.delayMs, session.abort.signal);
        throwIfAborted(session);
        await io.post(frames.reveal);
      }
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
    // The seed is now public — nothing left to recover.
    unpersist(options.store, session.commitment);
    // Close out the Activity stage AFTER the in-channel seed reveal, so the Activity never shows
    // the seed before the channel record does.
    const stageAtFinish = liveStage;
    if (stageAtFinish) {
      await safeStage(() =>
        stageAtFinish.finish({
          order: (session.draws ?? [])
            .slice()
            .sort((a, b) => a.pick - b.pick)
            .map((draw) => ({ pick: draw.pick, team: displayName(session, draw.teamId) })),
          verify: {
            secretSeed: session.secretSeed ?? '',
            salt: session.commitMessageId ?? '',
            drawSeed: session.drawSeed ?? '',
            commitment: session.commitment ?? '',
          },
        }),
      );
    }
    return session.draws;
  } catch (error) {
    if (session.state === 'LOTTERY_RUNNING') {
      session.state = 'CANCELLED';
      try {
        await postAbortDisclosure(session, io);
        // The abort disclosure revealed the seed, so the persisted record is no longer owed.
        unpersist(options.store, session.commitment);
      } catch (disclosureError) {
        // Never mask the original failure with a disclosure failure — log and fall through.
        // Leave the persisted record in place: startup recovery becomes the disclosure backstop.
        console.error('[draftorder] failed to post the abort disclosure:', disclosureError);
      }
      // Tell any Activity viewers the run ended; the full disclosure lives in-channel. Only a
      // stage that actually STARTED for this run is notified — after a start-failure fallback
      // (`liveStage` reset) the stage isn't showing this ceremony and must not get an abort.
      const stageAtAbort = liveStage;
      if (stageAtAbort) {
        try {
          await stageAtAbort.abort({
            reason: `${session.title} was aborted — the committed seed is disclosed in the channel.`,
          });
        } catch (stageError) {
          console.error('[draftorder] failed to notify the stage of the abort:', stageError);
        }
      }
    }
    throw error;
  }
}

/** Commissioner abort: flips the signal; the running ceremony posts the disclosure and stops. */
export function requestAbort(session: CeremonySession): void {
  session.abort.abort();
}
