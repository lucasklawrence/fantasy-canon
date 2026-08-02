/**
 * Shared ball-face sprite for the canvas renderers (#211 machine, #235 race). Pre-rendering each
 * face once keeps both frame loops at drawImage-only cost — no per-frame gradients or text.
 */

import { NUMBER_MIN_RADIUS } from './ballAssignments.js';

/**
 * Pre-render one ball face — colored sphere with a highlight and an optional label — at device
 * scale. `label` is skipped below {@link NUMBER_MIN_RADIUS} (unreadable anyway) or when `null`
 * (a race lane's un-locked racer, whose finishing number nobody knows yet).
 */
export function buildBallSprite(
  label: string | null,
  hue: number,
  radius: number,
  dpr: number,
): HTMLCanvasElement {
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
  // The label rides the sprite, so it tumbles with the body's rotation in the machine's loop.
  if (label !== null && r >= NUMBER_MIN_RADIUS) {
    ctx.fillStyle = 'rgba(16, 18, 28, 0.88)';
    ctx.font = `800 ${Math.max(7, r * 0.95)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, r, r + 0.5);
  }
  return sprite;
}
