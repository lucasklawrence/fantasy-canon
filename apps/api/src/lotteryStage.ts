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

export type LotteryPhase = 'idle' | 'waiting' | 'revealing' | 'finished' | 'aborted';

/** What a (late-)joining client needs to fully reconstruct the presentation. */
export interface LotterySnapshot {
  phase: LotteryPhase;
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

export function createLotteryStage(): LotteryStage {
  let phase: LotteryPhase = 'idle';
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
    snapshot: () => ({ phase, start, pendingBeat, reveals: [...reveals], finish, abort }),
    start(next) {
      // One live ceremony at a time: never let a second guild clobber an armed or mid-flight
      // run (its bot receives the rejection and falls back to the in-channel card reveal).
      // Finished/aborted runs always release the stage; a same-guild restart is always allowed.
      if (
        (phase === 'waiting' || phase === 'revealing') &&
        start?.guildId &&
        next.guildId &&
        start.guildId !== next.guildId
      ) {
        throw new StageBusyError();
      }
      phase = 'waiting';
      start = next;
      pendingBeat = undefined;
      reveals = [];
      finish = undefined;
      abort = undefined;
      emit({ type: 'lottery-start', start: next });
    },
    beat(beat) {
      phase = 'revealing';
      pendingBeat = beat;
      emit({ type: 'lottery-beat', beat });
    },
    reveal(reveal) {
      phase = 'revealing';
      pendingBeat = undefined;
      reveals.push(reveal);
      emit({ type: 'lottery-reveal', reveal });
    },
    finish(next) {
      phase = 'finished';
      pendingBeat = undefined;
      finish = next;
      emit({ type: 'lottery-finish', finish: next });
    },
    abort(next) {
      phase = 'aborted';
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
