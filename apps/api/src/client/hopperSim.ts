/**
 * Physics hopper for the lottery machine (#211): matter-js bodies + a canvas renderer replace the
 * old CSS-keyframe ball pile. Balls collide with each other and the hopper wall, carry their real
 * bag numbers (see `ballAssignments.ts`), and leave the pile when their team is drawn — so the
 * hopper is a live picture of the actual bag, emptying as the ceremony proceeds.
 *
 * Strictly cosmetic, same as the pile it replaces: the sim never chooses anything. The draw is
 * sealed by the commitment before the first ball moves (ADR 0006), the reveal names a team, and
 * this module just makes the un-chosen balls behave physically. The #195 pull (suck ball, chute,
 * FLIP handoff) stays DOM and untouched — the canvas sits under those overlay elements.
 *
 * Render cost is kept flat by pre-rendering each ball face (hue + number) to a small offscreen
 * sprite once, so the frame loop is drawImage + rotate per body — no per-frame gradients or text.
 * When the pile is settled and nothing is happening, the rAF loop parks itself (matter's sleeping
 * support) and wakes on the next state change, so an idle lobby costs no battery.
 */

import Matter from 'matter-js';

import { assignBallRanges, ballRadius, NUMBER_MIN_RADIUS } from './ballAssignments.js';

const { Bodies, Body, Composite, Engine, Sleeping } = Matter;

// @types/matter-js lags the runtime: `Body.rotate` has accepted (body, rotation, point,
// updateVelocity) since matter 0.19 — the point spins the compound about the hopper center, and
// updateVelocity gives the cage a surface velocity so friction actually carries balls.
const rotateAbout = Body.rotate as (
  body: Matter.Body,
  rotation: number,
  point?: Matter.Vector,
  updateVelocity?: boolean,
) => void;

export interface HopperSim {
  /**
   * Idempotent: make the pile match this bag minus these drawn teams. Poll repaints call this
   * every couple of seconds — an unchanged bag is a no-op, a changed bag rebuilds (balls tumble in
   * from the top), a newly-drawn team's balls are removed instantly (the animated exit happens in
   * {@link HopperSim.removeTeam}, which the reveal path calls first).
   */
  sync(rows: { team: string; balls: number }[], drawnTeams: string[]): void;
  /** Drum-roll boil on/off. */
  agitate(on: boolean): void;
  /** The suck moment: kick the pile away from the chute mouth so the extraction has recoil. */
  pulse(): void;
  /** A team was drawn: fade its balls out of the pile (the reveal path's animated exit). */
  removeTeam(team: string): void;
  /**
   * The drawn ball leaves the drum (#215): steer ball `num` to the chute mouth and remove it
   * there. Resolves `true` once the ball visually reached the chute (the caller runs the tube
   * transit next), `false` when there is nothing to animate — reduced motion, sim paused, or the
   * ball is not in the pile — so the reveal can proceed instantly. Never rejects and never takes
   * longer than a bounded cap: cosmetics must not block a reveal.
   */
  extractBall(num: number): Promise<boolean>;
  /** Hidden-tab pause — the sim neither steps nor draws while off. */
  setRunning(on: boolean): void;
  destroy(): void;
}

/** Fade-out length for a drawn team's balls. */
const FADE_MS = 450;
/** Fixed physics step — matter-js recommends a constant delta for stability. */
const STEP_MS = 1000 / 60;
/** How long the drawn ball takes to swim from the pile to the chute mouth. */
const EXTRACT_MS = 620;
/** Failsafe: an extraction that somehow outlives this snaps to done rather than stall a reveal. */
const EXTRACT_CAP_MS = 1500;

interface BallMeta {
  num: number;
  team: string;
  sprite: HTMLCanvasElement;
  /** Fade start timestamp once the team is drawn; the body is removed when the fade ends. */
  fadeStart?: number;
}

/** Pre-render one ball face — colored sphere with a highlight and its number — at device scale. */
function buildSprite(num: number, hue: number, radius: number, dpr: number): HTMLCanvasElement {
  const size = Math.ceil(radius * 2 * dpr);
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const ctx = sprite.getContext('2d');
  if (!ctx) return sprite;
  ctx.scale(dpr, dpr);
  const r = radius;
  const face = ctx.createRadialGradient(r * 0.68, r * 0.6, r * 0.15, r, r, r);
  face.addColorStop(0, `hsl(${hue} 70% 82%)`);
  face.addColorStop(0.45, `hsl(${hue} 60% 62%)`);
  face.addColorStop(1, `hsl(${hue} 55% 40%)`);
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  // The number rides the sprite, so it tumbles with the body's rotation in the frame loop.
  // Skipped once the ball is too small to read — a hundreds-ball override bag keeps its colors
  // (the team association survives) without smearing unreadable digits across the pile.
  if (r >= NUMBER_MIN_RADIUS) {
    ctx.fillStyle = 'rgba(16, 18, 28, 0.88)';
    ctx.font = `800 ${Math.max(7, r * 0.95)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), r, r + 0.5);
  }
  return sprite;
}

export function createHopperSim(canvas: HTMLCanvasElement): HopperSim {
  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const cssSize = canvas.clientWidth || 260;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  const ctx = canvas.getContext('2d');

  const engine = Engine.create({ enableSleeping: true });
  engine.gravity.y = 1;

  // The drum: a rotating cage, the real lottery-machine mechanism. The circular wall (matter has
  // no concave circle, so a ring of segments) plus three inward vanes form one compound body;
  // agitation spins it, the vanes scoop balls up the wall, and gravity tumbles them off the top.
  // No applied forces at all — earlier force-based boils either froze the top of a big pile or
  // levitated it wholesale (constant lift is just buoyancy), while a spinning cage churns any bag
  // size for free because the mechanism is mechanical, not a field.
  const center = cssSize / 2;
  const wallRadius = cssSize / 2 - 4;
  /** Vane reach into the chamber, as measured from the wall toward the center. */
  const VANE_LENGTH = wallRadius * 0.34;
  const VANE_COUNT = 3;
  const parts: Matter.Body[] = [];
  const segmentCount = 28;
  for (let i = 0; i < segmentCount; i += 1) {
    const angle = (i / segmentCount) * Math.PI * 2;
    const segLength = (2 * Math.PI * wallRadius) / segmentCount + 4;
    parts.push(
      Bodies.rectangle(
        center + Math.cos(angle) * (wallRadius + 5),
        center + Math.sin(angle) * (wallRadius + 5),
        10,
        segLength,
        { angle: angle, friction: 0.4 },
      ),
    );
  }
  for (let i = 0; i < VANE_COUNT; i += 1) {
    const angle = (i / VANE_COUNT) * Math.PI * 2;
    const mid = wallRadius - VANE_LENGTH / 2;
    parts.push(
      Bodies.rectangle(
        center + Math.cos(angle) * mid,
        center + Math.sin(angle) * mid,
        VANE_LENGTH,
        7,
        { angle: angle, friction: 0.4, chamfer: { radius: 3 } },
      ),
    );
  }
  const drum = Body.create({ parts, isStatic: true });
  Composite.add(engine.world, drum);
  /** Accumulated drum rotation, for drawing the vanes in step with the physics. */
  let drumAngle = 0;
  /** Cage spin while agitating, radians per second. */
  const DRUM_SPEED = 1.5;

  const meta = new Map<Matter.Body, BallMeta>();
  let bagSig = '';
  const drawn = new Set<string>();
  let agitating = false;
  let running = true;
  let rafId: number | null = null;
  let destroyed = false;

  /** The drawn ball mid-flight to the chute (#215) — at most one; a new one settles the old. */
  let extraction: {
    body: Matter.Body;
    from: Matter.Vector;
    startedAt: number;
    resolve: (flew: boolean) => void;
  } | null = null;
  /** Where the extraction lands: the chute mouth at the drum's bottom center. */
  const chuteMouth = { x: center, y: cssSize - 10 };

  /** Finish the in-flight extraction now — ball out, promise settled. Safe to call twice. */
  function settleExtraction(flew: boolean): void {
    if (!extraction) return;
    const { body, resolve } = extraction;
    extraction = null;
    Composite.remove(engine.world, body);
    meta.delete(body);
    resolve(flew);
  }

  function balls(): Matter.Body[] {
    return [...meta.keys()];
  }

  function draw(now: number): void {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssSize, cssSize);
    // The cage's vanes, under the balls — the visible spin of the drum. Drawn from our own angle
    // accumulator, which the physics rotation advances in lockstep.
    ctx.strokeStyle = 'rgba(87, 102, 141, 0.9)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    for (let i = 0; i < VANE_COUNT; i += 1) {
      const angle = drumAngle + (i / VANE_COUNT) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(
        center + Math.cos(angle) * (wallRadius - VANE_LENGTH),
        center + Math.sin(angle) * (wallRadius - VANE_LENGTH),
      );
      ctx.lineTo(
        center + Math.cos(angle) * (wallRadius - 1),
        center + Math.sin(angle) * (wallRadius - 1),
      );
      ctx.stroke();
    }
    for (const [body, m] of meta) {
      let alpha = 1;
      if (m.fadeStart !== undefined) {
        alpha = Math.max(0, 1 - (now - m.fadeStart) / FADE_MS);
        if (alpha === 0) {
          Composite.remove(engine.world, body);
          meta.delete(body);
          continue;
        }
      }
      const r = m.sprite.width / dpr / 2;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(body.position.x, body.position.y);
      ctx.rotate(body.angle);
      ctx.drawImage(m.sprite, -r, -r, r * 2, r * 2);
      ctx.restore();
    }
  }

  /**
   * True when there is nothing left to animate: no boil, no fades in flight, and every body
   * asleep. The loop parks here and `wake()` restarts it on the next state change.
   */
  function idle(): boolean {
    if (agitating || extraction) return false;
    for (const [body, m] of meta) {
      if (m.fadeStart !== undefined || !body.isSleeping) return false;
    }
    return true;
  }

  function frame(now: number): void {
    rafId = null;
    if (destroyed || !running) return;
    if (agitating) {
      // Spin the cage; the vanes do the stirring. Balls must stay awake while the drum turns —
      // a sleeping ball ignores the vane sweeping into it.
      const step = (DRUM_SPEED * STEP_MS) / 1000;
      drumAngle += step;
      rotateAbout(drum, step, { x: center, y: center }, true);
      for (const body of balls()) Sleeping.set(body, false);
    }
    if (extraction) {
      // Steer, don't simulate: the drawn ball swims to the chute mouth on an eased path the
      // physics can't disturb (its collisions are already off). Kinematic by design — the draw
      // picked this ball, the animation only delivers it.
      const t = Math.min(1, (now - extraction.startedAt) / EXTRACT_MS);
      const ease = 1 - (1 - t) * (1 - t);
      Body.setPosition(extraction.body, {
        x: extraction.from.x + (chuteMouth.x - extraction.from.x) * ease,
        y: extraction.from.y + (chuteMouth.y - extraction.from.y) * ease,
      });
      Sleeping.set(extraction.body, false);
      if (t >= 1 || now - extraction.startedAt > EXTRACT_CAP_MS) settleExtraction(true);
    }
    Engine.update(engine, STEP_MS);
    draw(now);
    if (!idle()) rafId = requestAnimationFrame(frame);
  }

  function wake(): void {
    if (destroyed || !running || reducedMotion || rafId !== null) return;
    rafId = requestAnimationFrame(frame);
  }

  /** Reduced motion: no loop at all — settle the pile synchronously and paint one still frame. */
  function settleAndPaint(): void {
    for (let i = 0; i < 240; i += 1) Engine.update(engine, STEP_MS);
    draw(performance.now());
  }

  function clearBalls(): void {
    for (const body of balls()) Composite.remove(engine.world, body);
    meta.clear();
  }

  function buildBag(rows: { team: string; balls: number }[]): void {
    clearBalls();
    const ranges = assignBallRanges(rows);
    const total = ranges.reduce((sum, range) => sum + Math.max(0, range.end - range.start + 1), 0);
    const radius = ballRadius(total, wallRadius);
    for (const range of ranges) {
      if (drawn.has(range.team)) continue;
      for (let num = range.start; num <= range.end; num += 1) {
        // Scatter across the upper half so a fresh bag visibly tumbles in and settles.
        const angle = Math.random() * Math.PI; // top semicircle
        const dist = Math.random() * (wallRadius - radius * 2);
        const body = Bodies.circle(
          center + Math.cos(angle + Math.PI) * dist * 0.8,
          center - Math.abs(Math.sin(angle)) * dist * 0.6 - 10,
          radius,
          { restitution: 0.72, friction: 0.02, frictionAir: 0.012 },
        );
        Body.setAngle(body, Math.random() * Math.PI * 2);
        meta.set(body, { num, team: range.team, sprite: buildSprite(num, range.hue, radius, dpr) });
        Composite.add(engine.world, body);
      }
    }
  }

  return {
    sync(rows, drawnTeams): void {
      const sig = rows.map((row) => `${row.team}:${row.balls}`).join(',');
      const target = new Set(drawnTeams);
      const drawnSig = [...target].sort().join(',');
      const known = [...drawn].sort().join(',');
      if (sig === bagSig && drawnSig === known) return;
      // A team previously removed but absent from the new drawn set means the pile must GROW —
      // a replay or catch-up restarting from pick one, or a fresh run of the same bag. Bodies
      // can't be un-removed piecemeal, so that's a rebuild too.
      const shrank = [...drawn].some((team) => !target.has(team));
      if (sig !== bagSig || shrank) {
        settleExtraction(false); // the pile is being rebuilt under it — end the flight quietly
        bagSig = sig;
        drawn.clear();
        for (const team of target) drawn.add(team);
        buildBag(rows);
      } else {
        // Same bag, more teams drawn — a snapshot repaint catching us up. Instant removal: the
        // animated exit already happened in removeTeam on the reveal path, or the viewer is late
        // and never saw those balls at all.
        for (const team of target) {
          if (drawn.has(team)) continue;
          drawn.add(team);
          for (const [body, m] of meta) {
            if (m.team !== team) continue;
            if (body === extraction?.body) continue; // mid-flight to the chute — it exits there
            Composite.remove(engine.world, body);
            meta.delete(body);
          }
        }
      }
      if (reducedMotion) settleAndPaint();
      else wake();
    },
    agitate(on): void {
      if (agitating === on) return;
      agitating = on;
      if (on && !reducedMotion) wake();
    },
    pulse(): void {
      if (reducedMotion) return;
      // The chute mouth is bottom-center: shove nearby balls up and outward, extraction recoil.
      for (const body of balls()) {
        const dx = body.position.x - center;
        const dy = body.position.y - (cssSize - 30);
        if (dx * dx + dy * dy < 70 * 70) {
          Sleeping.set(body, false);
          Body.applyForce(body, body.position, { x: dx * 0.00004, y: -0.004 * Math.random() });
        }
      }
      wake();
    },
    extractBall(num): Promise<boolean> {
      settleExtraction(false); // a newer reveal supersedes any flight still in progress
      if (reducedMotion || destroyed || !running) return Promise.resolve(false);
      const entry = [...meta.entries()].find(([, m]) => m.num === num && m.fadeStart === undefined);
      if (!entry) return Promise.resolve(false); // late joiner or dup event — nothing to animate
      const [body] = entry;
      return new Promise<boolean>((resolve) => {
        // The chosen ball stops colliding and swims out on its own path; the pile takes the
        // extraction recoil so the exit visibly disturbs the drum.
        body.collisionFilter.mask = 0;
        extraction = { body, from: { ...body.position }, startedAt: performance.now(), resolve };
        for (const other of balls()) {
          if (other === body) continue;
          const dx = other.position.x - body.position.x;
          const dy = other.position.y - body.position.y;
          if (dx * dx + dy * dy < 60 * 60) {
            Sleeping.set(other, false);
            Body.applyForce(other, other.position, { x: dx * 0.00005, y: -0.002 * Math.random() });
          }
        }
        wake();
      });
    },
    removeTeam(team): void {
      if (drawn.has(team)) return;
      drawn.add(team);
      const now = performance.now();
      for (const [body, m] of meta) {
        if (m.team !== team) continue;
        if (body === extraction?.body) continue; // the drawn ball exits via the chute, not a fade
        if (reducedMotion) {
          Composite.remove(engine.world, body);
          meta.delete(body);
        } else {
          m.fadeStart = now;
          // Fading balls stop colliding, so the pile settles into the space they leave behind
          // while they ghost out.
          body.collisionFilter.mask = 0;
          Sleeping.set(body, false);
        }
      }
      if (reducedMotion) draw(now);
      else wake();
    },
    setRunning(on): void {
      if (running === on) return;
      running = on;
      if (on) wake();
      else {
        // A paused sim can't fly the ball — settle now so the reveal choreography never waits on
        // a frame loop that isn't coming back.
        settleExtraction(false);
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      }
    },
    destroy(): void {
      destroyed = true;
      settleExtraction(false);
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      clearBalls();
      Engine.clear(engine);
    },
  };
}
