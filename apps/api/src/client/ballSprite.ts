/**
 * Shared ball-face sprite for the canvas renderers (#211 machine, #235 race). Pre-rendering each
 * face once keeps both frame loops at drawImage-only cost — no per-frame gradients or text.
 */

import { NUMBER_MIN_RADIUS } from './ballAssignments.js';

/**
 * Pre-render one ball face — colored sphere with a highlight and an optional label — at device
 * scale. `label` is skipped below {@link NUMBER_MIN_RADIUS} (unreadable anyway) or when `null`
 * (a race lane's un-locked racer, whose finishing number nobody knows yet).
 *
 * `logo` (#242) paints the team's image inside a hue ring instead of the plain sphere — used by
 * the race cars, never the hopper pile (those balls ARE the published commitment made visible,
 * so their numbers stay). A label over a logo gets a dark backing disc so a locked racer's pick
 * number stays readable on any artwork.
 */
export function buildBallSprite(
  label: string | null,
  hue: number,
  radius: number,
  dpr: number,
  logo?: CanvasImageSource | null,
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
  if (logo) {
    // Cover-fit the image into a circle inset from the rim, leaving the hue visible as a ring so
    // the team-color linkage (swatch ↔ balls ↔ racer) survives the artwork.
    const inner = r * 0.82;
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, inner, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(logo, r - inner, r - inner, inner * 2, inner * 2);
    ctx.restore();
  }
  // The label rides the sprite, so it tumbles with the body's rotation in the machine's loop.
  if (label !== null && r >= NUMBER_MIN_RADIUS) {
    if (logo) {
      ctx.fillStyle = 'rgba(16, 18, 28, 0.78)';
      ctx.beginPath();
      ctx.arc(r, r, r * 0.52, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f3f5fa';
    } else {
      ctx.fillStyle = 'rgba(16, 18, 28, 0.88)';
    }
    ctx.font = `800 ${Math.max(7, r * 0.95)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, r, r + 0.5);
  }
  return sprite;
}
