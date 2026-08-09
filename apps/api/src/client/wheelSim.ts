/**
 * The wheel visual's renderer (#244) — the untested canvas half of the #211 split, beside the
 * tested policy in `wheelLayout`.
 *
 * No physics: unlike the hopper this is a pure animation, because the answer is already known.
 * The wheel free-spins through the drum roll and then eases onto the wedge the reveal named, at a
 * rotation `wheelLayout` derives from public data — so the spin is theatre over a result the
 * commitment already fixed, which is exactly what the other two visuals are (ADR 0006/0008).
 *
 * Parks its rAF loop whenever nothing is moving, like the hopper — an idle lobby costs no battery.
 */

import { buildWedges, landingRotation, type Wedge } from './wheelLayout.js';

export interface WheelSim {
  /** Idempotent: make the wheel match this bag minus these drawn teams. */
  sync(rows: { team: string; balls: number }[], drawnTeams: string[]): void;
  /** Drum-roll free spin on/off. */
  spin(on: boolean): void;
  /** The reveal: ease onto `team`'s wedge and stop there. */
  land(team: string, pick: number): void;
  /** Re-measure the canvas (the stage is hidden during the lobby, so this runs late). */
  ensureSize(): void;
  /** Hidden-tab pause. */
  setRunning(on: boolean): void;
  destroy(): void;
}

/** Free-spin speed during the drum roll, radians per second. */
const SPIN_SPEED = 4.2;
/** How long the landing ease takes. Long enough to read as deceleration, short enough to fit. */
const LAND_MS = 2200;

export function createWheelSim(canvas: HTMLCanvasElement, sizePx?: number): WheelSim {
  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ctx = canvas.getContext('2d');

  let cssSize = sizePx || canvas.clientWidth || 300;
  let wedges: Wedge[] = [];
  let bagSig = '';
  let drawnSig = '';
  let rotation = 0;
  let spinning = false;
  /** The in-flight landing ease, or null when the wheel is free-spinning or at rest. */
  let landing: { from: number; to: number; startedAt: number } | null = null;
  /**
   * A bag update that arrived mid-landing, held until the ease finishes.
   *
   * The reveal that starts a landing is the same event that drops the team from the odds table, so
   * the sync removing that team's wedge lands while the wheel is still travelling toward it.
   * Applying it immediately re-lays the wheel without the destination and strands the spin on
   * whatever happens to be under the pointer — the wheel would stop on the wrong team, every time.
   */
  let pendingSync: { rows: { team: string; balls: number }[]; drawnTeams: string[] } | null = null;
  let running = true;
  let destroyed = false;
  let rafId: number | null = null;
  let last = 0;

  function applySize(): void {
    canvas.width = Math.max(1, Math.round(cssSize * dpr));
    canvas.height = canvas.width;
  }
  applySize();

  function idle(): boolean {
    return !spinning && !landing;
  }

  /** Re-lay the wheel for a bag. Signature-guarded by the caller; this just does the work. */
  function applyBag(rows: { team: string; balls: number }[], drawnTeams: string[]): void {
    bagSig = rows.map((row) => `${row.team}:${row.balls}`).join(',');
    drawnSig = [...drawnTeams].sort().join(',');
    wedges = buildWedges(rows, drawnTeams);
    draw();
    wake();
  }

  function wake(): void {
    if (destroyed || !running || rafId !== null) return;
    last = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function frame(now: number): void {
    rafId = null;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (landing) {
      const t = Math.min(1, (now - landing.startedAt) / LAND_MS);
      // easeOutCubic: fast away, long settle — the deceleration is the whole drama.
      const eased = 1 - Math.pow(1 - t, 3);
      rotation = landing.from + (landing.to - landing.from) * eased;
      if (t >= 1) {
        rotation = landing.to;
        landing = null;
        // The wheel has arrived, so the bag update held back during the ease can land — which is
        // what removes the wedge it just stopped on.
        if (pendingSync) {
          applyBag(pendingSync.rows, pendingSync.drawnTeams);
          pendingSync = null;
        }
      }
    } else if (spinning) {
      rotation += SPIN_SPEED * dt;
    }

    draw();
    if (!idle()) wake();
  }

  function draw(): void {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssSize, cssSize);
    const c = cssSize / 2;
    const r = cssSize / 2 - 14; // room for the pointer above the rim

    if (wedges.length === 0) {
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    for (const wedge of wedges) {
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, r, wedge.startRad + rotation, wedge.endRad + rotation);
      ctx.closePath();
      ctx.fillStyle = `hsl(${wedge.hue} 58% 46%)`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(8,10,16,.55)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Label along the wedge's bisector, skipped when the arc is too thin to hold text — a
      // one-ball team on a full wheel is a sliver, and smeared glyphs read as a rendering bug.
      const span = wedge.endRad - wedge.startRad;
      if (span > 0.22) {
        const mid = (wedge.startRad + wedge.endRad) / 2 + rotation;
        ctx.save();
        ctx.translate(c + Math.cos(mid) * r * 0.62, c + Math.sin(mid) * r * 0.62);
        ctx.rotate(mid + Math.PI / 2);
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        ctx.font = `600 ${Math.max(10, Math.round(cssSize * 0.042))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(wedge.team.slice(0, 14), 0, 0);
        ctx.restore();
      }
    }

    // Hub, then the fixed pointer at 12 o'clock — the wheel turns under it.
    ctx.beginPath();
    ctx.arc(c, c, Math.max(10, r * 0.13), 0, Math.PI * 2);
    ctx.fillStyle = '#141821';
    ctx.fill();
    ctx.strokeStyle = 'rgba(245,214,123,.55)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // A small triangle biting into the rim at 12 o'clock, apex down. Kept in explicit canvas
    // coordinates rather than derived from POINTER_RAD: the layout module owns the pointer's
    // ANGLE, this owns how it is drawn, and an earlier attempt to express one in terms of the
    // other produced a triangle spanning the whole radius.
    ctx.beginPath();
    ctx.moveTo(c, c - r + 6);
    ctx.lineTo(c - 11, c - r - 10);
    ctx.lineTo(c + 11, c - r - 10);
    ctx.closePath();
    ctx.fillStyle = '#f5d67b';
    ctx.fill();
  }

  return {
    sync(rows, drawnTeams): void {
      const sig = rows.map((row) => `${row.team}:${row.balls}`).join(',');
      const drawnKey = [...drawnTeams].sort().join(',');
      if (sig === bagSig && drawnKey === drawnSig) return;
      // Mid-landing: hold it. See `pendingSync` — applying now would delete the wedge the wheel
      // is travelling toward. The newest update wins if several arrive during one ease.
      if (landing) {
        pendingSync = { rows, drawnTeams };
        return;
      }
      applyBag(rows, drawnTeams);
    },
    spin(on): void {
      if (reducedMotion) {
        spinning = false;
        draw();
        return;
      }
      if (spinning === on) return;
      spinning = on;
      if (on) wake();
      else draw();
    },
    land(team, pick): void {
      spinning = false;
      const to = landingRotation(wedges, team, pick, rotation);
      if (reducedMotion) {
        // No spin to watch: snap to the answer, which is the same answer either way.
        rotation = to;
        landing = null;
        draw();
        return;
      }
      landing = { from: rotation, to, startedAt: performance.now() };
      wake();
    },
    ensureSize(): void {
      const measured = canvas.clientWidth;
      if (!measured || measured === cssSize) return;
      cssSize = measured;
      applySize();
      draw();
    },
    setRunning(on): void {
      if (running === on) return;
      running = on;
      if (on) wake();
      else if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
    destroy(): void {
      destroyed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      wedges = [];
    },
  };
}
