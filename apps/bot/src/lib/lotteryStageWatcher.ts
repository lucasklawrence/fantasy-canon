/**
 * Watches the Activity stage's WebSocket so an in-Activity commissioner edit shows up in the
 * league's channel when it happens, not only when `begin` posts the pre-commitment odds card
 * (#220, ADR 0007 §5).
 *
 * **Read-only, and deliberately not part of the fairness path.** `begin` remains the single
 * authoritative drain: this watcher never touches a `CeremonySession`'s bag. All it does is turn a
 * `lottery-lobby` broadcast carrying an `adjusted` detail into one line in the channel where
 * `setup` ran. If the socket is down for the whole lobby the ceremony is unaffected — the commit
 * still binds a bag published in-channel first, because `begin` re-posts the full odds card.
 *
 * Direction is unchanged: this is an **outbound** connection from the bot, exactly like its
 * `/api/lottery/*` POSTs. The bot still exposes no inbound surface.
 *
 * Everything side-effectful is injected — the socket factory, the poster, the clock — so the whole
 * reconnect/dedupe state machine unit-tests with no socket and no timers of its own (the Node-24
 * native-teardown lesson from #156).
 */

import { WebSocket } from 'ws';

/**
 * What one commissioner edit changed (mirrors the api's `LotteryAdjustmentDetail`, same as
 * `StageOddsRow`/`StageStateSnapshot` mirror their api counterparts — the bot doesn't depend on
 * `apps/api`). `from` is optional here because the connect-time reconcile path can't recover it:
 * a snapshot only carries the *current* count.
 */
export interface StageAdjustmentDetail {
  teamId: string;
  team: string;
  from?: number;
  to: number;
  guildId?: string;
}

/**
 * The Activity's "start a lottery" doorbell (#253); mirrors the api's `LotterySetupRequest`.
 * Everything re-validated bot-side — most importantly `requestedBy`'s Manage Server permission
 * in `guildId`, the same gate the slash command uses.
 */
export interface StageSetupRequest {
  guildId: string;
  requestedBy: string;
  season: number;
}

/** One bulk level-all (#252); mirrors the api's `LotteryAdjustAllDetail`. */
export interface StageAdjustAllDetail {
  balls: number;
  guildId?: string;
}

/** What one display-name fix changed (#219); mirrors the api's `LotteryRenameDetail`. */
export interface StageRenameDetail {
  teamId: string;
  from?: string;
  to: string;
  guildId?: string;
}

/**
 * The Activity's "seal the bag & start the draw" request (#233); mirrors the api's
 * `LotteryBeginRequest`. Values are re-validated bot-side — the stage already rejects anything
 * outside its closed vocabulary, but this process must not trust a frame it didn't author.
 */
export interface StageBeginRequest {
  delaySeconds: number;
  direction: 'worst-to-first' | 'first-to-last';
  /** Hopper-ball faces (#252): numbers (default) or team logos. */
  ballFaces?: 'numbers' | 'logos';
  /** Reveal visualization (#235). Absent (an older api) ⇒ the machine. */
  visual?: 'machine' | 'race';
  /** Discord user id of the commissioner who pressed the button, stamped by the api's route. */
  requestedBy?: string;
}

/** The subset of a `WebSocket` this module drives — satisfied by both `ws` and the browser global. */
export interface StageSocket {
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface StageWatcherOptions {
  /** The Activity backend base URL, e.g. `http://127.0.0.1:4610`. `ws(s)` is derived from it. */
  baseUrl: string;
  /** Post one audit line to the guild's lobby channel. Resolves false when there's nowhere to post. */
  post: (guildId: string | undefined, content: string) => Promise<boolean>;
  /**
   * Honour an in-Activity "re-import from ESPN" request (#219) — the one thing this watcher does
   * that mutates a ceremony, because the api cannot reach ESPN and only the bot can. Resolves
   * false when there is nothing to re-import (wrong guild, sealed bag, a manual `teams:` setup).
   * Omitted ⇒ re-import requests are ignored.
   */
  reimport?: (guildId: string | undefined, stamp?: number) => Promise<boolean>;
  /**
   * Honour an in-Activity "seal the bag & start the draw" request (#233) — run the identical flow
   * as `/canon draftorder begin`. Resolves false when there is nothing to begin (wrong guild, no
   * open ceremony, a bag in flux). Omitted ⇒ begin requests are ignored.
   */
  begin?: (guildId: string | undefined, request: StageBeginRequest) => Promise<boolean>;
  /**
   * Honour a "start a lottery" press from a dead-idle stage (#253) — verify Manage Server, then
   * run the slash-`setup` flow (ESPN import, public preview, lobby arm). Resolves false on
   * refusal, and the refusing implementation releases the doorbell with a reason so the idle
   * screens recover. Omitted ⇒ setup requests are ignored.
   */
  setup?: (request: StageSetupRequest) => Promise<boolean>;
  /** Injected for tests; defaults to a `ws` socket (works on every Node this repo runs on). */
  socketFactory?: (url: string) => StageSocket;
  /** Injected for tests; defaults to `setTimeout`. Must return a handle `clearReconnect` accepts. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface StageWatcher {
  /** Open the socket (idempotent). */
  start(): void;
  /** Close it and cancel any pending reconnect (idempotent). */
  stop(): void;
}

/** First reconnect delay; doubles per consecutive failure up to {@link MAX_BACKOFF_MS}. */
export const BASE_BACKOFF_MS = 2_000;
/** Ceiling on the reconnect delay — the stage may be down for days between ceremonies. */
export const MAX_BACKOFF_MS = 60_000;

/** `http(s)://host` → `ws(s)://host/api/lottery/ws`. */
export function stageWsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base.replace(/^http/, 'ws')}/api/lottery/ws`;
}

/**
 * The audit line a single edit produces. Kept here so the wording is testable without a socket.
 * The "(was N)" clause is dropped when the previous count isn't known — the reconcile path reads
 * a snapshot, which only carries the current value, and inventing a before-figure in a message
 * whose whole job is to be the record would be worse than omitting it.
 */
export function adjustmentLine(detail: StageAdjustmentDetail): string {
  const plural = (n: number): string => `${n} ball${n === 1 ? '' : 's'}`;
  const was =
    detail.from !== undefined && detail.from !== detail.to ? ` (was ${plural(detail.from)})` : '';
  return `🛠 Commissioner set **${detail.team}** to ${plural(detail.to)} in the Lottery Machine${was}.`;
}

/** The single audit line a bulk level-all produces (#252) — one act, one line, not twelve. */
export function adjustAllLine(detail: StageAdjustAllDetail): string {
  return `🛠 Commissioner set every team to ${detail.balls} ball${detail.balls === 1 ? '' : 's'} in the Lottery Machine.`;
}

/** The audit line one rename produces (#219). Same "don't invent a before-value" rule as above. */
export function renameLine(detail: StageRenameDetail): string {
  return detail.from !== undefined && detail.from !== detail.to
    ? `🛠 Commissioner renamed **${detail.from}** to **${detail.to}** in the Lottery Machine.`
    : `🛠 Commissioner renamed a team to **${detail.to}** in the Lottery Machine.`;
}

/**
 * Track which ball count we have already announced per team, so the same edit is never posted
 * twice. This matters on reconnect: the stage sends a full `lottery-state` snapshot on connect,
 * and its `adjustments` are the *cumulative* pending set — replaying them verbatim after every
 * blip would spam the channel with edits the league already saw.
 */
type AnnouncedBalls = Map<string, number>;
/** teamId -> the display name already announced, so a rename posts exactly once (#219). */
type AnnouncedNames = Map<string, string>;

export function createStageWatcher(options: StageWatcherOptions): StageWatcher {
  const {
    baseUrl,
    post,
    reimport,
    begin,
    setup,
    // `ws`, not the global `WebSocket`. Node only exposes that global from 22 onward, and the
    // repo's `engines: node >= 24` is a floor we declare, not one anything enforces — a bot
    // started on Node 20 threw `ReferenceError: WebSocket is not defined` here on every reconnect
    // attempt, so the audit lines (#220) and re-import (#219) silently never worked while the log
    // filled up. CI runs Node 24, so nothing caught it. `ws` is already a dependency of `apps/api`
    // and exposes the same `addEventListener` surface, so this is version-proof either way.
    socketFactory = (url): StageSocket => new WebSocket(url),
    schedule = (fn, ms): unknown => setTimeout(fn, ms),
    cancel = (handle): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;

  let socket: StageSocket | null = null;
  let reconnectHandle: unknown = null;
  let attempts = 0;
  let running = false;
  /** Per-guild announced state; cleared for a guild whenever its lobby is re-armed or torn down. */
  const announced = new Map<string, AnnouncedBalls>();
  const announcedNames = new Map<string, AnnouncedNames>();
  /** Guilds whose re-import is already running, so one request is honoured exactly once. */
  const reimporting = new Set<string>();
  /**
   * The newest refetch stamp each guild's stage has shown us (#250). A press made while an
   * import is already in flight is skipped by the single-flight guard above and — because the
   * failing flight's release is scoped to its OWN stamp — nothing else will ever pick it up.
   * This is how the flight hands off to it on the way out.
   */
  const latestReimport = new Map<string, number | undefined>();

  /** One import at a time per guild, chaining straight into a press that arrived meanwhile. */
  function runReimport(guildId: string, stamp: number): void {
    const honour = reimport;
    if (!honour) return;
    reimporting.add(guildId);
    void honour(guildId, stamp)
      .catch((error: unknown) => {
        // The handler names and releases every refusal it can (#250) and swallows the rest, so
        // reaching here means something truly unforeseen — logged, and the chain below still
        // runs so a queued retry is not lost with it.
        console.error('[draftorder] in-Activity re-import failed:', error);
      })
      .finally(() => {
        reimporting.delete(guildId);
        const queued = latestReimport.get(guildId);
        if (queued !== undefined && queued !== stamp) runReimport(guildId, queued);
      });
  }
  /** Guilds whose begin is already running — a broadcast storm must not seal a bag twice (#233). */
  const beginning = new Set<string>();
  /** Guilds whose setup is already running — one press, one ESPN import (#253). */
  const settingUp = new Set<string>();

  const key = (guildId: string | undefined): string => guildId ?? '';
  /** Lines currently being delivered, so a duplicate frame can't double-post while one is in flight. */
  const inFlight = new Set<string>();

  function announce(seen: AnnouncedBalls, detail: StageAdjustmentDetail): void {
    // Already told the channel this team sits at this count — a duplicate broadcast or a
    // reconnect replay, not news.
    if (seen.get(detail.teamId) === detail.to) return;
    // `|` separator, not NUL: team ids are ESPN integers or `team-N`, so there is no
    // collision risk, and a NUL made this whole file read as binary to grep/diff tools.
    const flight = `${key(detail.guildId)}|${detail.teamId}|${detail.to}`;
    if (inFlight.has(flight)) return;
    inFlight.add(flight);
    // Recorded as announced only once Discord has actually taken it. Marking it up front would
    // make a transient send failure permanent: the reconcile below would then treat the line as
    // delivered and never retry it, silently losing the very record this feature exists to keep.
    void post(detail.guildId, adjustmentLine(detail))
      .then((delivered) => {
        if (delivered) seen.set(detail.teamId, detail.to);
      })
      .catch((error: unknown) => {
        console.error('[draftorder] failed to post an Activity edit to the channel:', error);
      })
      .finally(() => inFlight.delete(flight));
  }

  /**
   * One line for a bulk level-all (#252), same record-only-on-delivery discipline as `announce`.
   * Marking every covered team at the new count is what keeps the per-team loop (and every later
   * reconnect snapshot) silent about the same act. Routed by the FRAME's guild — the reconcile
   * already knows whose lobby this is, and a detail without (or with a mismatched) guildId must
   * not be able to misroute the line. Every covered team's per-team flight key is reserved for
   * the delivery window, so a frame that lands mid-flight without the `adjustedAll` detail can't
   * spray the same act as twelve individual lines.
   */
  function announceBulk(
    seen: AnnouncedBalls,
    detail: StageAdjustAllDetail,
    teams: string[],
    guildId: string | undefined,
  ): void {
    // A duplicate frame or a reconnect replay of an already-posted level-all is not news.
    if (teams.length === 0 || teams.every((teamId) => seen.get(teamId) === detail.balls)) return;
    const flights = teams.map((teamId) => `${key(guildId)}|${teamId}|${detail.balls}`);
    if (flights.some((flight) => inFlight.has(flight))) return;
    for (const flight of flights) inFlight.add(flight);
    void post(guildId, adjustAllLine(detail))
      .then((delivered) => {
        if (delivered) for (const teamId of teams) seen.set(teamId, detail.balls);
      })
      .catch((error: unknown) => {
        console.error('[draftorder] failed to post an Activity level-all to the channel:', error);
      })
      .finally(() => {
        for (const flight of flights) inFlight.delete(flight);
      });
  }

  /**
   * Bring the channel level with the stage's pending-edit set for one lobby.
   *
   * Dedupe is deliberately **state-based**: what has been announced is compared against the
   * adjustments the stage currently holds, not against the events this process happened to
   * witness. That is what makes a reconnect silent when nothing changed, a mini-game re-arm
   * (`keepAdjustments: true`) silent even though it republishes the whole lobby, and a fresh
   * `setup` — which drops every pending edit — reset cleanly. Pruning teams that are no longer
   * pending is what performs that reset.
   */
  function announceName(seen: AnnouncedNames, detail: StageRenameDetail): void {
    const flight = `name|${key(detail.guildId)}|${detail.teamId}|${detail.to}`;
    if (inFlight.has(flight)) return;
    inFlight.add(flight);
    void post(detail.guildId, renameLine(detail))
      .then((delivered) => {
        if (delivered) seen.set(detail.teamId, detail.to);
      })
      .catch((error: unknown) => {
        console.error('[draftorder] failed to post an Activity rename to the channel:', error);
      })
      .finally(() => inFlight.delete(flight));
  }

  function reconcile(
    guildId: string | undefined,
    rows: unknown,
    pending: { teamId: string; balls: number }[],
    pendingNames: { teamId: string; displayName: string }[],
    reimportStamp: number | undefined,
    beginRequest?: StageBeginRequest,
    detail?: StageAdjustmentDetail,
    renamed?: StageRenameDetail,
    bulk?: StageAdjustAllDetail,
    auditMode?: 'live' | 'seal-only',
  ): void {
    const seen = announced.get(key(guildId)) ?? new Map<string, number>();
    announced.set(key(guildId), seen);
    const stillPending = new Set(pending.map((entry) => entry.teamId));
    for (const teamId of [...seen.keys()]) {
      if (!stillPending.has(teamId)) seen.delete(teamId);
    }

    const nameById = new Map<string, string>();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row && typeof row === 'object') {
          const r = row as { teamId?: unknown; team?: unknown };
          if (typeof r.teamId === 'string' && typeof r.team === 'string') {
            nameById.set(r.teamId, r.team);
          }
        }
      }
    }

    // Seal-only audit mode (#252): the commissioner opted out of play-by-play — `begin`'s
    // adjusted odds card is the single finalized record. Silence is a choice, not a deferral:
    // everything pending is marked as seen NOW, so flipping back to 'live' later announces only
    // edits made after the flip, never a replay of what was deliberately kept quiet. The
    // re-import and begin triggers further down are unaffected: those are actions, not chatter.
    const quiet = auditMode === 'seal-only';
    if (quiet) {
      for (const entry of pending) seen.set(entry.teamId, entry.balls);
    }

    // A bulk level-all (#252) speaks once for every team it covered; the per-team loop below
    // skips those so the same act never also produces twelve individual lines.
    if (bulk && !quiet) {
      announceBulk(
        seen,
        bulk,
        pending.filter((entry) => entry.balls === bulk.balls).map((entry) => entry.teamId),
        guildId,
      );
    }

    for (const entry of pending) {
      if (quiet) break;
      if (bulk && entry.balls === bulk.balls) continue;
      const live = detail?.teamId === entry.teamId && detail.to === entry.balls;
      announce(seen, {
        teamId: entry.teamId,
        team: live ? detail.team : (nameById.get(entry.teamId) ?? entry.teamId),
        // `from` only exists on the live edit that produced this broadcast. A catch-up read off
        // stage state says where a team landed without inventing where it started.
        ...(live && detail.from !== undefined ? { from: detail.from } : {}),
        to: entry.balls,
        ...(guildId ? { guildId } : {}),
      });
    }

    // Renames carry their own pending set and their own announced map, so a ball edit and a name
    // fix to the same team never suppress each other.
    const seenNames = announcedNames.get(key(guildId)) ?? new Map<string, string>();
    announcedNames.set(key(guildId), seenNames);
    const stillNamed = new Set(pendingNames.map((entry) => entry.teamId));
    for (const teamId of [...seenNames.keys()]) {
      if (!stillNamed.has(teamId)) seenNames.delete(teamId);
    }
    if (quiet) {
      for (const entry of pendingNames) seenNames.set(entry.teamId, entry.displayName);
    }
    for (const entry of pendingNames) {
      if (quiet) break;
      if (seenNames.get(entry.teamId) === entry.displayName) continue;
      const live = renamed?.teamId === entry.teamId && renamed.to === entry.displayName;
      announceName(seenNames, {
        teamId: entry.teamId,
        ...(live && renamed.from !== undefined ? { from: renamed.from } : {}),
        to: entry.displayName,
        ...(guildId ? { guildId } : {}),
      });
    }

    // The mutating paths. Re-import (#219) first: the api cannot reach ESPN, so a refetch request
    // is ours to honour. Guarded so a broadcast storm or a reconnect snapshot cannot launch it
    // twice; the re-arm that follows a successful import clears the flag at the source.
    if (guildId) latestReimport.set(guildId, reimportStamp);
    if (reimportStamp !== undefined && reimport && guildId && !reimporting.has(guildId)) {
      runReimport(guildId, reimportStamp);
    }

    // Begin (#233): same single-flight discipline. The re-import check is now a belt — since
    // #250 the stage refuses a seal outright while a refetch is pending, so the two flags
    // cannot both be set by a current api — but an older api (or a frame in flight across a
    // restart) can still present both, and sealing then would commit a bag about to be replaced
    // by one the league hasn't seen re-confirmed.
    // On the bot side `runCeremony` flips the session out of GAME_OPEN synchronously, so a frame
    // that arrives after this flight resolves gets a clean refusal rather than a second draw.
    if (
      beginRequest &&
      begin &&
      guildId &&
      reimportStamp === undefined &&
      !beginning.has(guildId)
    ) {
      beginning.add(guildId);
      void begin(guildId, beginRequest)
        .catch((error: unknown) => {
          console.error('[draftorder] in-Activity begin failed:', error);
        })
        .finally(() => beginning.delete(guildId));
    }
  }

  function handleMessage(raw: unknown): void {
    let event: {
      type?: unknown;
      adjusted?: unknown;
      adjustedAll?: unknown;
      adjustments?: unknown;
      auditMode?: unknown;
      renamed?: unknown;
      renames?: unknown;
      reimportRequested?: unknown;
      reimportRequestedAt?: unknown;
      beginRequested?: unknown;
      lobby?: unknown;
      snapshot?: unknown;
    };
    try {
      event = JSON.parse(String(raw)) as typeof event;
    } catch {
      return; // a malformed frame is not worth a channel post
    }
    if (event.type === 'lottery-state') {
      const snapshot = (event.snapshot ?? {}) as {
        phase?: unknown;
        lobby?: { guildId?: unknown; rows?: unknown };
        adjustments?: unknown;
        renames?: unknown;
        reimportRequested?: unknown;
        reimportRequestedAt?: unknown;
        beginRequested?: unknown;
        auditMode?: unknown;
        setupRequested?: unknown;
      };
      if (snapshot.phase !== 'lobby') {
        // A dead-idle stage can still carry the one thing pressable there: the setup doorbell
        // (#253). Same single-flight discipline as re-import/begin; the callback releases the
        // request itself when it must refuse, so a false here needs no watcher-side action.
        const setupRequest =
          snapshot.phase === 'idle' ? toSetupRequest(snapshot.setupRequested) : undefined;
        if (setupRequest && setup && !settingUp.has(setupRequest.guildId)) {
          settingUp.add(setupRequest.guildId);
          void setup(setupRequest)
            .catch((error: unknown) => {
              console.error('[draftorder] in-Activity setup failed:', error);
            })
            .finally(() => settingUp.delete(setupRequest.guildId));
        }
        // Nothing armed ⇒ nothing editable, and any prior lobby is behind us.
        announced.clear();
        announcedNames.clear();
        return;
      }
      reconcile(
        typeof snapshot.lobby?.guildId === 'string' ? snapshot.lobby.guildId : undefined,
        snapshot.lobby?.rows,
        toAdjustments(snapshot.adjustments),
        toRenames(snapshot.renames),
        toReimportStamp(snapshot.reimportRequested, snapshot.reimportRequestedAt),
        toBeginRequest(snapshot.beginRequested),
        undefined,
        undefined,
        undefined,
        snapshot.auditMode === 'seal-only' ? 'seal-only' : undefined,
      );
      return;
    }
    if (event.type !== 'lottery-lobby') {
      // start/beat/reveal/finish/abort all mean the lobby is behind us — the next lobby should be
      // able to re-announce the same counts.
      if (typeof event.type === 'string' && event.type.startsWith('lottery-')) {
        announced.clear();
        announcedNames.clear();
      }
      return;
    }
    const lobby = (event.lobby ?? {}) as { guildId?: unknown; rows?: unknown };
    reconcile(
      typeof lobby.guildId === 'string' ? lobby.guildId : undefined,
      lobby.rows,
      toAdjustments(event.adjustments),
      toRenames(event.renames),
      toReimportStamp(event.reimportRequested, event.reimportRequestedAt),
      toBeginRequest(event.beginRequested),
      toDetail(event.adjusted),
      toRenameDetail(event.renamed),
      toBulkDetail(event.adjustedAll),
      event.auditMode === 'seal-only' ? 'seal-only' : undefined,
    );
  }

  function connect(): void {
    if (!running || socket) return;
    let opened: StageSocket;
    try {
      opened = socketFactory(stageWsUrl(baseUrl));
    } catch (error) {
      console.error('[draftorder] could not open the Activity stage socket:', error);
      scheduleReconnect();
      return;
    }
    socket = opened;
    // Every listener checks it still belongs to the *current* socket. A `stop()` then `start()`
    // leaves the old socket alive long enough to deliver its own `close`, which would otherwise
    // null out the new socket and schedule a reconnect on top of it — two live sockets, two
    // connect-time snapshots, duplicate audit lines.
    const isCurrent = (): boolean => socket === opened;
    opened.addEventListener('open', () => {
      if (!isCurrent()) return;
      // Say so only when this is a RECOVERY (#250): a healthy boot connect is not news, but
      // "the watcher is back" is exactly what the operator needs after a silent gap — while it
      // was down, every in-Activity press (re-import, begin, setup) went unheard.
      if (attempts > 0) {
        console.log(
          `[draftorder] stage watcher reconnected after ${attempts} attempt(s) — in-Activity presses are being heard again`,
        );
      }
      attempts = 0;
    });
    opened.addEventListener('message', (event: { data: unknown }) => {
      if (isCurrent()) handleMessage(event.data);
    });
    opened.addEventListener('error', () => {
      // `close` always follows, and that is where the reconnect is scheduled — doing it here too
      // would race two reconnects onto one drop.
    });
    opened.addEventListener('close', () => {
      if (!isCurrent()) return;
      socket = null;
      scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (!running || reconnectHandle !== null) return;
    // The stage is idle for most of the year, so back off hard rather than hammering a host that
    // may simply not be running.
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
    attempts += 1;
    // The gap this leaves is invisible from Discord AND from the Activity — a commissioner's
    // re-import press just sits there (#250, the live incident). One line per gap, naming the
    // next retry, is what turns "nothing happened" into a two-second diagnosis in the terminal.
    // Worded for both callers: a socket that closed and a socket that never opened leave the
    // watcher equally deaf, and the create-failure path logs its own error just above.
    console.warn(
      `[draftorder] stage watcher offline (attempt ${attempts}) — in-Activity presses will not be heard; retrying in ${Math.round(delay / 1000)}s`,
    );
    reconnectHandle = schedule(() => {
      reconnectHandle = null;
      connect();
    }, delay);
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempts = 0;
      connect();
    },
    stop() {
      running = false;
      if (reconnectHandle !== null) {
        cancel(reconnectHandle);
        reconnectHandle = null;
      }
      const open = socket;
      socket = null;
      announced.clear();
      announcedNames.clear();
      // Otherwise a guild whose import was in flight at stop() stays blocked after the next start.
      reimporting.clear();
      latestReimport.clear();
      beginning.clear();
      settingUp.clear();
      if (open) {
        try {
          open.close();
        } catch {
          /* already closing */
        }
      }
    },
  };
}

/**
 * The pending refetch press as a stamp (#250), or undefined when nothing is pending. An api
 * from before the stamp existed still says `reimportRequested: true` with no `…At`; `0` keeps
 * that pending (its release route does not exist either, so nothing is lost by not matching).
 */
function toReimportStamp(requested: unknown, at: unknown): number | undefined {
  if (requested !== true) return undefined;
  return typeof at === 'number' && Number.isFinite(at) ? at : 0;
}

/** Guard the `adjusted` detail off an untrusted frame. */
function toDetail(raw: unknown): StageAdjustmentDetail | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  if (typeof d.teamId !== 'string' || !d.teamId) return undefined;
  if (typeof d.team !== 'string' || !d.team) return undefined;
  if (typeof d.from !== 'number' || typeof d.to !== 'number') return undefined;
  return {
    teamId: d.teamId,
    team: d.team,
    from: d.from,
    to: d.to,
    ...(typeof d.guildId === 'string' ? { guildId: d.guildId } : {}),
  };
}

/**
 * Guard the begin request off an untrusted frame (#233). Bot-side vocabulary check on purpose,
 * even though the api's parser already enforced it — a frame is not something this process
 * authored, and the delay it carries becomes a real `setTimeout` pacing a real ceremony.
 */
function toBeginRequest(raw: unknown): StageBeginRequest | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  if (typeof d.delaySeconds !== 'number' || !Number.isInteger(d.delaySeconds)) return undefined;
  if (d.delaySeconds < 5 || d.delaySeconds > 60) return undefined;
  if (d.direction !== 'worst-to-first' && d.direction !== 'first-to-last') return undefined;
  // Same closed-vocabulary rule as the rest of the frame (#235): absent means an older api and
  // defaults machine downstream, but present-and-junk voids the whole request.
  if (d.visual !== undefined && d.visual !== 'machine' && d.visual !== 'race') return undefined;
  if (d.ballFaces !== undefined && d.ballFaces !== 'numbers' && d.ballFaces !== 'logos') {
    return undefined;
  }
  return {
    delaySeconds: d.delaySeconds,
    direction: d.direction,
    ...(d.visual === 'machine' || d.visual === 'race' ? { visual: d.visual } : {}),
    ...(d.ballFaces === 'numbers' || d.ballFaces === 'logos' ? { ballFaces: d.ballFaces } : {}),
    ...(typeof d.requestedBy === 'string' ? { requestedBy: d.requestedBy } : {}),
  };
}

/** Guard the setup doorbell off an untrusted frame (#253) — every field re-validated bot-side. */
function toSetupRequest(raw: unknown): StageSetupRequest | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  if (typeof d.guildId !== 'string' || !d.guildId) return undefined;
  if (typeof d.requestedBy !== 'string' || !d.requestedBy) return undefined;
  if (
    typeof d.season !== 'number' ||
    !Number.isInteger(d.season) ||
    d.season < 2020 ||
    d.season > 2100
  ) {
    return undefined;
  }
  return { guildId: d.guildId, requestedBy: d.requestedBy, season: d.season };
}

/** Guard the `adjustedAll` detail off an untrusted frame (#252). */
function toBulkDetail(raw: unknown): StageAdjustAllDetail | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  if (typeof d.balls !== 'number' || !Number.isInteger(d.balls) || d.balls < 1) return undefined;
  return {
    balls: d.balls,
    ...(typeof d.guildId === 'string' ? { guildId: d.guildId } : {}),
  };
}

/** Guard the `renamed` detail off an untrusted frame. */
function toRenameDetail(raw: unknown): StageRenameDetail | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  if (typeof d.teamId !== 'string' || !d.teamId) return undefined;
  if (typeof d.to !== 'string' || !d.to) return undefined;
  return {
    teamId: d.teamId,
    ...(typeof d.from === 'string' ? { from: d.from } : {}),
    to: d.to,
    ...(typeof d.guildId === 'string' ? { guildId: d.guildId } : {}),
  };
}

/** Guard a snapshot's pending-rename list off an untrusted frame. */
function toRenames(raw: unknown): { teamId: string; displayName: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    return typeof e.teamId === 'string' && typeof e.displayName === 'string' && e.displayName
      ? [{ teamId: e.teamId, displayName: e.displayName }]
      : [];
  });
}

/** Guard a snapshot's pending-adjustment list off an untrusted frame. */
function toAdjustments(raw: unknown): { teamId: string; balls: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    return typeof e.teamId === 'string' && typeof e.balls === 'number'
      ? [{ teamId: e.teamId, balls: e.balls }]
      : [];
  });
}
