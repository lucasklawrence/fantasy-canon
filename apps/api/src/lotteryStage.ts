/**
 * The lottery-machine reveal stage (#169, ADR 0006) — the backend half of the Activity.
 *
 * Presentation-only by design: the **bot owns the draw** (seed, salt, engine, pacing, aborts —
 * exactly as in the in-channel ceremony), and this stage is a dumb relay. The bot POSTs each
 * reveal beat as it paces the ceremony; the stage broadcasts it to every connected Activity
 * client over the WebSocket so all viewers see the same pick at the same instant (the Embedded
 * App SDK has no game-state sync of its own — our backend is the synchronizer). The secret seed
 * never reaches this process before the reveal; the verify payload arrives only at `finish`,
 * when the bot has already published it in-channel.
 *
 * Everything here is deterministic given its inputs — no timers, no sockets — so the whole stage
 * unit-tests without I/O (the WS fan-out lives in `server.ts`, same split as `DraftHub`). Late
 * joiners GET `/api/lottery/state` (or receive it on WS connect) and replay `snapshot()`, which
 * carries the full reveal history so a mid-ceremony join can paint the board-so-far.
 */

/** One row of the pre-reveal odds table (mirrors the bot's odds-card rows). */
export interface LotteryOddsRow {
  team: string;
  balls: number;
  firstPct: number;
  top3Pct: number;
}

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
 * Pre-commitment lobby (#198): arms the waiting room from `setup` onward so members can
 * join the Activity before `begin` is called. No commitment yet — shown as a placeholder.
 */
export interface LotteryLobby {
  title: string;
  teamCount: number;
  totalBalls: number;
  rows: LotteryOddsRow[];
  /** Originating guild — same busy-check semantics as {@link LotteryStart.guildId}. */
  guildId?: string;
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
}

/** The events fanned out over the WS, tagged for the client. */
export type LotteryEvent =
  | { type: 'lottery-state'; snapshot: LotterySnapshot }
  | { type: 'lottery-lobby'; lobby: LotteryLobby }
  | { type: 'lottery-start'; start: LotteryStart }
  | { type: 'lottery-beat'; beat: LotteryBeat }
  | { type: 'lottery-reveal'; reveal: LotteryReveal }
  | { type: 'lottery-finish'; finish: LotteryFinish }
  | { type: 'lottery-abort'; abort: LotteryAbort };

/** Thrown by {@link LotteryStage.start} when another guild's reveal is currently live. */
export class StageBusyError extends Error {
  constructor() {
    super('the stage is showing another live ceremony');
    this.name = 'StageBusyError';
  }
}

export interface LotteryStage {
  snapshot(): LotterySnapshot;
  /**
   * Arm the pre-commitment lobby (#198) — visible from `setup` onward so members can join
   * the Activity before `begin` is called. Clears any previous (finished/aborted) run's state.
   * Throws {@link StageBusyError} from `waiting`/`revealing`: once a commitment exists the stage
   * is showing a committed ceremony, and re-arming a lobby would erase its `start` and reveals,
   * leaving viewers on a board with no commitment line. Guild-agnostic on purpose — the two bot
   * callers (`setup`, `minigame`) only ever fire pre-commitment, so a lobby arriving mid-reveal
   * is always a race or a stale retry, never something to honour.
   */
  lobby(lobby: LotteryLobby): void;
  /**
   * Disarm an armed lobby, returning the stage to `idle` (#198). Deliberately narrow: a no-op
   * unless the phase is `lobby` and the guild matches, so it can never tear down a committed
   * run. The bot calls it on every path that leaves a lobby with no ceremony behind it — an
   * abort before `begin`, or a `begin` that runs in channel mode. Without it a stale lobby would
   * shadow the draft dashboard at the Activity root (see `routes.ts`) until the api restarted.
   */
  clear(clear: LotteryClear): void;
  /**
   * (Re)open the stage for a new ceremony — clears any previous run's state. Throws
   * {@link StageBusyError} when a *different* guild's reveal is mid-flight (see
   * {@link LotteryStart.guildId}); finished/aborted/waiting runs may always be replaced.
   */
  start(start: LotteryStart): void;
  beat(beat: LotteryBeat): void;
  reveal(reveal: LotteryReveal): void;
  finish(finish: LotteryFinish): void;
  abort(abort: LotteryAbort): void;
  /** Subscribe to events; returns an unsubscribe fn. New events only — snapshots are pulled. */
  subscribe(listener: (event: LotteryEvent) => void): () => void;
}

type Parsed<T> = { value: T } | { error: string };

function parseJson(body: string): Parsed<Record<string, unknown>> {
  try {
    const data = JSON.parse(body || '{}') as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { error: 'body must be a JSON object' };
    }
    return { value: data as Record<string, unknown> };
  } catch {
    return { error: 'invalid JSON body' };
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** Guard for `POST /api/lottery/start`. */
export function parseLotteryStart(body: string): Parsed<LotteryStart> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  const rows = Array.isArray(r.rows)
    ? r.rows.filter(
        (row): row is LotteryOddsRow =>
          !!row &&
          typeof row === 'object' &&
          isStr((row as LotteryOddsRow).team) &&
          isNum((row as LotteryOddsRow).balls) &&
          isNum((row as LotteryOddsRow).firstPct) &&
          isNum((row as LotteryOddsRow).top3Pct),
      )
    : undefined;
  if (
    !isStr(r.title) ||
    !isStr(r.commitment) ||
    !isNum(r.teamCount) ||
    !isNum(r.totalBalls) ||
    !isNum(r.delayMs) ||
    !rows ||
    rows.length === 0 ||
    rows.length !== (r.rows as unknown[]).length
  ) {
    return { error: 'start needs title, commitment, teamCount, totalBalls, delayMs, rows[]' };
  }
  return {
    value: {
      title: r.title,
      commitment: r.commitment,
      teamCount: r.teamCount,
      totalBalls: r.totalBalls,
      delayMs: r.delayMs,
      rows,
      ...(isStr(r.guildId) ? { guildId: r.guildId } : {}),
    },
  };
}

/** Guard for `POST /api/lottery/beat`. */
export function parseLotteryBeat(body: string): Parsed<LotteryBeat> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  if (!isNum(r.pick) || !isStrArray(r.remaining)) {
    return { error: 'beat needs pick and remaining[]' };
  }
  return { value: { pick: r.pick, remaining: r.remaining } };
}

/** Guard for `POST /api/lottery/reveal`. */
export function parseLotteryReveal(body: string): Parsed<LotteryReveal> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  if (
    !isNum(r.pick) ||
    !isStr(r.team) ||
    !isNum(r.balls) ||
    !isNum(r.oddsPct) ||
    !isStrArray(r.remaining)
  ) {
    return { error: 'reveal needs pick, team, balls, oddsPct, remaining[]' };
  }
  return {
    value: {
      pick: r.pick,
      team: r.team,
      balls: r.balls,
      oddsPct: r.oddsPct,
      remaining: r.remaining,
    },
  };
}

/** Guard for `POST /api/lottery/finish`. */
export function parseLotteryFinish(body: string): Parsed<LotteryFinish> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  const order = Array.isArray(r.order)
    ? r.order.filter(
        (e): e is { pick: number; team: string } =>
          !!e &&
          typeof e === 'object' &&
          isNum((e as { pick: unknown }).pick) &&
          isStr((e as { team: unknown }).team),
      )
    : undefined;
  const v = r.verify as Record<string, unknown> | undefined;
  const verifyOk =
    !!v &&
    typeof v === 'object' &&
    isStr(v.secretSeed) &&
    isStr(v.salt) &&
    isStr(v.drawSeed) &&
    isStr(v.commitment);
  if (!order || order.length === 0 || order.length !== (r.order as unknown[]).length || !verifyOk) {
    return { error: 'finish needs order[] and verify{secretSeed,salt,drawSeed,commitment}' };
  }
  return {
    value: {
      order,
      verify: {
        secretSeed: v.secretSeed as string,
        salt: v.salt as string,
        drawSeed: v.drawSeed as string,
        commitment: v.commitment as string,
      },
    },
  };
}

/** Guard for `POST /api/lottery/abort`. */
export function parseLotteryAbort(body: string): Parsed<LotteryAbort> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  return { value: { reason: isStr(r.reason) ? r.reason : 'The ceremony was aborted.' } };
}

/**
 * Guard for `POST /api/lottery/lobby`. Stricter on counts than {@link parseLotteryStart}: a lobby
 * is armed from `setup` and can sit on screen for days, so a nonsense `teamCount`/`totalBalls`
 * would be visible far longer than a bad `start` ever is. Counts must be positive integers and
 * `totalBalls` must equal the row sum, which is exactly how the bot derives it.
 */
export function parseLotteryLobby(body: string): Parsed<LotteryLobby> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  const rows = Array.isArray(r.rows)
    ? r.rows.filter(
        (row): row is LotteryOddsRow =>
          !!row &&
          typeof row === 'object' &&
          isStr((row as LotteryOddsRow).team) &&
          isPosInt((row as LotteryOddsRow).balls) &&
          isNum((row as LotteryOddsRow).firstPct) &&
          isNum((row as LotteryOddsRow).top3Pct),
      )
    : undefined;
  if (
    !isStr(r.title) ||
    !isPosInt(r.teamCount) ||
    !isPosInt(r.totalBalls) ||
    !rows ||
    rows.length === 0 ||
    rows.length !== (r.rows as unknown[]).length
  ) {
    return { error: 'lobby needs title, positive teamCount/totalBalls, rows[]' };
  }
  if (r.totalBalls !== rows.reduce((sum, row) => sum + row.balls, 0)) {
    return { error: 'lobby totalBalls must equal the sum of rows[].balls' };
  }
  return {
    value: {
      title: r.title,
      teamCount: r.teamCount,
      totalBalls: r.totalBalls,
      rows,
      ...(isStr(r.guildId) ? { guildId: r.guildId } : {}),
    },
  };
}

/** Guard for `POST /api/lottery/clear` — an optional guild scope is the whole payload. */
export function parseLotteryClear(body: string): Parsed<LotteryClear> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  return { value: isStr(r.guildId) ? { guildId: r.guildId } : {} };
}

export function createLotteryStage(): LotteryStage {
  let phase: LotteryPhase = 'idle';
  let lobby: LotteryLobby | undefined;
  let start: LotteryStart | undefined;
  let pendingBeat: LotteryBeat | undefined;
  let reveals: LotteryReveal[] = [];
  let finish: LotteryFinish | undefined;
  let abort: LotteryAbort | undefined;
  const listeners = new Set<(event: LotteryEvent) => void>();

  function emit(event: LotteryEvent): void {
    for (const listener of listeners) listener(event);
  }

  return {
    snapshot: () => ({ phase, lobby, start, pendingBeat, reveals: [...reveals], finish, abort }),
    lobby(next) {
      // Stricter than start()'s check, and deliberately not guild-scoped: a committed run owns the
      // stage outright. Overwriting `waiting`/`revealing` here would blank `start` (and therefore
      // the commitment line and odds table) while the pacing bot keeps POSTing beats, so a late
      // joiner would land on a board with no commitment. The bot only arms a lobby from GAME_OPEN,
      // so this rejection can only ever fire on a raced or retried POST — the 409 is the whole
      // point. Finished/aborted/idle/lobby all re-arm freely (pre-commitment, nothing to protect).
      if (phase === 'waiting' || phase === 'revealing') {
        throw new StageBusyError();
      }
      phase = 'lobby';
      lobby = next;
      start = undefined;
      pendingBeat = undefined;
      reveals = [];
      finish = undefined;
      abort = undefined;
      emit({ type: 'lottery-lobby', lobby: next });
    },
    clear(next) {
      // Narrow by design: only an armed lobby is disarmable, so this can never tear down a
      // committed run even if a stale bot fires it late. Silent no-op otherwise — the callers are
      // fire-and-forget cleanup paths that have nothing useful to do with a rejection.
      if (phase !== 'lobby') return;
      if ((lobby?.guildId ?? undefined) !== (next.guildId ?? undefined)) return;
      phase = 'idle';
      lobby = undefined;
      start = undefined;
      pendingBeat = undefined;
      reveals = [];
      finish = undefined;
      abort = undefined;
      // Reuse the snapshot event: clients already repaint wholesale from it, so returning to the
      // idle screen needs no new client branch.
      emit({ type: 'lottery-state', snapshot: { phase, reveals: [] } });
    },
    start(next) {
      // One live ceremony at a time: never let a second guild clobber an armed or mid-flight
      // run (its bot receives the rejection and falls back to the in-channel card reveal).
      // Finished/aborted runs always release the stage; a same-guild restart is always allowed.
      // Lobby phase releases for start() — the same guild that lobbied now commits.
      if (
        (phase === 'waiting' || phase === 'revealing') &&
        start?.guildId &&
        next.guildId &&
        start.guildId !== next.guildId
      ) {
        throw new StageBusyError();
      }
      phase = 'waiting';
      lobby = undefined;
      start = next;
      pendingBeat = undefined;
      reveals = [];
      finish = undefined;
      abort = undefined;
      emit({ type: 'lottery-start', start: next });
    },
    // Each of these leaves the lobby phase behind, so they clear `lobby` — otherwise a snapshot
    // could carry both a live `lobby` and a `finished`/`aborted` phase, contradicting the field's
    // documented "set when phase is 'lobby'" contract and painting a stale screen for late joiners.
    beat(beat) {
      phase = 'revealing';
      lobby = undefined;
      pendingBeat = beat;
      emit({ type: 'lottery-beat', beat });
    },
    reveal(reveal) {
      phase = 'revealing';
      lobby = undefined;
      pendingBeat = undefined;
      reveals.push(reveal);
      emit({ type: 'lottery-reveal', reveal });
    },
    finish(next) {
      phase = 'finished';
      lobby = undefined;
      pendingBeat = undefined;
      finish = next;
      emit({ type: 'lottery-finish', finish: next });
    },
    abort(next) {
      phase = 'aborted';
      lobby = undefined;
      pendingBeat = undefined;
      abort = next;
      emit({ type: 'lottery-abort', abort: next });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
