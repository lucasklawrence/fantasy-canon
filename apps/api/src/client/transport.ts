/**
 * Pure transport helpers for the dashboard client (#127 Phase 2). They take plain location-shaped
 * inputs rather than reading globals, so they unit-test under Node with no DOM — the browser entry
 * (`activity.ts`) passes the real `location`.
 *
 * Inside the Discord Activity iframe the app is served from `{clientId}.discordsays.com` and every
 * request must go through the `/.proxy` prefix (unmapped origins fail `blocked:csp`); in dev the
 * board is served straight from the backend root. These helpers compute the right base + URLs for
 * both, so `render`/`activity` never hardcode a prefix.
 */

/** The subset of `window.location` these helpers read. */
export interface LocationLike {
  search: string;
  hostname: string;
  protocol: string;
  host: string;
}

/**
 * Is the page running inside the Discord Activity iframe? Discord launches the app with a
 * `?frame_id=…` query param and serves it under a `*.discordsays.com` host — either signal is
 * enough (the query param survives even if the host check ever changes).
 */
export function isDiscordActivity(loc: Pick<LocationLike, 'search' | 'hostname'>): boolean {
  const hasFrameId = new URLSearchParams(loc.search).has('frame_id');
  return hasFrameId || loc.hostname.endsWith('.discordsays.com');
}

/** Base path all API/asset/WS calls are prefixed with: `/.proxy` inside Discord, `''` in dev. */
export function proxyBase(inDiscord: boolean): string {
  return inDiscord ? '/.proxy' : '';
}

/** An absolute-from-root API/asset path under the given base (`apiPath('/.proxy', '/api/state')`). */
export function apiPath(base: string, route: string): string {
  const suffix = route.startsWith('/') ? route : `/${route}`;
  return `${base}${suffix}`;
}

/** The WebSocket URL for a push feed under the given base, matching the page's ws/wss scheme. */
export function wsUrl(
  loc: Pick<LocationLike, 'protocol' | 'host'>,
  base: string,
  route = '/api/ws',
): string {
  const scheme = loc.protocol === 'https:' ? 'wss://' : 'ws://';
  return `${scheme}${loc.host}${base}${route}`;
}
