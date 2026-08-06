/**
 * Bot-side team-logo delivery (#249).
 *
 * The api's anonymous proxy (#242) can only serve what it can fetch without credentials as a
 * raster image — which, against a real league, was 2 of 12 logos: ESPN-hosted uploads
 * (`mystique-api.fantasy.espn.com`) 401 without the league's cookies, and ESPN's stock logos are
 * SVG, which the proxy refuses (script container served from our origin). Both capabilities live
 * on the bot and nowhere else — it holds `ESPN_S2`/`SWID`, and it already depends on resvg via
 * the renderer — so the bot fetches, flattens, and pushes ready-to-serve raster bytes to the
 * stage's logo cache. The api stays ESPN-ignorant (#219's invariant), and SVG dies at this
 * boundary.
 *
 * Everything is best-effort per team: a failed fetch, an oversized file, or an unparseable SVG
 * leaves that team on its hue ball, exactly the degradation the client already renders.
 */

import { rasterizeSvgLogo } from '@fantasy-canon/renderer';
import type { InspectableRevealStage } from './lotteryStageClient.js';

/** Mirror of the api's caps: fetch bound + the logo-cache route's decoded-size gate. */
export const LOGO_FETCH_TIMEOUT_MS = 5000;
export const LOGO_MAX_BYTES = 512 * 1024;

export interface LogoPushCookies {
  espnS2?: string;
  espnSwid?: string;
}

export interface LogoPushDeps {
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to the renderer's resvg rasterizer. */
  rasterize?: (svg: string, width?: number) => Buffer | null;
}

/**
 * ESPN's league cookies go ONLY to ESPN's own hosts. An attacker-influenced logo URL (a team
 * name is user-controlled; a logo URL is too) must never be able to lure the league's session
 * cookies to a third-party server.
 */
export function isEspnHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'espn.com' || h.endsWith('.espn.com');
}

/**
 * Loopback/link-local/RFC1918 — a league member types the logo URL, and the bot runs on the
 * operator's home machine, so a private target is only ever a mistake or a probe. Mirrors the
 * api proxy's guard (#247); checked again after redirects.
 */
function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.local') ||
    h === '::1' ||
    h.startsWith('127.') ||
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    h.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * Read at most `cap` bytes, cancelling the moment the stream exceeds it — `arrayBuffer()` would
 * buffer an endless or mis-declared response entirely before any size check could run.
 */
async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    // Node's fetch types the chunk loosely under our DOM-less tsconfig; it is always bytes.
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done || value === undefined) break;
    received += value.byteLength;
    if (received > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch one logo the way only the bot can (#249): cookies for ESPN hosts, SVG flattened to PNG,
 * raster passed through — bounded, and null for anything unusable.
 */
export async function fetchLogoForPush(
  url: string,
  cookies: LogoPushCookies,
  deps: LogoPushDeps = {},
): Promise<{ contentType: string; body: Buffer } | null> {
  const { fetchImpl = fetch, rasterize = rasterizeSvgLogo } = deps;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (privateHost(parsed.hostname)) return null;
  const cookieParts: string[] = [];
  // Cookies require BOTH the right owner and an encrypted channel: a plaintext http://*.espn.com
  // URL would broadcast the league's session to every hop on the path.
  if (parsed.protocol === 'https:' && isEspnHost(parsed.hostname)) {
    if (cookies.espnS2) cookieParts.push(`espn_s2=${cookies.espnS2}`);
    if (cookies.espnSwid) cookieParts.push(`SWID=${cookies.espnSwid}`);
  }
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS),
      redirect: 'follow',
      headers: cookieParts.length > 0 ? { Cookie: cookieParts.join('; ') } : {},
    });
    if (!res.ok) return null;
    // A redirect chain must not end somewhere the original URL couldn't have started.
    if (res.url) {
      try {
        if (privateHost(new URL(res.url).hostname)) return null;
      } catch {
        return null;
      }
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('image/')) return null;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > LOGO_MAX_BYTES) return null;
    const raw = await readCapped(res, LOGO_MAX_BYTES);
    if (!raw || raw.byteLength === 0) return null;
    if (contentType.includes('svg')) {
      // Stock logos: flatten to PNG here, where resvg already lives. resvg executes nothing and
      // fetches nothing, so a hostile SVG can at worst fail to parse.
      const png = rasterize(raw.toString('utf8'));
      if (!png || png.byteLength > LOGO_MAX_BYTES) return null;
      return { contentType: 'image/png', body: png };
    }
    return { contentType, body: raw };
  } catch {
    return null;
  }
}

/**
 * Push every fetchable logo for this roster to the stage's cache, one team at a time,
 * best-effort. Returns the count that landed (for the log line); a stage without the `logo`
 * method — a test double, an older api — means zero pushes and zero noise.
 */
export async function pushTeamLogos(
  stage: InspectableRevealStage,
  logos: ReadonlyMap<string, string>,
  cookies: LogoPushCookies,
  deps: LogoPushDeps = {},
): Promise<number> {
  if (!stage.logo || logos.size === 0) return 0;
  let pushed = 0;
  for (const [teamId, url] of logos) {
    const image = await fetchLogoForPush(url, cookies, deps);
    if (!image) continue;
    try {
      await stage.logo({
        teamId,
        url,
        contentType: image.contentType,
        data: image.body.toString('base64'),
      });
      pushed += 1;
    } catch (error) {
      // Per-team and non-fatal: the ceremony must never depend on cosmetics (#242's rule).
      console.error(`[draftorder] logo push failed for team ${teamId}:`, error);
    }
  }
  return pushed;
}
