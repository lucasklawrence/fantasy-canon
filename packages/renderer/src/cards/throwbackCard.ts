import { RenderOptions, renderImage } from '../render.js';

export interface ThrowbackStat {
  /** Left-aligned caption, e.g. "Head-to-head" or "Expected wins". */
  label: string;
  /** Right-aligned value, e.g. "5–2" or "$40". */
  value: string;
}

export interface ThrowbackCardOptions extends RenderOptions {
  /** Card title, e.g. "My League • Throwback". */
  title: string;
  /** Optional line under the title, e.g. "Season 2024". */
  subtitle?: string;
  /** Small kicker above the headline, e.g. "⚔️ Biggest Rivalry". */
  badge?: string;
  /** The hero line — the team(s) the throwback is about. */
  headline: string;
  /** Supporting stat rows shown below the headline. */
  stats: ThrowbackStat[];
}

/**
 * "On this week in history" throwback — a single-subject hero card: a kicker badge, a big
 * headline (the team/pairing), and a short column of supporting stats. Rendered by the
 * scheduled throwback DAG's bot hand-off (issue #17). Defaults to a square canvas like the
 * awards recap; the renderer stays decoupled from core/ESPN types (callers pass resolved text).
 */
export function renderThrowbackCard(options: ThrowbackCardOptions): Promise<Buffer> {
  const { title, subtitle, badge, headline, stats, ...renderOptions } = options;
  return renderImage(
    { kind: 'graph', title, subtitle, payload: { type: 'throwback', badge, headline, stats } },
    { size: { width: 1080, height: 1080 }, ...renderOptions },
  );
}
