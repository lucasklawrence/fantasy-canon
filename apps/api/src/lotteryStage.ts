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
 *
 * The one exception to "dumb relay" is {@link LotteryStage.adjust} (#210): the commissioner can
 * nudge a team's ball count from inside the Activity while the lobby is armed. That still draws
 * nothing — it edits the *pre-commitment* preview and records a pending {@link LotteryAdjustment}
 * the bot drains into its authoritative bag before it commits (ADR 0007). Odds are recomputed
 * here with core's `computePickOdds`, the same function the bot uses, so the table the league
 * watches and the bag the commitment binds never disagree on the math.
 *
 * The payload shapes live in `lotteryTypes.ts` — see the note there on why the browser client
 * imports them from that module rather than this one. They are re-exported here so every existing
 * server-side consumer keeps its single import.
 */

import { computePickOdds, MAX_TEAM_BALLS } from '@fantasy-canon/core';
import type {
  LotteryAbort,
  LotteryAbortRequest,
  LotteryAdjustment,
  LotteryAdjustAllDetail,
  LotteryAdjustmentDetail,
  LotteryAuditMode,
  LotteryBeat,
  LotteryBeginRequest,
  LotteryClear,
  LotteryEvent,
  LotteryFinish,
  LotteryLobby,
  LotteryLobbyRequest,
  LotteryOddsRow,
  LotteryPhase,
  LotteryRename,
  LotteryRenameDetail,
  LotteryReveal,
  LotterySnapshot,
  LotteryStart,
} from './lotteryTypes.js';

export * from './lotteryTypes.js';

/** Thrown by {@link LotteryStage.start} when another guild's reveal is currently live. */
export class StageBusyError extends Error {
  constructor() {
    super('the stage is showing another live ceremony');
    this.name = 'StageBusyError';
  }
}

/**
 * Thrown by {@link LotteryStage.adjust} when the stage is not an editable pre-commitment lobby.
 * The whole safety argument for in-Activity editing is that it can only touch a bag no commitment
 * binds yet (ADR 0006 fairness, ADR 0007), so this is a hard refusal, not a retry hint.
 */
export class StageNotEditableError extends Error {
  constructor(message = 'only a pre-commitment lobby can be adjusted') {
    super(message);
    this.name = 'StageNotEditableError';
  }
}

/**
 * Thrown by {@link LotteryStage.rename} when the new name already belongs to another row.
 * `createCeremony` rejects duplicate display names case-insensitively, so accepting one here
 * would only defer the failure to `begin` — after the league had already seen the new name.
 */
export class DuplicateTeamNameError extends Error {
  constructor(name: string) {
    super(`another team is already called "${name}"`);
    this.name = 'DuplicateTeamNameError';
  }
}

/** Thrown by {@link LotteryStage.adjust} when no lobby row carries the requested `teamId`. */
export class UnknownTeamError extends Error {
  constructor(teamId: string) {
    super(`no team ${teamId} in this lobby`);
    this.name = 'UnknownTeamError';
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
  lobby(lobby: LotteryLobbyRequest): void;
  /**
   * Apply a commissioner's in-Activity ball edit (#210) and re-broadcast the lobby with recomputed
   * odds. Legal only while an armed lobby is on screen — throws {@link StageNotEditableError}
   * otherwise, and {@link UnknownTeamError} when no row carries that `teamId`. Authorization is
   * the caller's job: `routes.ts` verifies the Discord token server-side and checks
   * {@link LotteryStage.isCommissioner} first.
   */
  adjust(adjustment: LotteryAdjustment): void;
  /**
   * Level every team to the same ball count in one act (#252) — the Activity's "set all to N"
   * tool. One recompute, one broadcast, one pending set; the broadcast carries an
   * {@link LotteryAdjustAllDetail} so the bot posts one audit line instead of twelve. Same
   * guards as {@link LotteryStage.adjust}.
   */
  adjustAll(balls: number): void;
  /**
   * Set the audit chatter preference (#252). Commissioner-gated like every lobby write; frozen
   * while a begin is pending (#233's rule). Survives re-arms, resets when the lobby dies.
   */
  setAuditMode(mode: LotteryAuditMode): void;
  /**
   * Apply a commissioner's in-Activity display-name fix (#219) and re-broadcast the lobby. Same
   * lobby-only guard as {@link LotteryStage.adjust}; additionally throws
   * {@link DuplicateTeamNameError} when the name collides with another row. Cosmetic by
   * construction — the commitment preimage never sees a display name.
   */
  rename(rename: LotteryRename): void;
  /**
   * Flag that the commissioner wants the league refetched from ESPN (#219). This process cannot
   * do it — no league config, no cookies — so the flag is a request the bot's stage watcher
   * honours, clearing it when it re-arms the lobby with fresh data.
   */
  requestReimport(): void;
  /**
   * Flag that the commissioner wants the bag sealed and the draw started (#233). Same shape as
   * {@link LotteryStage.requestReimport}: this process can never commit or draw (ADR 0006), so
   * the flag is a doorbell the bot's stage watcher answers by running the identical flow as
   * `/canon draftorder begin`. While it is pending the lobby is frozen — `adjust`, `rename`,
   * `requestReimport`, and a second `requestBegin` all throw {@link StageNotEditableError}, so
   * no write can land between the bot's drain and its commitment. Cleared when the bot's `start`
   * replaces the lobby, or by any re-arm/teardown — a bag that changed after the press must be
   * re-confirmed against what the league can see.
   */
  requestBegin(request: LotteryBeginRequest): void;
  /**
   * Is this Discord user id allowed to {@link LotteryStage.adjust}? False whenever no lobby is
   * armed, so a stale token can never edit a committed or finished run.
   */
  isCommissioner(userId: string): boolean;
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
  /** See {@link LotteryAbortRequest} — a conditional request that no longer matches is a no-op. */
  abort(abort: LotteryAbortRequest): void;
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
      // Unknown values are dropped rather than rejected (#235): the visual is presentation-only,
      // so a newer bot's vocabulary degrades to the machine instead of stalling the ceremony.
      ...(r.visual === 'machine' || r.visual === 'race' ? { visual: r.visual } : {}),
      // Same rule for the ball faces (#252): numbers is the absent default, junk degrades.
      ...(r.ballFaces === 'logos' ? { ballFaces: 'logos' as const } : {}),
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
export function parseLotteryAbort(body: string): Parsed<LotteryAbortRequest> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  return {
    value: {
      reason: isStr(r.reason) ? r.reason : 'The ceremony was aborted.',
      ...(isStr(r.ifCommitment) ? { ifCommitment: r.ifCommitment } : {}),
    },
  };
}

/**
 * Guard for `POST /api/lottery/lobby`. Stricter on counts than {@link parseLotteryStart}: a lobby
 * is armed from `setup` and can sit on screen for days, so a nonsense `teamCount`/`totalBalls`
 * would be visible far longer than a bad `start` ever is. Counts must be positive integers and
 * `totalBalls` must equal the row sum, which is exactly how the bot derives it.
 */
export function parseLotteryLobby(body: string): Parsed<LotteryLobbyRequest> {
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
          isNum((row as LotteryOddsRow).top3Pct) &&
          // Present-but-not-a-string would be stored as-is and then never match an `adjust`
          // targeting it, leaving the row silently un-editable for the whole lobby (#210).
          ((row as LotteryOddsRow).teamId === undefined || isStr((row as LotteryOddsRow).teamId)),
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
      ...(isStrArray(r.commissionerIds) ? { commissionerIds: r.commissionerIds } : {}),
      ...(r.keepAdjustments === true ? { keepAdjustments: true } : {}),
    },
  };
}

/**
 * Guard for `POST /api/lottery/adjust` (#210). Strictest parser here, because this is the only
 * body that arrives from the *public* Activity client rather than the bot: `balls` must be an
 * integer inside the same 1..{@link MAX_TEAM_BALLS} window the bot's `balls:` override enforces,
 * so a hostile client cannot hand the odds DP a 10-million-ball bag.
 */
/** True for any C0/C7F control character — newlines and friends have no place in a team name. */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Longest display name the odds table and the renderer's card can show without clipping. */
export const MAX_TEAM_NAME_LENGTH = 40;

/**
 * Guard for `POST /api/lottery/rename` (#219). Like {@link parseLotteryAdjust} this body comes
 * from the *public* Activity client, so the name is trimmed, length-capped, and rejected if it
 * carries control characters or newlines — it ends up in Discord message content and on a rendered
 * card, and neither should have to cope with a 10KB single-line "name".
 */
export function parseLotteryRename(body: string): Parsed<LotteryRename> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  if (!isStr(r.teamId)) return { error: 'rename needs a teamId' };
  if (typeof r.displayName !== 'string') return { error: 'rename needs a displayName' };
  const displayName = r.displayName.trim();
  if (!displayName) return { error: 'displayName cannot be blank' };
  if (displayName.length > MAX_TEAM_NAME_LENGTH) {
    return { error: `displayName is capped at ${MAX_TEAM_NAME_LENGTH} characters` };
  }
  if (hasControlCharacters(displayName)) {
    return { error: 'displayName cannot contain control characters or line breaks' };
  }
  return { value: { teamId: r.teamId, displayName } };
}

export function parseLotteryAdjust(body: string): Parsed<LotteryAdjustment> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  if (!isStr(r.teamId)) return { error: 'adjust needs a teamId' };
  if (!isPosInt(r.balls) || r.balls > MAX_TEAM_BALLS) {
    return { error: `adjust needs balls between 1 and ${MAX_TEAM_BALLS}` };
  }
  return { value: { teamId: r.teamId, balls: r.balls } };
}

/** The reveal pacings the Activity's picker offers — the same spread the slash `delay` gets used at. */
export const BEGIN_DELAY_CHOICES = [5, 10, 20, 30] as const;

/**
 * Guard for `POST /api/lottery/begin` (#233). Public-client body like adjust/rename, so it is a
 * closed vocabulary: only the picker's exact delay values and the two reveal orders pass — a
 * hostile client must not be able to ask the bot for a 0s (or 10-hour) pacing. `requestedBy` is
 * deliberately NOT read from the body; the route stamps it from the verified bearer.
 */
export function parseLotteryBegin(
  body: string,
): Parsed<Pick<LotteryBeginRequest, 'delaySeconds' | 'direction' | 'visual' | 'ballFaces'>> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  if (!(BEGIN_DELAY_CHOICES as readonly number[]).includes(r.delaySeconds as number)) {
    return { error: `begin needs delaySeconds in {${BEGIN_DELAY_CHOICES.join(', ')}}` };
  }
  if (r.direction !== 'worst-to-first' && r.direction !== 'first-to-last') {
    return { error: 'begin needs direction "worst-to-first" or "first-to-last"' };
  }
  // Absent defaults to the machine (an older bundle simply doesn't offer the picker, #235);
  // present-but-junk is rejected like the rest of the vocabulary.
  if (r.visual !== undefined && r.visual !== 'machine' && r.visual !== 'race') {
    return { error: 'begin needs visual "machine" or "race"' };
  }
  // Same shape for the ball faces (#252): absent ⇒ numbers, junk rejected.
  if (r.ballFaces !== undefined && r.ballFaces !== 'numbers' && r.ballFaces !== 'logos') {
    return { error: 'begin needs ballFaces "numbers" or "logos"' };
  }
  return {
    value: {
      delaySeconds: r.delaySeconds as number,
      direction: r.direction,
      visual: r.visual === 'race' ? 'race' : 'machine',
      ballFaces: r.ballFaces === 'logos' ? 'logos' : 'numbers',
    },
  };
}

/** Guard for `POST /api/lottery/audit-mode` (#252) — a two-word closed vocabulary. */
export function parseLotteryAuditMode(body: string): Parsed<{ mode: LotteryAuditMode }> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  if (r.mode !== 'live' && r.mode !== 'seal-only') {
    return { error: 'audit-mode needs mode "live" or "seal-only"' };
  }
  return { value: { mode: r.mode } };
}

/** Guard for `POST /api/lottery/adjust-all` (#252) — same public-client rigor as `adjust`. */
export function parseLotteryAdjustAll(body: string): Parsed<{ balls: number }> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  if (!isPosInt(r.balls) || r.balls > MAX_TEAM_BALLS) {
    return { error: `adjust-all needs balls between 1 and ${MAX_TEAM_BALLS}` };
  }
  return { value: { balls: r.balls } };
}

/** Guard for `POST /api/lottery/clear` — an optional guild scope is the whole payload. */
export function parseLotteryClear(body: string): Parsed<LotteryClear> {
  const parsed = parseJson(body);
  if ('error' in parsed) return parsed;
  const r = parsed.value;
  return { value: isStr(r.guildId) ? { guildId: r.guildId } : {} };
}

/**
 * Rebuild a lobby's rows with `balls` overridden per {@link LotteryAdjustment} and the `firstPct`/
 * `top3Pct` columns recomputed from scratch. Uses core's `computePickOdds` — the exact function
 * behind the bot's odds card — so an edited table is arithmetically identical to what the bot
 * would publish for the same bag.
 *
 * Row *order* is preserved on purpose: the bot sorts by ball count, but re-sorting under the
 * commissioner's finger while they tap a stepper is a UX trap. The next bot-armed lobby (or the
 * `start` that commits) restores the sorted order.
 *
 * Throws {@link StageNotEditableError} when the rows can't support exact odds — a row without a
 * `teamId`, duplicate ids, or a bag wider than core's exact-odds cap.
 */
function applyAdjustments(
  rows: LotteryOddsRow[],
  balls: ReadonlyMap<string, number>,
): LotteryOddsRow[] {
  const next = rows.map((row) => ({
    ...row,
    balls: (row.teamId !== undefined ? balls.get(row.teamId) : undefined) ?? row.balls,
  }));
  const teams = next.map((row) => {
    if (row.teamId === undefined) {
      throw new StageNotEditableError(
        'this lobby was armed without team ids, so it cannot be edited',
      );
    }
    return { teamId: row.teamId, baseBalls: row.balls, bonusBalls: 0 };
  });
  let odds;
  try {
    // computePickOdds rejects duplicate ids and caps the team count; either means this lobby was
    // never adjustable, so surface it as "not editable" rather than a 500.
    odds = computePickOdds(teams);
  } catch (error) {
    throw new StageNotEditableError(
      `this lobby cannot be adjusted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return next.map((row, index) => {
    const probabilities = odds[index].probabilities;
    return {
      ...row,
      firstPct: probabilities[0] * 100,
      top3Pct: probabilities.slice(0, 3).reduce((sum, p) => sum + p, 0) * 100,
    };
  });
}

/**
 * Overlay pending display-name fixes onto a row set (#219). Names are cosmetic — the commitment
 * preimage hashes `teamId` and ball counts only — so unlike {@link applyAdjustments} this can
 * never fail, and needs no odds recomputation.
 */
function applyRenames(
  rows: LotteryOddsRow[],
  names: ReadonlyMap<string, string>,
): LotteryOddsRow[] {
  if (names.size === 0) return rows;
  return rows.map((row) => {
    const renamed = row.teamId !== undefined ? names.get(row.teamId) : undefined;
    return renamed === undefined ? row : { ...row, team: renamed };
  });
}

/** Case-insensitive, so a rename can't produce the collision `createCeremony` would reject. */
function nameTakenByAnother(rows: LotteryOddsRow[], teamId: string, name: string): boolean {
  const key = name.trim().toLowerCase();
  return rows.some((row) => row.teamId !== teamId && row.team.trim().toLowerCase() === key);
}

export function createLotteryStage(): LotteryStage {
  let phase: LotteryPhase = 'idle';
  let lobby: LotteryLobby | undefined;
  /** Discord user ids allowed to adjust the armed lobby (#210); never broadcast. */
  let commissionerIds: string[] = [];
  /** Pending in-Activity edits, teamId → new total balls, drained by the bot at `begin`. */
  let adjustments = new Map<string, number>();
  /** Pending display-name fixes, teamId → new name, drained alongside the ball edits (#219). */
  let renames = new Map<string, string>();
  /** The commissioner asked for an ESPN refetch; only the bot can honour it (#219). */
  let reimportRequested = false;
  /** The commissioner asked to seal the bag and start the draw; only the bot can (#233). */
  let beginRequested: LotteryBeginRequest | undefined;
  /**
   * Audit chatter preference (#252): 'live' (default) posts a silent line per edit, 'seal-only'
   * saves it all for begin's adjusted odds card. Survives re-arms (a mini-game or re-import
   * republishing the lobby must not silently flip the commissioner's preference back on) and
   * dies with the lobby lifecycle in {@link dropLobby}.
   */
  let auditMode: LotteryAuditMode = 'live';
  /**
   * Monotonic arm counter for {@link LotteryLobby.armedSeq} (#232). Seeded from the clock so the
   * values a restarted api hands out never collide with the previous process's — a client that
   * kept its iframe open across the restart must still see the next arm as new.
   */
  let lobbySeq = Date.now();
  let start: LotteryStart | undefined;
  let pendingBeat: LotteryBeat | undefined;
  let reveals: LotteryReveal[] = [];
  let finish: LotteryFinish | undefined;
  let abort: LotteryAbort | undefined;
  const listeners = new Set<(event: LotteryEvent) => void>();

  function emit(event: LotteryEvent): void {
    for (const listener of listeners) listener(event);
  }

  /**
   * The pending edit-and-request set as the wire carries it — omitted entirely when there is
   * nothing pending. The begin request (#233) rides the same envelope as the edits: it is pending
   * bot work against this specific lobby, with the same lifetime.
   */
  function pendingAdjustments(): {
    adjustments?: LotteryAdjustment[];
    renames?: LotteryRename[];
    reimportRequested?: boolean;
    beginRequested?: LotteryBeginRequest;
    auditMode?: LotteryAuditMode;
  } {
    return {
      ...(adjustments.size > 0
        ? { adjustments: [...adjustments].map(([teamId, balls]) => ({ teamId, balls })) }
        : {}),
      ...(renames.size > 0
        ? { renames: [...renames].map(([teamId, displayName]) => ({ teamId, displayName })) }
        : {}),
      ...(reimportRequested ? { reimportRequested: true } : {}),
      ...(beginRequested ? { beginRequested } : {}),
      ...(auditMode !== 'live' ? { auditMode } : {}),
    };
  }

  /**
   * Leave the lobby phase. Editors and pending edits are lobby-scoped — an adjustment that
   * outlived its lobby could be drained into a bag the commissioner never saw it against, and a
   * lingering `commissionerIds` would keep a write path open over a committed run.
   */
  function dropLobby(): void {
    lobby = undefined;
    commissionerIds = [];
    adjustments = new Map();
    renames = new Map();
    reimportRequested = false;
    beginRequested = undefined;
    auditMode = 'live';
  }

  return {
    snapshot: () => ({
      phase,
      lobby,
      start,
      pendingBeat,
      reveals: [...reveals],
      finish,
      abort,
      // Omitted entirely when empty so the common snapshot stays byte-identical to before (#210).
      ...pendingAdjustments(),
    }),
    isCommissioner: (userId) => phase === 'lobby' && commissionerIds.includes(userId),
    lobby(next) {
      // Stricter than start()'s check, and deliberately not guild-scoped: a committed run owns the
      // stage outright. Overwriting `waiting`/`revealing` here would blank `start` (and therefore
      // the commitment line and odds table) while the pacing bot keeps POSTing beats, so a late
      // joiner would land on a board with no commitment. Finished/aborted/idle/lobby all re-arm
      // freely — nothing committed is on screen to protect.
      //
      // Known trade-off: this also removes the accidental self-healing a laxer check gave us. If
      // the stage is stranded mid-reveal (the bot died between `start` and `finish`, so no
      // `finish`/`abort` ever arrives), every later `setup` 409s until the run is torn down. The
      // bot's boot reconciler (#205, `recoverInterruptedCeremonies`) owns that recovery: at
      // startup it aborts a stranded run and clears an orphaned lobby, since nothing on the
      // stage can still have a pacer once the bot's in-memory sessions are gone. A stage-side
      // TTL fallback (heals even if no bot ever returns) is deliberately deferred to #191.
      if (phase === 'waiting' || phase === 'revealing') {
        throw new StageBusyError();
      }
      const { commissionerIds: editors = [], keepAdjustments = false, ...publicLobby } = next;
      // `keepAdjustments` re-applies still-pending edits onto the fresh rows, so a bot re-arm that
      // did *not* drain them (the mini-game path) republishes the odds the league is looking at
      // instead of silently reverting them. A plain re-arm drops them: a new `setup` is a new bag.
      //
      // Resolved *before* any state is written, and never allowed to fail the re-arm: if the new
      // rows can't carry exact odds (no team ids, duplicates, too many teams) the pending edits
      // are dropped and the bot's rows stand. Arming a lobby is the bot's authoritative act — a
      // stale client-side edit must not be able to 500 it, let alone half-apply it.
      let carried =
        keepAdjustments && adjustments.size > 0
          ? new Map<string, number>(adjustments)
          : new Map<string, number>();
      // Renames ride with the ball edits: both are pending until `begin` drains them, so a re-arm
      // that keeps one must keep the other or the lobby would show a name the bot no longer has.
      let carriedNames =
        keepAdjustments && renames.size > 0
          ? new Map<string, string>(renames)
          : new Map<string, string>();
      let rows = applyRenames(publicLobby.rows, carriedNames);
      if (carried.size > 0) {
        try {
          rows = applyAdjustments(rows, carried);
        } catch {
          carried = new Map();
          carriedNames = new Map();
          rows = publicLobby.rows;
        }
      }
      phase = 'lobby';
      commissionerIds = [...editors];
      adjustments = carried;
      renames = carriedNames;
      // A re-arm is the bot publishing a bag it just derived, so any outstanding refetch request
      // has either been honoured or is moot. A pending begin dies with it too: the bag the
      // commissioner pressed the button against is not the bag now on screen (ADR 0006 — any
      // change after the press must be re-confirmed against a fresh public preview).
      reimportRequested = false;
      beginRequested = undefined;
      lobby = {
        ...publicLobby,
        rows,
        totalBalls: rows.reduce((sum, row) => sum + row.balls, 0),
        // Bumps per arm, never per edit — the client-side signal that the commissioner stamp may
        // have changed and `/api/lottery/me` is worth re-asking (#232).
        armedSeq: ++lobbySeq,
      };
      start = undefined;
      pendingBeat = undefined;
      reveals = [];
      finish = undefined;
      abort = undefined;
      // `adjustments`/`renames` ride along so a subscriber can dedupe on stage state (#220): a
      // re-arm that kept pending edits and one that dropped them look identical otherwise.
      emit({ type: 'lottery-lobby', lobby, ...pendingAdjustments() });
    },
    adjust(next) {
      if (phase !== 'lobby' || !lobby || beginRequested) throw new StageNotEditableError();
      const target = lobby.rows.find((row) => row.teamId === next.teamId);
      if (!target) {
        throw new UnknownTeamError(next.teamId);
      }
      const pending = new Map(adjustments).set(next.teamId, next.balls);
      // applyAdjustments throws before anything is committed, so a lobby that can't carry exact
      // odds leaves the stage exactly as it was.
      const rows = applyAdjustments(lobby.rows, pending);
      const detail: LotteryAdjustmentDetail = {
        teamId: next.teamId,
        team: target.team,
        from: target.balls,
        to: next.balls,
        ...(lobby.guildId ? { guildId: lobby.guildId } : {}),
      };
      adjustments = pending;
      lobby = { ...lobby, rows, totalBalls: rows.reduce((sum, row) => sum + row.balls, 0) };
      // Same event the bot's re-arm emits — every connected client already repaints the odds table
      // wholesale from it, so live viewers see the new bag without a new client branch. `adjusted`
      // rides along for the bot's audit post (#220): it distinguishes this from a re-arm and says
      // exactly what changed, so nobody has to diff two lobbies to describe a human's action.
      emit({ type: 'lottery-lobby', lobby, ...pendingAdjustments(), adjusted: detail });
    },
    adjustAll(balls) {
      if (phase !== 'lobby' || !lobby || beginRequested) throw new StageNotEditableError();
      const pending = new Map<string, number>();
      for (const row of lobby.rows) {
        if (row.teamId === undefined) {
          throw new StageNotEditableError(
            'this lobby was armed without team ids, so it cannot be edited',
          );
        }
        pending.set(row.teamId, balls);
      }
      // One recompute for the whole field — applyAdjustments re-validates and re-derives odds
      // exactly as a single-team edit does, so equal counts land as exact equal odds.
      const rows = applyAdjustments(lobby.rows, pending);
      const detail: LotteryAdjustAllDetail = {
        balls,
        ...(lobby.guildId ? { guildId: lobby.guildId } : {}),
      };
      adjustments = pending;
      lobby = { ...lobby, rows, totalBalls: rows.reduce((sum, row) => sum + row.balls, 0) };
      emit({ type: 'lottery-lobby', lobby, ...pendingAdjustments(), adjustedAll: detail });
    },
    rename(next) {
      if (phase !== 'lobby' || !lobby || beginRequested) throw new StageNotEditableError();
      const target = lobby.rows.find((row) => row.teamId === next.teamId);
      if (!target) throw new UnknownTeamError(next.teamId);
      // `createCeremony` rejects duplicate display names case-insensitively, so a colliding rename
      // has to be refused *here* — draining it at `begin` would blow up the ceremony instead.
      if (nameTakenByAnother(lobby.rows, next.teamId, next.displayName)) {
        throw new DuplicateTeamNameError(next.displayName);
      }
      const detail: LotteryRenameDetail = {
        teamId: next.teamId,
        from: target.team,
        to: next.displayName,
        ...(lobby.guildId ? { guildId: lobby.guildId } : {}),
      };
      renames = new Map(renames).set(next.teamId, next.displayName);
      const rows = applyRenames(lobby.rows, renames);
      lobby = { ...lobby, rows };
      emit({ type: 'lottery-lobby', lobby, ...pendingAdjustments(), renamed: detail });
    },
    setAuditMode(mode) {
      if (phase !== 'lobby' || !lobby || beginRequested) throw new StageNotEditableError();
      auditMode = mode;
      emit({ type: 'lottery-lobby', lobby, ...pendingAdjustments() });
    },
    requestReimport() {
      if (phase !== 'lobby' || !lobby || beginRequested) throw new StageNotEditableError();
      // Only a flag: this process has no ESPN league config and no cookies, so the refetch is the
      // bot's to perform. It clears when the bot re-arms the lobby with what it fetched.
      reimportRequested = true;
      emit({ type: 'lottery-lobby', lobby, ...pendingAdjustments() });
    },
    requestBegin(request) {
      // A pending begin freezes the whole lobby (adjust/rename/re-import/begin all 409): the bot
      // is about to drain the pending set and commit, and a write landing after that read would
      // put a bag on screen the commitment doesn't bind. The freeze lifts when the bot's `start`
      // replaces the lobby or a re-arm voids the press — never silently.
      if (phase !== 'lobby' || !lobby || beginRequested) throw new StageNotEditableError();
      // Only a request: the bot is the sole committer (ADR 0006), so all this does is broadcast
      // "sealing…" — which is also what disables every viewer's begin button until the bot's
      // `start` replaces the lobby or a re-arm invalidates the press.
      beginRequested = request;
      emit({ type: 'lottery-lobby', lobby, ...pendingAdjustments() });
    },
    clear(next) {
      // Narrow by design: only an armed lobby is disarmable, so this can never tear down a
      // committed run even if a stale bot fires it late. Silent no-op otherwise — the callers are
      // fire-and-forget cleanup paths that have nothing useful to do with a rejection.
      if (phase !== 'lobby') return;
      if ((lobby?.guildId ?? undefined) !== (next.guildId ?? undefined)) return;
      phase = 'idle';
      dropLobby();
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
      // The commitment binds the bot's bag, so any edit still pending here was made after the bot
      // drained — it is deliberately discarded rather than left to be applied to a sealed bag.
      dropLobby();
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
      dropLobby();
      pendingBeat = beat;
      emit({ type: 'lottery-beat', beat });
    },
    reveal(reveal) {
      phase = 'revealing';
      dropLobby();
      pendingBeat = undefined;
      reveals.push(reveal);
      emit({ type: 'lottery-reveal', reveal });
    },
    finish(next) {
      phase = 'finished';
      dropLobby();
      pendingBeat = undefined;
      finish = next;
      emit({ type: 'lottery-finish', finish: next });
    },
    abort(next) {
      const { ifCommitment, ...publicAbort } = next;
      // A conditional abort (#205) targets one specific committed run; if the stage has moved on
      // — a fresh ceremony replaced it, or it already finished/aborted — the request is stale and
      // must not touch what's showing now.
      if (
        ifCommitment !== undefined &&
        !((phase === 'waiting' || phase === 'revealing') && start?.commitment === ifCommitment)
      ) {
        return;
      }
      phase = 'aborted';
      dropLobby();
      pendingBeat = undefined;
      abort = publicAbort;
      emit({ type: 'lottery-abort', abort: publicAbort });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
