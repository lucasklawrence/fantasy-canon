/**
 * The draft-order race (#235): team-colored racers — the same numbered-ball faces the machine
 * tumbles — jockeying down per-team lanes on a canvas, replacing the hopper+chute panel when
 * `LotteryStart.visual` is `'race'`.
 *
 * Strictly cosmetic, same contract as `hopperSim.ts`: the sim never decides anything. Racers
 * jostle on unconstrained randomness where nothing can be read out of it (motion params), and
 * every consequential position is imposed by a published reveal: `lock()` fixes a racer at the
 * back of the field or across the finish line per `raceLanes.lockKind`. The drum-roll between
 * reveals is `agitate()` — the pack visibly bunches and breaks harder while the roll plays.
 *
 * Same performance discipline as the machine: ball faces are pre-rendered sprites (`ballSprite`),
 * the frame loop is drawImage + line strokes only, it parks itself once every racer is parked,
 * and reduced motion renders a single still frame per state change instead of a loop.
 *
 * The track is elastic (#239): the page hands race mode the monitor's spare width, and the lanes
 * scale with it (`laneMetrics`) — taller lanes, bigger balls, and a label gutter that grows to
 * fit whole team names instead of ellipsizing everything into a fixed 64px strip.
 */

import { buildBallSprite } from './ballSprite.js';
import {
  assignLanes,
  CROSS_PARK_X,
  fallPosition,
  FINISH_X,
  laneMetrics,
  lockKind,
  paceBand,
  paceFor,
  packFloor,
  type PaceBand,
} from './raceLanes.js';

export interface RaceSim {
  /**
   * Idempotent: make the field match this bag with these picks already locked. Poll repaints call
   * it every couple of seconds — an unchanged field is a no-op, a changed bag (or a lock set that
   * *shrank*: a replay restarting from pick one) rebuilds, and newly-locked picks park instantly
   * (the animated version happens in {@link RaceSim.lock}, which the reveal path calls first).
   */
  sync(rows: { team: string; balls: number }[], locks: { pick: number; team: string }[]): void;
  /**
   * Rebuild every racer's face in place (#242) — for a logo that finished decoding after the
   * field was built. `sync` deliberately no-ops on an unchanged bag, so it can't pick these up.
   */
  reface(): void;
  /** Drum-roll surge on/off — the race's equivalent of the machine's boil. */
  agitate(on: boolean): void;
  /**
   * A reveal landed: fix this racer's finish. Falls off the pace to the back of the field, or
   * crosses the line, per {@link lockKind}; the parked ball face shows the pick number. Bounded
   * and fire-and-forget — the reveal card never waits on it.
   */
  lock(pick: number, team: string): void;
  /** Hidden-tab pause — the sim neither steps nor draws while off. */
  setRunning(on: boolean): void;
  destroy(): void;
}

/** Top/bottom padding around the lanes. */
const PAD = 6;
/** Right padding past the winners' parking spot. */
const RIGHT_PAD = 6;
/** The gutter never shrinks below the original fixed strip, so tiny canvases stay sane. */
const MIN_GUTTER = 64;
/** How long a winner's sprint through the line runs. */
const CROSS_MS = 900;
/**
 * A drawn team goes to the BACK before it goes to the standings (live feedback).
 *
 * The complaint was "someone at the front is chosen and goes to back" — a leader teleporting
 * backwards reads as a glitch. So an elimination is two moves: the field overtakes them
 * (`SLIP_MS`), and only then do they drop off the rear into their slot (`DROP_MS`). The motion
 * tells the story in the order it happened. Their sum stays inside the old 900ms lock, so the
 * race's envelope lead still covers a finale.
 */
const SLIP_MS = 520;
const DROP_MS = 380;
/** Drum-roll surge multiplier eased in/out, so the pack doesn't snap between intensities. */
const SURGE = 1.8;
/** How fast a racer closes on a changed pace — a leader leaving promotes the whole field. */
const PACE_EASE = 0.045;

interface Racer {
  team: string;
  hue: number;
  lane: number;
  label: string;
  /** Current position as a fraction of the drawable track. */
  frac: number;
  /** This team's stack, and the place on the track it earns. */
  balls: number;
  /** Eased toward {@link Racer.paceTarget} so a promotion is a surge, not a jump. */
  pace: number;
  paceTarget: number;
  /** Cosmetic motion parameters — jockeying around the pace, bounded by WANDER_MAX. */
  amp1: number;
  w1: number;
  p1: number;
  amp2: number;
  w2: number;
  p2: number;
  sprite: HTMLCanvasElement;
  locked?: { pick: number; kind: 'cross' | 'fall' };
  /** `then` chains the drop behind the slip; see SLIP_MS. */
  anim?: {
    from: number;
    to: number;
    startedAt: number;
    ms: number;
    then?: { to: number; ms: number };
  };
}

/**
 * `getLogo` (#242): resolve a team's already-decoded logo image, or null for the plain hue ball.
 * A lookup instead of data on the rows because images load asynchronously — the sim rebuilds
 * sprites on sync/lock and simply picks up whatever has finished decoding by then.
 */
export function createRaceSim(
  canvas: HTMLCanvasElement,
  getLogo: (team: string) => CanvasImageSource | null = () => null,
): RaceSim {
  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ctx = canvas.getContext('2d');

  let racers: Racer[] = [];
  let bagSig = '';
  let cssW = 300;
  let cssH = 0;
  /** Width-scaled lane geometry (#239) — refreshed by {@link ensureSize}. */
  let laneH = 26;
  let ballR = 9;
  let labelFont = 10;
  let gutter = MIN_GUTTER;
  let agitating = false;
  let intensity = 1;
  /** The room the field currently has, re-derived by {@link repace} whenever a racer parks. */
  let band: PaceBand = paceBand(packFloor([], 0));
  let running = true;
  let rafId: number | null = null;
  let destroyed = false;

  /** Track x in CSS pixels for a fraction of the drawable width. */
  function fx(frac: number): number {
    return gutter + frac * (cssW - gutter - RIGHT_PAD);
  }

  /** Ellipsize a team name into the current label gutter. */
  function fitLabel(name: string): string {
    if (!ctx) return name;
    ctx.font = `600 ${labelFont}px system-ui, sans-serif`;
    if (ctx.measureText(name).width <= gutter - 10) return name;
    let text = name;
    while (text.length > 1 && ctx.measureText(`${text}…`).width > gutter - 10) {
      text = text.slice(0, -1);
    }
    return `${text}…`;
  }

  /** The racer's current face: pick number once locked, team logo or plain color while running. */
  function spriteFor(racer: Racer): HTMLCanvasElement {
    return buildBallSprite(
      racer.locked ? String(racer.locked.pick) : null,
      racer.hue,
      ballR,
      dpr,
      getLogo(racer.team),
    );
  }

  /**
   * Fit the canvas to its container and field size. The racetrack is `width:100%` (unlike the
   * fixed hopper circle), and `sync` can run while the stage is still hidden — measure lazily and
   * again per frame so the first visible paint is at the real size. Width drives the lane metrics
   * (#239), and the gutter grows to the longest team name (within `gutterCap`) so a wide monitor
   * shows whole names. `force` refreshes gutter/labels for a rebuilt field even at the same size.
   */
  function ensureSize(force = false): void {
    const w = canvas.clientWidth || cssW || 300;
    const m = laneMetrics(w);
    const h = racers.length * m.laneH + PAD * 2;
    if (!force && w === cssW && h === cssH && canvas.width === Math.ceil(w * dpr)) return;
    const resprite = m.ballR !== ballR;
    cssW = w;
    cssH = h;
    laneH = m.laneH;
    ballR = m.ballR;
    labelFont = m.labelFont;
    canvas.width = Math.ceil(w * dpr);
    canvas.height = Math.ceil(h * dpr);
    canvas.style.height = `${h}px`;
    if (ctx) {
      ctx.font = `600 ${labelFont}px system-ui, sans-serif`;
      let widest = 0;
      for (const racer of racers) {
        widest = Math.max(widest, ctx.measureText(racer.team).width);
      }
      gutter = Math.min(m.gutterCap, Math.max(MIN_GUTTER, Math.ceil(widest) + 14));
    }
    for (const racer of racers) {
      racer.label = fitLabel(racer.team);
      if (resprite) racer.sprite = spriteFor(racer);
    }
  }

  function lockedPicks(): number[] {
    return racers.filter((r) => r.locked).map((r) => (r.locked as { pick: number }).pick);
  }

  function draw(): void {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    // Lane separators + labels, under the racers.
    ctx.font = `600 ${labelFont}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const racer of racers) {
      const laneY = PAD + racer.lane * laneH;
      if (racer.lane > 0) {
        ctx.strokeStyle = 'rgba(43, 53, 80, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, laneY);
        ctx.lineTo(cssW, laneY);
        ctx.stroke();
      }
      ctx.fillStyle = `hsl(${racer.hue} 45% 70% / ${racer.locked ? 0.9 : 0.6})`;
      ctx.fillText(racer.label, 4, laneY + laneH / 2);
    }
    // The finish line.
    ctx.strokeStyle = 'rgba(245, 214, 123, 0.4)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(fx(FINISH_X), 0);
    ctx.lineTo(fx(FINISH_X), cssH);
    ctx.stroke();
    ctx.setLineDash([]);
    // Racers on top. A tiny motion streak behind un-locked racers sells the sprint without any
    // per-frame gradient cost.
    for (const racer of racers) {
      const px = fx(racer.frac);
      const py = PAD + racer.lane * laneH + laneH / 2;
      if (!racer.locked || racer.anim) {
        ctx.strokeStyle = `hsl(${racer.hue} 55% 60% / 0.28)`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(px - ballR - 14, py);
        ctx.lineTo(px - ballR + 2, py);
        ctx.stroke();
      }
      const r = racer.sprite.width / dpr / 2;
      ctx.drawImage(racer.sprite, px - r, py - r, r * 2, r * 2);
    }
  }

  /** Nothing left to animate: every racer parked, no lock flight, surge fully eased. */
  function idle(): boolean {
    if (racers.length === 0) return true;
    if (Math.abs(intensity - (agitating ? SURGE : 1)) > 0.02) return false;
    return racers.every((r) => r.locked && !r.anim);
  }

  function frame(now: number): void {
    rafId = null;
    if (destroyed || !running) return;
    ensureSize();
    const t = now / 1000;
    intensity += ((agitating ? SURGE : 1) - intensity) * 0.06;
    for (const racer of racers) {
      if (racer.anim) {
        const t01 = Math.min(1, (now - racer.anim.startedAt) / racer.anim.ms);
        // Ease-out: a winner sprints through the line, a straggler decelerates to a stop.
        const ease = 1 - (1 - t01) * (1 - t01) * (1 - t01);
        racer.frac = racer.anim.from + (racer.anim.to - racer.anim.from) * ease;
        if (t01 >= 1) {
          const next = racer.anim.then;
          // The drop off the rear, chained behind the slip so the field is seen to overtake first.
          racer.anim = next
            ? { from: racer.frac, to: next.to, startedAt: now, ms: next.ms }
            : undefined;
        }
      } else if (!racer.locked) {
        // Close on the pace this stack earns. Eased rather than snapped: when the leader is drawn
        // out, every remaining stack is suddenly worth more, and the field should surge forward
        // rather than teleport.
        racer.pace += (racer.paceTarget - racer.pace) * PACE_EASE;
        // The jockeying: two superimposed sine drifts around that pace. The amplitudes are unit
        // fractions summing to 1, so `swing` is in [-1, 1] and the whole thing scales with the
        // band's own wander allowance — a wide, loose swing over an empty track early, tightening
        // as the standings fill and the field's room shrinks. `intensity / SURGE` puts the resting
        // drift at ~56% of the allowance and the drum roll at 100%, so the surge visibly bites.
        const swing =
          racer.amp1 * Math.sin(racer.w1 * t + racer.p1) +
          racer.amp2 * Math.sin(racer.w2 * t + racer.p2);
        const drift = swing * band.wander * (intensity / SURGE);
        // The clamps are backstops; the band is already inset so neither should be reached.
        racer.frac = Math.min(
          FINISH_X - 0.02,
          Math.max(band.min - band.wander, racer.pace + drift),
        );
      }
    }
    draw();
    if (!idle()) rafId = requestAnimationFrame(frame);
  }

  function wake(): void {
    if (destroyed || !running || reducedMotion || rafId !== null) return;
    rafId = requestAnimationFrame(frame);
  }

  /**
   * Reduced motion: no loop, one still frame — but the same picture everyone else is reading.
   *
   * This used to spread the field by LANE INDEX, which was harmless when position meant nothing
   * and is a lie now that it means odds: it would show a reduced-motion viewer a field ordered by
   * odds-table row. They get the pace, with the jockeying simply absent.
   */
  function stillFrame(): void {
    ensureSize();
    repace();
    for (const racer of racers) {
      if (racer.locked) continue;
      racer.pace = racer.paceTarget; // no loop to ease it, so land on the answer directly
      racer.frac = racer.pace;
    }
    draw();
  }

  function repaint(): void {
    if (reducedMotion) stillFrame();
    else wake();
  }

  /** Park a racer at its locked position with the pick number on its face. No animation. */
  function parkInstant(racer: Racer, pick: number, kind: 'cross' | 'fall'): void {
    racer.locked = { pick, kind };
    racer.anim = undefined;
    racer.frac = kind === 'cross' ? CROSS_PARK_X : fallPosition(pick, racers.length);
    racer.sprite = spriteFor(racer);
    repace();
  }

  function applyLock(pick: number, team: string, animate: boolean): void {
    const racer = racers.find((r) => r.team === team);
    if (!racer || racer.locked) return; // late joiner already parked it, or a dup event
    const kind = lockKind(pick, lockedPicks(), racers.length);
    if (!animate || reducedMotion || !running) {
      parkInstant(racer, pick, kind);
      repaint();
      return;
    }
    racer.locked = { pick, kind };
    racer.sprite = spriteFor(racer);
    const startedAt = performance.now();
    if (kind === 'cross') {
      racer.anim = { from: racer.frac, to: CROSS_PARK_X, startedAt, ms: CROSS_MS };
    } else {
      // Overtaken first, then dropped. Slipping to the rear of the current band puts them behind
      // every racer still running, whichever end of the field they were at when their name came up.
      racer.anim = {
        from: racer.frac,
        to: band.min - band.wander,
        startedAt,
        ms: SLIP_MS,
        then: { to: fallPosition(pick, racers.length), ms: DROP_MS },
      };
    }
    // One fewer stack in the bag: everyone left is worth more, and eases forward to show it.
    repace();
    wake();
  }

  /**
   * Re-derive every still-racing team's pace from the stacks still in the bag.
   *
   * Called after any change to who is running, because the scale is the REMAINING leader — drawing
   * the front-runner promotes the whole field, which is the visual answer to "why did my position
   * change when it wasn't my pick".
   */
  function repace(): void {
    // How much track is left to race on, given how far the standings have filled. Early it is
    // almost all of it — nothing is parked yet, so nothing needs the space.
    band = paceBand(packFloor(lockedPicks(), racers.length));
    const stillRunning = racers.filter((racer) => !racer.locked);
    const leaderBalls = stillRunning.reduce((max, racer) => Math.max(max, racer.balls), 0);
    for (const racer of stillRunning) racer.paceTarget = paceFor(racer.balls, leaderBalls, band);
  }

  function buildField(rows: { team: string; balls: number }[]): void {
    const ballsByTeam = new Map(rows.map((row) => [row.team, row.balls]));
    const leaderBalls = rows.reduce((max, row) => Math.max(max, row.balls), 0);
    // A fresh field has nothing parked, so it gets the whole track.
    band = paceBand(packFloor([], rows.length));
    racers = assignLanes(rows).map((lane) => {
      const balls = ballsByTeam.get(lane.team) ?? 0;
      // Start ON the pace rather than scattered: the field's opening arrangement IS the odds, and
      // a viewer who joins before the first beat should already be able to read it.
      const pace = paceFor(balls, leaderBalls, band);
      return {
        team: lane.team,
        hue: lane.hue,
        lane: lane.lane,
        label: lane.team, // refit against the real gutter in ensureSize below
        balls,
        frac: pace,
        pace,
        paceTarget: pace,
        // Unit fractions summing to 1 — the frame loop scales them by the band's wander, so the
        // swing follows the room available instead of a fixed distance.
        amp1: 0.72,
        w1: 0.35 + Math.random() * 0.4,
        p1: Math.random() * Math.PI * 2,
        amp2: 0.28,
        w2: 1.2 + Math.random() * 1.1,
        p2: Math.random() * Math.PI * 2,
        sprite: buildBallSprite(null, lane.hue, ballR, dpr, getLogo(lane.team)),
      };
    });
    // Force: a same-size rebuild still has NEW names — the gutter and labels must refresh.
    ensureSize(true);
  }

  return {
    sync(rows, locks): void {
      const sig = rows.map((row) => row.team).join('|');
      const have = new Set(locks.map((l) => l.pick));
      // A pick locked here but absent from the new set means the field must UN-park — a replay
      // or catch-up restarting from pick one. That's a rebuild, same as a changed bag.
      const shrank = lockedPicks().some((pick) => !have.has(pick));
      if (sig !== bagSig || shrank) {
        bagSig = sig;
        buildField(rows);
      }
      for (const entry of locks) applyLock(entry.pick, entry.team, false);
      repaint();
    },
    reface(): void {
      for (const racer of racers) racer.sprite = spriteFor(racer);
      repaint();
    },
    agitate(on): void {
      if (agitating === on) return;
      agitating = on;
      // repaint, not wake: the first drum-roll is the first render after the track becomes
      // visible, and a reduced-motion viewer has no frame loop to re-measure it — the still
      // frame's ensureSize is what picks up the real width (Codex review, #239).
      if (on) repaint();
    },
    lock(pick, team): void {
      applyLock(pick, team, true);
    },
    setRunning(on): void {
      if (running === on) return;
      running = on;
      if (on) {
        wake();
        return;
      }
      // A paused loop can't finish a park animation — settle any flight now so the field is
      // correct the moment the tab returns, instead of racers frozen mid-fall.
      for (const racer of racers) {
        if (racer.locked && racer.anim) {
          racer.frac = racer.anim.to;
          racer.anim = undefined;
        }
      }
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
    destroy(): void {
      destroyed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      racers = [];
    },
  };
}
