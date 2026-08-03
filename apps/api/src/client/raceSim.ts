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
 */

import { buildBallSprite } from './ballSprite.js';
import {
  assignLanes,
  CROSS_PARK_X,
  fallPosition,
  FINISH_X,
  lockKind,
  PACK_MAX,
  PACK_MIN,
} from './raceLanes.js';

export interface RaceSim {
  /**
   * Idempotent: make the field match this bag with these picks already locked. Poll repaints call
   * it every couple of seconds — an unchanged field is a no-op, a changed bag (or a lock set that
   * *shrank*: a replay restarting from pick one) rebuilds, and newly-locked picks park instantly
   * (the animated version happens in {@link RaceSim.lock}, which the reveal path calls first).
   */
  sync(rows: { team: string; balls: number }[], locks: { pick: number; team: string }[]): void;
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

/** Lane height; the canvas grows with the field so 8 or 14 teams both read. */
const LANE_H = 26;
/** Top/bottom padding around the lanes. */
const PAD = 6;
/** Left gutter reserved for team labels; the track proper starts after it. */
const GUTTER = 64;
/** Right padding past the winners' parking spot. */
const RIGHT_PAD = 6;
/** Racer radius — big enough for a two-digit pick number (see NUMBER_MIN_RADIUS). */
const BALL_R = 9;
/** How long a lock's park animation runs. */
const LOCK_MS = 900;
/** Drum-roll surge multiplier eased in/out, so the pack doesn't snap between intensities. */
const SURGE = 1.8;

interface Racer {
  team: string;
  hue: number;
  lane: number;
  label: string;
  /** Current position as a fraction of the drawable track. */
  frac: number;
  /** Cosmetic motion parameters — unconstrained randomness, nothing readable in them. */
  mid: number;
  amp1: number;
  w1: number;
  p1: number;
  amp2: number;
  w2: number;
  p2: number;
  sprite: HTMLCanvasElement;
  locked?: { pick: number; kind: 'cross' | 'fall' };
  anim?: { from: number; to: number; startedAt: number };
}

export function createRaceSim(canvas: HTMLCanvasElement): RaceSim {
  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ctx = canvas.getContext('2d');

  let racers: Racer[] = [];
  let bagSig = '';
  let cssW = 300;
  let cssH = 0;
  let agitating = false;
  let intensity = 1;
  let running = true;
  let rafId: number | null = null;
  let destroyed = false;

  /** Track x in CSS pixels for a fraction of the drawable width. */
  function fx(frac: number): number {
    return GUTTER + frac * (cssW - GUTTER - RIGHT_PAD);
  }

  /**
   * Fit the canvas to its container and field size. The racetrack is `width:100%` (unlike the
   * fixed hopper circle), and `sync` can run while the stage is still hidden — measure lazily and
   * again per frame so the first visible paint is at the real size.
   */
  function ensureSize(): void {
    const w = canvas.clientWidth || cssW || 300;
    const h = racers.length * LANE_H + PAD * 2;
    if (w === cssW && h === cssH && canvas.width === Math.ceil(w * dpr)) return;
    cssW = w;
    cssH = h;
    canvas.width = Math.ceil(w * dpr);
    canvas.height = Math.ceil(h * dpr);
    canvas.style.height = `${h}px`;
  }

  /** Ellipsize a team name into the label gutter. */
  function fitLabel(name: string): string {
    if (!ctx) return name;
    ctx.font = '600 10px system-ui, sans-serif';
    if (ctx.measureText(name).width <= GUTTER - 10) return name;
    let text = name;
    while (text.length > 1 && ctx.measureText(`${text}…`).width > GUTTER - 10) {
      text = text.slice(0, -1);
    }
    return `${text}…`;
  }

  function lockedPicks(): number[] {
    return racers.filter((r) => r.locked).map((r) => (r.locked as { pick: number }).pick);
  }

  function draw(): void {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    // Lane separators + labels, under the racers.
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const racer of racers) {
      const laneY = PAD + racer.lane * LANE_H;
      if (racer.lane > 0) {
        ctx.strokeStyle = 'rgba(43, 53, 80, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, laneY);
        ctx.lineTo(cssW, laneY);
        ctx.stroke();
      }
      ctx.fillStyle = `hsl(${racer.hue} 45% 70% / ${racer.locked ? 0.9 : 0.6})`;
      ctx.fillText(racer.label, 4, laneY + LANE_H / 2);
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
      const py = PAD + racer.lane * LANE_H + LANE_H / 2;
      if (!racer.locked || racer.anim) {
        ctx.strokeStyle = `hsl(${racer.hue} 55% 60% / 0.28)`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(px - BALL_R - 14, py);
        ctx.lineTo(px - BALL_R + 2, py);
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
        const t01 = Math.min(1, (now - racer.anim.startedAt) / LOCK_MS);
        // Ease-out: a winner sprints through the line, a straggler decelerates to a stop.
        const ease = 1 - (1 - t01) * (1 - t01) * (1 - t01);
        racer.frac = racer.anim.from + (racer.anim.to - racer.anim.from) * ease;
        if (t01 >= 1) racer.anim = undefined;
      } else if (!racer.locked) {
        // The jockeying: two superimposed sine drifts per racer, scaled by the drum-roll surge.
        // Bounded inside the pack band so nobody crosses the line uninvited.
        const wander =
          racer.amp1 * Math.sin(racer.w1 * t + racer.p1) * intensity +
          racer.amp2 * Math.sin(racer.w2 * t + racer.p2) * intensity;
        racer.frac = Math.min(FINISH_X - 0.02, Math.max(PACK_MIN - 0.1, racer.mid + wander));
      }
    }
    draw();
    if (!idle()) rafId = requestAnimationFrame(frame);
  }

  function wake(): void {
    if (destroyed || !running || reducedMotion || rafId !== null) return;
    rafId = requestAnimationFrame(frame);
  }

  /** Reduced motion: no loop — spread the field deterministically and paint one still frame. */
  function stillFrame(): void {
    ensureSize();
    for (const racer of racers) {
      if (racer.locked) continue;
      racer.frac =
        PACK_MIN + ((racer.lane + 0.5) / Math.max(1, racers.length)) * (PACK_MAX - PACK_MIN);
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
    racer.sprite = buildBallSprite(String(pick), racer.hue, BALL_R, dpr);
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
    const to = kind === 'cross' ? CROSS_PARK_X : fallPosition(pick, racers.length);
    racer.locked = { pick, kind };
    racer.anim = { from: racer.frac, to, startedAt: performance.now() };
    racer.sprite = buildBallSprite(String(pick), racer.hue, BALL_R, dpr);
    wake();
  }

  function buildField(rows: { team: string; balls: number }[]): void {
    racers = assignLanes(rows).map((lane) => ({
      team: lane.team,
      hue: lane.hue,
      lane: lane.lane,
      label: fitLabel(lane.team),
      frac: PACK_MIN + Math.random() * (PACK_MAX - PACK_MIN),
      mid: (PACK_MIN + PACK_MAX) / 2 + (Math.random() - 0.5) * 0.12,
      amp1: 0.1 + Math.random() * 0.06,
      w1: 0.35 + Math.random() * 0.4,
      p1: Math.random() * Math.PI * 2,
      amp2: 0.03 + Math.random() * 0.03,
      w2: 1.2 + Math.random() * 1.1,
      p2: Math.random() * Math.PI * 2,
      sprite: buildBallSprite(null, lane.hue, BALL_R, dpr),
    }));
    ensureSize();
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
    agitate(on): void {
      if (agitating === on) return;
      agitating = on;
      if (on) wake();
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
