/**
 * The lottery machine's **wire contract** (#169): every shape that crosses `/api/lottery/*` or the
 * WebSocket, and nothing else.
 *
 * Split out of `lotteryStage.ts` on purpose. The browser client typechecks under a DOM-only,
 * Node-types-free tsconfig (`src/client/tsconfig.json`), so anything it imports drags its whole
 * import graph into that program. The stage itself now computes odds with `@fantasy-canon/core`,
 * which reaches `node:crypto` — fine on the server, unresolvable in the browser program. Keeping
 * the types in a module with **no imports at all** lets both halves share one definition of the
 * protocol without the client ever seeing server code.
 */

/** One row of the pre-reveal odds table (mirrors the bot's odds-card rows). */
export interface LotteryOddsRow {
  /**
   * Stable ceremony team id. Optional because `start`/`reveal` never need it, but a lobby without
   * it cannot be adjusted from inside the Activity (#210) — display names are renameable, so
   * targeting an edit by name would be ambiguous the moment two rows collide.
   */
  teamId?: string;
  team: string;
  balls: number;
  firstPct: number;
  top3Pct: number;
}

/**
 * How the ceremony renders (#235): the classic ball machine, or the 12-lane race. Presentation
 * only — either way the client consumes the same paced beat→reveal stream and never receives the
 * final order early (ADR 0006), so the choice can never affect fairness.
 */
export type LotteryVisual = 'machine' | 'race';

/** Opens the stage: everything the waiting room needs before the first ball drops. */
export interface LotteryStart {
  title: string;
  /** The public sha256 commitment the bot posted in-channel — shown for auditability. */
  commitment: string;
  teamCount: number;
  totalBalls: number;
  /** Bot's reveal pacing, so the client can size its drum-roll animation. */
  delayMs: number;
  rows: LotteryOddsRow[];
  /**
   * The reveal visualization every viewer renders (#235). Rides `start` — not the begin request —
   * because it is part of the shared ceremony (one spectacle, one crowd), and a slash-started
   * draw picks it too. Absent (an older bot) ⇒ `'machine'`.
   */
  visual?: LotteryVisual;
  /**
   * Originating guild. The single process-wide stage serves one live ceremony at a time; a
   * different guild's `start` during a live reveal is rejected (that bot falls back to its
   * in-channel reveal) so two ceremonies can never interleave on shared screens.
   */
  guildId?: string;
}

/** Drum-roll: the next pick is about to be revealed. */
export interface LotteryBeat {
  pick: number;
  /** Teams still in the hopper (display names), including the one about to be drawn. */
  remaining: string[];
}

/** The ball drop: `pick` goes to `team`. */
export interface LotteryReveal {
  pick: number;
  team: string;
  balls: number;
  oddsPct: number;
  /** Teams still undrawn after this reveal. */
  remaining: string[];
}

/** The wrap-up: final order + the seed-reveal verify info (public by now, per ADR 0006). */
export interface LotteryFinish {
  order: { pick: number; team: string }[];
  verify: {
    secretSeed: string;
    /** The commitment post's message id — the #174 salt. */
    salt: string;
    drawSeed: string;
    commitment: string;
  };
}

export interface LotteryAbort {
  /** Human-readable line (the bot's disclosure summary); the full disclosure lives in-channel. */
  reason: string;
}

/**
 * The abort *request* (#205): `ifCommitment` makes the abort conditional — a no-op unless the
 * stage is still showing that committed run. The bot's boot reconciler sends it so a stale
 * snapshot can never abort a fresh ceremony that replaced the stranded one mid-flight. Stripped
 * before broadcast; clients only ever see {@link LotteryAbort}.
 */
export interface LotteryAbortRequest extends LotteryAbort {
  ifCommitment?: string;
}

/**
 * Pre-commitment lobby (#198): arms the waiting room from `setup` onward so members can
 * join the Activity before `begin` is called. No commitment yet — shown as a placeholder.
 */
export interface LotteryLobby {
  title: string;
  teamCount: number;
  totalBalls: number;
  rows: LotteryOddsRow[];
  /**
   * Originating guild, echoed into events and snapshots, and matched by {@link LotteryStage.clear}
   * so one league cannot disarm another's lobby. Unlike {@link LotteryStart.guildId} it does *not*
   * gate the busy check — {@link LotteryStage.lobby} refuses a committed run guild-agnostically.
   */
  guildId?: string;
  /**
   * Arm counter, assigned by the stage — bumps on every {@link LotteryStage.lobby} call and stays
   * fixed across edit echoes. Lets a client distinguish "a new/re-armed lobby" (whose commissioner
   * stamp may differ — re-check `/api/lottery/me`, #232) from "the lobby I'm looking at changed".
   * Never sent by the bot; absent only from stages predating this field.
   */
  armedSeq?: number;
}

/**
 * The lobby *request* (#210). `commissionerIds` and `keepAdjustments` steer the stage but are
 * never broadcast — clients only ever see {@link LotteryLobby}, so the commissioner's Discord user
 * id stays server-side (the client asks `GET /api/lottery/me` whether *it* is one).
 */
export interface LotteryLobbyRequest extends LotteryLobby {
  /**
   * Discord user ids allowed to {@link LotteryStage.adjust} this lobby — the member who ran
   * `/canon draftorder setup`, which is already Manage-Server gated (ADR 0007). Absent or empty ⇒
   * nobody can edit, which is the correct default for a bot that predates this field.
   */
  commissionerIds?: string[];
  /**
   * Keep pending adjustments and re-apply them onto these fresh rows instead of dropping them.
   * The bot sets it when it re-arms a lobby it derived *without* draining (the #166 mini-game
   * re-arm); a plain `setup` leaves it off, because a brand-new bag makes old edits meaningless.
   */
  keepAdjustments?: boolean;
}

/**
 * One commissioner ball edit made from inside the Activity (#210), pending until the bot folds it
 * into its authoritative bag at `begin`. Public in the snapshot on purpose: the odds table already
 * shows the result, and naming the edited teams is what makes the change auditable rather than
 * silent.
 */
export interface LotteryAdjustment {
  teamId: string;
  /** The team's new total ball count — exactly the number the odds table renders. */
  balls: number;
}

/** Disarms an armed lobby (#198) — see {@link LotteryStage.clear}. */
export interface LotteryClear {
  /** Only this guild's lobby is disarmed; omitted ⇒ matches a lobby armed without a guild. */
  guildId?: string;
}

export type LotteryPhase = 'idle' | 'lobby' | 'waiting' | 'revealing' | 'finished' | 'aborted';

/** What a (late-)joining client needs to fully reconstruct the presentation. */
export interface LotterySnapshot {
  phase: LotteryPhase;
  /** Set when phase is `'lobby'` — the pre-commitment waiting room state. */
  lobby?: LotteryLobby;
  start?: LotteryStart;
  /** The most recent drum-roll not yet resolved by a reveal (a client joining mid-beat shows it). */
  pendingBeat?: LotteryBeat;
  /** Every reveal so far, in reveal order (worst pick first). */
  reveals: LotteryReveal[];
  finish?: LotteryFinish;
  abort?: LotteryAbort;
  /**
   * In-Activity ball edits the bot has not folded into its bag yet (#210). Only ever populated in
   * the `lobby` phase — this is how the bot drains them at `begin`, and how a viewer can see which
   * rows the commissioner touched.
   */
  adjustments?: LotteryAdjustment[];
  /** In-Activity display-name fixes not yet folded into the bot's session (#219). */
  renames?: LotteryRename[];
  /**
   * The commissioner asked the Activity to refetch the league from ESPN (#219). The api has no
   * ESPN access, so this is a *request*: the bot's stage watcher performs the import, publishes a
   * fresh public preview, and re-arms the lobby — which clears this flag along with every pending
   * edit, since they were made against the field the refetch replaces.
   */
  reimportRequested?: boolean;
  /**
   * The commissioner pressed "seal the bag" inside the Activity (#233). Present until the bot
   * honours it (its `start` replaces the lobby) or the lobby is re-armed/torn down — the exact
   * lifetime every client's begin button spends disabled.
   */
  beginRequested?: LotteryBeginRequest;
}

/**
 * What changed in a single commissioner edit (#220), carried on the `lottery-lobby` broadcast that
 * the edit produces. The bot subscribes to the same feed the browsers do and posts an in-channel
 * audit line from this, so it never has to diff two lobbies to work out what a human just did —
 * and can't mistake a bot-driven re-arm for an edit.
 */
export interface LotteryAdjustmentDetail {
  teamId: string;
  /** Display name at the time of the edit, so the audit line reads without a lookup. */
  team: string;
  from: number;
  to: number;
  /** Whose lobby this was — the bot routes the audit post by it. */
  guildId?: string;
}

/**
 * A commissioner's in-Activity display-name fix (#219), pending until the bot folds it in at
 * `begin`. Kept in a set parallel to {@link LotteryAdjustment} rather than merged into it: the two
 * are independently pending, and a subscriber deduping ball edits must not be perturbed by a
 * rename (or vice versa).
 *
 * Renaming is **purely cosmetic w.r.t. fairness** — `commitmentPreimage` hashes only `teamId` and
 * resolved ball counts, so a display name can never change what a commitment binds.
 */
export interface LotteryRename {
  teamId: string;
  displayName: string;
}

/** What one rename changed, carried on the broadcast for the bot's audit line (#219/#220). */
export interface LotteryRenameDetail {
  teamId: string;
  from: string;
  to: string;
  guildId?: string;
}

/**
 * The commissioner asked the Activity to seal the bag and start the draw (#233). Like the
 * re-import flag it is a *request*: the api can never commit or draw anything (ADR 0006 — the bot
 * is the sole committer), so the bot's stage watcher honours it by running the exact same flow as
 * `/canon draftorder begin` — drain pending edits, post the fresh public odds card, post the
 * commitment in-channel, start the paced reveal.
 */
export interface LotteryBeginRequest {
  /** Seconds between reveals, from the Activity's picker — the slash command's `delay` option. */
  delaySeconds: number;
  /** Reveal order (#200): worst odds first (default) or pick #1 first. */
  direction: 'worst-to-first' | 'first-to-last';
  /** Reveal visualization (#235) — the bot echoes it onto {@link LotteryStart.visual}. */
  visual: LotteryVisual;
  /**
   * Discord user id of the commissioner who pressed the button, stamped server-side from the
   * verified bearer — never client-supplied — so the in-channel audit line can name them.
   */
  requestedBy?: string;
}

/** The events fanned out over the WS, tagged for the client. */
export type LotteryEvent =
  | { type: 'lottery-state'; snapshot: LotterySnapshot }
  | {
      type: 'lottery-lobby';
      lobby: LotteryLobby;
      /**
       * The complete pending-edit set *after* this broadcast, mirroring
       * {@link LotterySnapshot.adjustments}. Present so a subscriber can dedupe against stage
       * state rather than against the events it happened to witness — a re-arm that keeps
       * adjustments (`keepAdjustments`) and one that drops them are otherwise indistinguishable,
       * and the bot would re-announce a retained edit on its next reconnect. Omitted when empty.
       */
      adjustments?: LotteryAdjustment[];
      /** The complete pending rename set after this broadcast; same rationale as `adjustments`. */
      renames?: LotteryRename[];
      /** Mirrors {@link LotterySnapshot.reimportRequested}. */
      reimportRequested?: boolean;
      /** Mirrors {@link LotterySnapshot.beginRequested}. */
      beginRequested?: LotteryBeginRequest;
      /** Set only when this broadcast came from a commissioner edit rather than a bot re-arm. */
      adjusted?: LotteryAdjustmentDetail;
      /** Set only when this broadcast came from a commissioner rename. */
      renamed?: LotteryRenameDetail;
    }
  | { type: 'lottery-start'; start: LotteryStart }
  | { type: 'lottery-beat'; beat: LotteryBeat }
  | { type: 'lottery-reveal'; reveal: LotteryReveal }
  | { type: 'lottery-finish'; finish: LotteryFinish }
  | { type: 'lottery-abort'; abort: LotteryAbort };
