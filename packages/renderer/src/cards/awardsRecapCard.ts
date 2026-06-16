import { RenderOptions, renderImage } from '../render.js';

export interface AwardEntry {
  /** Award name, e.g. "MVP" or "Bust of the Year". */
  label: string;
  /** Winner (team or manager name). */
  winner: string;
  /** Optional stat line, e.g. "1,623.4 pts • 11-3". */
  detail?: string;
  /** Optional leading glyph/emoji, e.g. "🏆". */
  emoji?: string;
}

export interface AwardsRecapCardOptions extends RenderOptions {
  title: string;
  subtitle?: string;
  awards: AwardEntry[];
}

/**
 * End-of-season "Wrapped"-style awards recap — a grid of award tiles (name, winner,
 * stat line), mixing serious honors with banter (docs/14 §5, Bucket B). Defaults to a
 * square canvas since a full recap is tall; callers can override via RenderOptions.
 * The renderer stays decoupled from core/ESPN types — callers pass resolved awards.
 */
export function renderAwardsRecapCard(options: AwardsRecapCardOptions): Promise<Buffer> {
  const { title, subtitle, awards, ...renderOptions } = options;
  return renderImage(
    { kind: 'graph', title, subtitle, payload: { type: 'awards-recap', awards } },
    { size: { width: 1080, height: 1080 }, ...renderOptions },
  );
}
