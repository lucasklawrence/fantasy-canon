/**
 * Draft-order lottery ceremony orchestration (#164, ADR 0006).
 *
 * Pure-ish flow logic: no discord.js imports. The command layer injects an {@link CeremonyIo}
 * that posts to the channel and a sleep, so the whole ceremony — commit → paced ball-by-ball
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
  DraftOrderTeamInput,
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
  /**
   * Where `setup` ran. Separate from {@link CeremonySession.channelId}, which is deliberately
   * captured at `begin` so the seed disclosure lands beside the commitment (#176) — but the
   * in-Activity edit audit line (#220) fires *before* `begin` exists, so it needs the channel the
   * odds preview was posted to.
   */
  lobbyChannelId?: string;
  /**
   * The ESPN league + season `setup` opened this ceremony against (#219). Stored so an in-Activity
   * re-import refetches *exactly* that league rather than re-resolving and possibly retargeting.
   * Absent for a manual `teams:` setup, which has no ESPN league to refetch.
   */
  leagueId?: string;
  season?: number;
  /** Discord user ids allowed to edit from inside the Activity (#210) — the `setup` runner. */
  commissionerIds?: string[];
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
  /**
   * True while an in-Activity re-import is replacing the roster and publishing its fresh preview
   * (#219). Same interlock as {@link CeremonySession.miniGameActive}: `begin` must not seal a bag
   * whose required public preview has not landed yet.
   */
  reimportActive?: boolean;
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
  /**
   * Reveal order for the paced ball-by-ball sequence (#196).
   *   - `'worst-to-first'` (default) — reveal pick N down to pick 1; suspense builds to the #1 pick.
   *   - `'first-to-last'` — reveal pick 1 first, then 2…N; drama shifts to who falls last.
   *
   * The underlying draw (and the commitment it binds) is the same either way; this only controls
   * which pick is announced first. The Activity stage and channel cards are both order-agnostic.
   */
  direction?: 'worst-to-first' | 'first-to-last';
}

/** One row of the stage's pre-reveal odds table (matches the api's `LotteryOddsRow`). */
export interface StageOddsRow {
  /** Stable ceremony team id — what an in-Activity ball edit targets (#210). */
  teamId?: string;
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
  /**
   * Arm the pre-commitment lobby (#198) — visible from `setup` onward so members can join
   * the Activity before `begin` is called. Must be called best-effort (never awaited on the
   * hot path). Rejects once a commitment exists (the stage refuses to blank a committed run).
   */
  lobby(lobby: {
    title: string;
    teamCount: number;
    totalBalls: number;
    rows: StageOddsRow[];
    guildId?: string;
    /**
     * Discord user ids allowed to adjust this lobby from inside the Activity (#210) — the member
     * who ran `setup`. Omitted ⇒ the lobby is read-only, which is the safe default.
     */
    commissionerIds?: string[];
    /**
     * Keep (and re-apply) pending in-Activity edits instead of dropping them. Set only when
     * re-arming a lobby derived *without* draining them first — otherwise the commissioner's
     * edits would silently revert on the next re-arm.
     */
    keepAdjustments?: boolean;
  }): Promise<void>;
  /**
   * Disarm the lobby (#198), returning the stage to idle. Must be called on every path that
   * abandons an armed lobby without a reveal behind it — otherwise it lingers on members'
   * screens and shadows the draft dashboard at the Activity root. A no-op server-side unless a
   * matching lobby is armed, so it is always safe to fire.
   */
  clear(clear: { guildId?: string }): Promise<void>;
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
  /**
   * Abort the stage presentation. `ifCommitment` makes it conditional server-side (#205): the
   * stage only aborts if it is still showing that committed run — the boot reconciler's guard
   * against racing a fresh `begin`. The ceremony's own aborts stay unconditional.
   */
  abort(abort: { reason: string; ifCommitment?: string }): Promise<void>;
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
 * Whether any guild's ceremony exists in this process — any state, not just mid-reveal. The boot
 * reconciler (#205) uses this as its safety interlock: a `setup` that lands during recovery has
 * already armed a fresh lobby (`GAME_OPEN`), and a `begin` is pacing the stage
 * (`LOTTERY_RUNNING`), so the stage may reflect *current* state rather than an orphan the moment
 * any session exists. Tear-down is only safe when this process knows of no ceremony at all.
 */
export function hasAnyCeremony(): boolean {
  return sessions.size > 0;
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

/**
 * Odds rows for the preview card, longest odds last (best ball count first). `teamId` rides along
 * for the Activity stage: an in-Activity edit (#210) has to name a team by something stabler than
 * its display name. The renderer ignores the extra field.
 */
export function oddsRows(session: CeremonySession): StageOddsRow[] {
  const odds = computePickOdds(session.config.teams, session.config.baseBallCount);
  const byTeam = new Map(odds.map((o) => [o.teamId, o]));
  return session.config.teams
    .map((team) => {
      const teamOdds = byTeam.get(team.teamId) as TeamPickOdds;
      const top3 = teamOdds.probabilities.slice(0, 3).reduce((sum, p) => sum + p, 0);
      return {
        teamId: team.teamId,
        team: displayName(session, team.teamId),
        balls: ballCountForTeam(team, session.config.baseBallCount ?? 1),
        firstPct: pct(teamOdds.probabilities[0]),
        top3Pct: pct(top3),
      };
    })
    .sort((a, b) => b.balls - a.balls || a.team.localeCompare(b.team));
}

/** One adjustment folded into the bag by {@link applyLobbyAdjustments}, for the audit post. */
export interface AppliedAdjustment {
  teamId: string;
  team: string;
  from: number;
  to: number;
}

/** One display-name fix folded in by {@link applyLobbyRenames}, for the audit post. */
export interface AppliedRename {
  teamId: string;
  from: string;
  to: string;
}

/**
 * Fold the commissioner's in-Activity display-name fixes (#219) into the session, returning the
 * ones that actually changed something.
 *
 * Cosmetic by construction: `commitmentPreimage` hashes `teamId` and resolved ball counts only, so
 * a rename can never alter what the commitment binds — which is why this can run at the same
 * `begin` drain point as the ball edits without touching the fairness argument. It updates both
 * `session.names` (what every card and post renders) and the config's `displayName`, so the two
 * can't drift.
 *
 * Refuses the whole batch if it would leave two teams sharing a name case-insensitively — the same
 * rule `createCeremony` enforces, checked here because the stage validates against *its* row set
 * and this session is the authority.
 */
export function applyLobbyRenames(
  session: CeremonySession,
  renames: { teamId: string; displayName: string }[],
): AppliedRename[] {
  if (renames.length === 0) return [];
  if (session.state !== 'GAME_OPEN') {
    throw new Error(`Lobby renames can only be applied in GAME_OPEN (state: ${session.state})`);
  }
  const applied: AppliedRename[] = [];
  const next = new Map(session.names);
  for (const rename of renames) {
    const from = next.get(rename.teamId);
    // A stale id from a ceremony this one replaced must never block a draw.
    if (from === undefined || from === rename.displayName) continue;
    next.set(rename.teamId, rename.displayName);
    applied.push({ teamId: rename.teamId, from, to: rename.displayName });
  }
  if (applied.length === 0) return [];

  const seen = new Set<string>();
  for (const name of next.values()) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate team name "${name}" — names must be unique for the ceremony.`);
    }
    seen.add(key);
  }

  // Committed only after the uniqueness check, so a rejected batch leaves the session untouched.
  for (const [teamId, name] of next) session.names.set(teamId, name);
  for (const team of session.config.teams) {
    const name = next.get(team.teamId);
    if (name !== undefined) team.displayName = name;
  }
  return applied;
}

/** Everything {@link applyLobbyAdjustments} can change, captured for {@link restoreBag}. */
export interface BagSnapshot {
  ballsByTeam: Map<string, { baseBalls?: number; bonusBalls?: number }>;
  miniGameBonuses?: Record<string, number>;
  /** Display names too — a rename (#219) is folded in on the same path and must roll back with it. */
  names: Map<string, string>;
  displayNameByTeam: Map<string, string | undefined>;
}

/**
 * Capture the mutable ball state of a bag so a caller can undo an {@link applyLobbyAdjustments}
 * that it could not follow through on (#210). Needed because the drain's audit post — rendering
 * a card, then sending it to Discord — can fail *after* the bag is edited, and `begin` would
 * otherwise commit ball counts that were never publicly previewed (ADR 0006).
 */
export function captureBag(session: CeremonySession): BagSnapshot {
  return {
    ballsByTeam: new Map(
      session.config.teams.map((team) => [
        team.teamId,
        { baseBalls: team.baseBalls, bonusBalls: team.bonusBalls },
      ]),
    ),
    ...(session.miniGameBonuses ? { miniGameBonuses: { ...session.miniGameBonuses } } : {}),
    names: new Map(session.names),
    displayNameByTeam: new Map(session.config.teams.map((team) => [team.teamId, team.displayName])),
  };
}

/** Restore a bag captured by {@link captureBag}, in place (team object identities are kept). */
export function restoreBag(session: CeremonySession, snapshot: BagSnapshot): void {
  for (const team of session.config.teams) {
    const previous = snapshot.ballsByTeam.get(team.teamId);
    if (!previous) continue;
    team.baseBalls = previous.baseBalls;
    team.bonusBalls = previous.bonusBalls;
  }
  session.miniGameBonuses = snapshot.miniGameBonuses ? { ...snapshot.miniGameBonuses } : undefined;
  session.names.clear();
  for (const [teamId, name] of snapshot.names) session.names.set(teamId, name);
  for (const team of session.config.teams) {
    team.displayName = snapshot.displayNameByTeam.get(team.teamId);
  }
}

/**
 * Fold the commissioner's in-Activity ball edits (#210) into the authoritative bag, returning the
 * ones that actually changed something (so the caller can name them in the fresh public preview
 * ADR 0006 requires after any bag change).
 *
 * Only legal while the bag is still mutable — `GAME_OPEN`, before the commitment binds it — which
 * is the whole reason in-Activity editing is fairness-safe. The adjusted count is a *total*: it
 * becomes the team's `baseBalls` with `bonusBalls` zeroed, because the number the commissioner
 * saw and tapped in the odds table was the total. Zeroing the mini-game's recorded contribution
 * for that team too keeps {@link applyMiniGameBonuses}'s "subtract the previous round first"
 * bookkeeping honest if a round is re-run afterwards.
 *
 * Unknown team ids are ignored rather than thrown: the stage is a separate process that may be
 * holding edits from a ceremony this one replaced, and a stale id must never block a draw.
 */
export function applyLobbyAdjustments(
  session: CeremonySession,
  adjustments: { teamId: string; balls: number }[],
): AppliedAdjustment[] {
  if (adjustments.length === 0) return [];
  if (session.state !== 'GAME_OPEN') {
    throw new Error(`Lobby adjustments can only be applied in GAME_OPEN (state: ${session.state})`);
  }
  const planned: { team: DraftOrderTeamInput; change: AppliedAdjustment }[] = [];
  for (const adjustment of adjustments) {
    const team = session.config.teams.find((t) => t.teamId === adjustment.teamId);
    if (!team) continue;
    const from = ballCountForTeam(team, session.config.baseBallCount ?? 1);
    if (from === adjustment.balls) continue;
    planned.push({
      team,
      change: {
        teamId: adjustment.teamId,
        team: displayName(session, adjustment.teamId),
        from,
        to: adjustment.balls,
      },
    });
  }
  if (planned.length === 0) return [];

  // Validate the *projected* bag before touching the session — same eager re-validation
  // `applyMiniGameBonuses` does, but on a copy. Mutating as we go would leave a half-applied bag
  // behind on a throw, and `begin`'s caller treats a failed drain as "commit what setup froze" —
  // so a partial mutation would put a bag nobody ever published under the commitment.
  const projected = session.config.teams.map((team) => {
    const change = planned.find((entry) => entry.team === team);
    return change ? { ...team, baseBalls: change.change.to, bonusBalls: 0 } : team;
  });
  computePickOdds(projected, session.config.baseBallCount);

  for (const { team, change } of planned) {
    team.baseBalls = change.to;
    team.bonusBalls = 0;
    if (session.miniGameBonuses) delete session.miniGameBonuses[change.teamId];
  }
  return planned.map((entry) => entry.change);
}

/**
 * The fresh public odds preview that has to precede a commitment whose bag changed after the last
 * preview (ADR 0006). Named per adjustment so the channel — still the audit trail — records what
 * the commissioner changed in the Activity and what the commitment is about to bind.
 */
export async function buildAdjustedPreviewPost(
  session: CeremonySession,
  applied: AppliedAdjustment[],
  renamed: AppliedRename[] = [],
): Promise<CeremonyPost> {
  const image = await renderLotteryOddsCard({
    title: session.title,
    subtitle: `${session.config.teams.length} teams • ${totalBalls(session.config)} balls in the hopper`,
    rows: oddsRows(session),
  });
  const changes = [
    ...applied.map((change) => `• **${change.team}**: ${change.from} → ${change.to} ball(s)`),
    // Renames read differently from ball moves, and `change.to` is already the new name the odds
    // card above renders — so name both sides rather than showing an arrow between counts.
    ...renamed.map((change) => `• **${change.from}** is now **${change.to}**`),
  ].join('\n');
  return {
    kind: 'preview',
    content: [
      `🛠 **${session.title}** — the commissioner adjusted the hopper from the Lottery Machine:`,
      changes,
      'These are the final odds. The commitment posts next and binds exactly this bag.',
    ].join('\n'),
    image: { name: 'lottery-odds-adjusted.png', data: image },
  };
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
    `🍿 Reminder: **${f.title}** settles it live, one ball at a time. ${f.teamCount} destinies, one draw, zero do-overs.`,
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
    '3. The replayed draw order must match the picks revealed above.',
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
  direction: 'worst-to-first' | 'first-to-last',
): RevealData {
  const draw = draws.find((d) => d.pick === pick) as LotteryDraw;
  const oddsByTeam = new Map(odds.map((o) => [o.teamId, o]));
  // Unrevealed draws: worst-to-first counts down (picks ≤ current still pending);
  // first-to-last counts up (picks ≥ current still pending). Sort ascending for stable display.
  const unrevealedDraws = draws
    .filter((d) => (direction === 'worst-to-first' ? d.pick <= pick : d.pick >= pick))
    .sort((a, b) => a.pick - b.pick);
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
 * Run the ceremony end to end: commitment → paced ball-by-ball reveal → final board →
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

    // REVEAL — ordered by direction option (default: worst-to-first).
    const direction = options.direction ?? 'worst-to-first';
    const teamCount = session.config.teams.length;
    const pickSequence =
      direction === 'worst-to-first'
        ? Array.from({ length: teamCount }, (_, i) => teamCount - i)
        : Array.from({ length: teamCount }, (_, i) => i + 1);
    for (const pick of pickSequence) {
      throwIfAborted(session);
      const data = revealData(session, session.draws, odds, pick, direction);
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
    } else if (options.stage) {
      // Activity mode whose `start` failed: the reveal ran in-channel and the order is now public,
      // but the lobby `setup` armed (#198) may still be up — advertising pre-draw odds for a draw
      // that already happened, and shadowing the draft dashboard at the Activity root. Disarm it.
      // Guild-scoped and lobby-only, so it cannot disturb whatever made `start` fail.
      await safeStage(() => (options.stage as RevealStage).clear({ guildId: session.guildId }));
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
      } else if (options.stage) {
        // The stage never started for this run (start failed, or we died before reaching it), so it
        // must not get an abort — but it may still be holding the lobby `setup` armed (#198). Left
        // alone that lobby would advertise a ceremony that just died, so disarm it instead.
        try {
          await options.stage.clear({ guildId: session.guildId });
        } catch (stageError) {
          console.error('[draftorder] failed to disarm the Activity lobby on abort:', stageError);
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
