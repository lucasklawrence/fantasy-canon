# Ping Pong Lottery Animation – Implementation Outline

## Goal
Visually simulate ping pong balls moving inside a lottery machine and selecting a ball,
while keeping draft order determination server-authoritative and deterministic.

The animation must *act out* a precomputed result, not decide it.

---

## Target Platform
- Discord Activity (iframe)
- Web-based canvas rendering

---

## Recommended Approach (MVP+)
**2D Canvas with Matter.js**

Why:
- Lightweight
- Realistic motion
- Works well inside iframes
- Easy to control deterministically

---

## High-Level Architecture

### Server (Bot / API)
- Computes draft result using deterministic seed
- Sends ordered list of `ballId`s to client
- Never relies on animation for randomness

### Client (Activity / Web)
- Renders animation
- Receives `drawBall(ballId)` commands
- Animates the correct ball being selected

---

## Rendering Stack
- HTML Canvas
- Matter.js (physics)
- requestAnimationFrame loop

Optional:
- Howler.js for sound effects

---

## World Setup

### Bodies
- Balls: circles with restitution ~0.9
- Walls: static rectangles
- Exit tube: static walls + removable gate
- Stir paddles: rotating static bodies (or motors)

### Ball Encoding
Each ball has:
- teamId
- ballIndex
- ballId = "<teamId>:<n>"

Stored as Matter.js body metadata.

---

## Animation Lifecycle

### 1. Mixing Phase
- Spawn balls randomly inside container
- Enable paddles
- Let physics run for 3–5 seconds

### 2. Draw Phase
- Server sends `ballId`
- Client locates matching body
- Apply directional force toward exit
- Open exit gate
- Reduce forces on other balls

### 3. Reveal Phase
- Freeze physics
- Spotlight selected ball
- Show team + pick number
- Resume mixing for next draw

---

## Fairness Guarantees
- Server computes outcome first
- Client animation is cosmetic
- Seed + ball counts publicly shown

---

## Interfaces

```ts
interface LotteryRenderer {
  init(teams: Team[]): void;
  startMixing(): void;
  drawBall(ballId: string): Promise<void>;
  pause(): void;
  reset(): void;
}
```

---

## File Structure (Suggested)

apps/activity/
  src/
    renderer/
      LotteryRenderer.ts
      MatterLotteryRenderer.ts
    physics/
      world.ts
      bodies.ts
    ui/
      Overlay.tsx
      RevealBanner.tsx

---

## MVP Cut Line
MVP includes:
- 2D physics
- Single exit tube
- Basic lighting / colors
- No 3D rendering
- No mobile gestures

Advanced visuals deferred.

---

## Timeline Estimate
- Basic fake physics: 1 day
- Matter.js MVP: 3–5 days
- Polished visuals: +2–3 days

---

## Summary
This approach maximizes trust, performance, and visual impact
without introducing fairness or complexity risks.
