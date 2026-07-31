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

/** The subset of a `WebSocket` this module drives. Matches the Node 24 / browser global. */
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
  /** Injected for tests; defaults to the global `WebSocket` (Node >= 24). */
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

/**
 * Track which ball count we have already announced per team, so the same edit is never posted
 * twice. This matters on reconnect: the stage sends a full `lottery-state` snapshot on connect,
 * and its `adjustments` are the *cumulative* pending set — replaying them verbatim after every
 * blip would spam the channel with edits the league already saw.
 */
type AnnouncedBalls = Map<string, number>;

export function createStageWatcher(options: StageWatcherOptions): StageWatcher {
  const {
    baseUrl,
    post,
    // Node >= 24 ships a global `WebSocket`, which already satisfies `StageSocket` structurally.
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

  const key = (guildId: string | undefined): string => guildId ?? '';

  function announce(detail: StageAdjustmentDetail): void {
    const seen = announced.get(key(detail.guildId)) ?? new Map<string, number>();
    // Already told the channel this team sits at this count — a duplicate broadcast or a
    // reconnect replay, not news.
    if (seen.get(detail.teamId) === detail.to) return;
    seen.set(detail.teamId, detail.to);
    announced.set(key(detail.guildId), seen);
    void post(detail.guildId, adjustmentLine(detail)).catch((error: unknown) => {
      console.error('[draftorder] failed to post an Activity edit to the channel:', error);
    });
  }

  /**
   * Reconcile from a connect-time snapshot. Only edits we have not announced produce a line, so a
   * reconnect is silent unless something actually changed while we were away — and an edit made
   * during an outage still reaches the channel late rather than never.
   */
  function reconcile(snapshot: {
    phase?: unknown;
    lobby?: { guildId?: unknown; rows?: unknown };
    adjustments?: unknown;
  }): void {
    const guildId =
      typeof snapshot.lobby?.guildId === 'string' ? snapshot.lobby.guildId : undefined;
    if (snapshot.phase !== 'lobby') {
      // No armed lobby ⇒ nothing is editable and any prior lobby is gone. Drop the announced
      // state so the next lobby starts clean instead of suppressing its first edits.
      announced.clear();
      return;
    }
    const rows = Array.isArray(snapshot.lobby?.rows) ? snapshot.lobby.rows : [];
    const nameById = new Map<string, string>();
    for (const row of rows) {
      if (row && typeof row === 'object') {
        const r = row as { teamId?: unknown; team?: unknown };
        if (typeof r.teamId === 'string' && typeof r.team === 'string')
          nameById.set(r.teamId, r.team);
      }
    }
    for (const entry of toAdjustments(snapshot.adjustments)) {
      // No `from`: a snapshot only carries the current count, so a catch-up line says where the
      // team landed without inventing where it started.
      announce({
        teamId: entry.teamId,
        team: nameById.get(entry.teamId) ?? entry.teamId,
        to: entry.balls,
        ...(guildId ? { guildId } : {}),
      });
    }
  }

  function handleMessage(raw: unknown): void {
    let event: {
      type?: unknown;
      adjusted?: unknown;
      lobby?: unknown;
      snapshot?: unknown;
    };
    try {
      event = JSON.parse(String(raw)) as typeof event;
    } catch {
      return; // a malformed frame is not worth a channel post
    }
    if (event.type === 'lottery-state') {
      const snapshot = event.snapshot;
      if (snapshot && typeof snapshot === 'object') reconcile(snapshot);
      return;
    }
    if (event.type !== 'lottery-lobby') {
      // start/beat/reveal/finish/abort all mean the lobby is behind us — the next lobby should be
      // able to re-announce the same counts.
      if (typeof event.type === 'string' && event.type.startsWith('lottery-')) announced.clear();
      return;
    }
    const detail = toDetail(event.adjusted);
    if (!detail) {
      // A bot-driven re-arm, not a human edit. It republishes the bag wholesale, so what the
      // channel has already been told about is no longer meaningful.
      announced.clear();
      return;
    }
    announce(detail);
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
    opened.addEventListener('open', () => {
      attempts = 0;
    });
    opened.addEventListener('message', (event: { data: unknown }) => handleMessage(event.data));
    opened.addEventListener('error', () => {
      // `close` always follows, and that is where the reconnect is scheduled — doing it here too
      // would race two reconnects onto one drop.
    });
    opened.addEventListener('close', () => {
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
