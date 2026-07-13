import { RenderOptions, renderImage } from '../render.js';

/** How a pick reads at your slot right now — drives the row's accent color. */
export type CheatTone = 'reach' | 'value' | 'wait' | 'fade' | 'neutral';

export interface CheatSheetPlayer {
  name: string;
  /** Position label, e.g. "RB". */
  pos: string;
  /** Overall ADP. */
  adp?: number;
  /** Value over replacement (ADP-slot units), signed. */
  vor?: number;
  /** Short flavor — recommendation flavor or scouting note. */
  note?: string;
  tone?: CheatTone;
}

export interface CheatSheetTier {
  /** Band label, e.g. "🎯 Best available" or "RB". */
  label: string;
  players: CheatSheetPlayer[];
}

export interface CheatSheetFade {
  name: string;
  pos: string;
  reason: string;
}

export interface CheatSheetCardOptions extends RenderOptions {
  title: string;
  subtitle?: string;
  tiers: CheatSheetTier[];
  fades?: CheatSheetFade[];
}

/**
 * Draft cheat-sheet card — a printable/postable tier board of the best available players,
 * grouped into bands (best-available, then by position), with a fades footer. Portrait canvas
 * since a draft board is tall; callers can override via RenderOptions. The renderer stays
 * decoupled from core/ESPN types — the caller (the bot command) resolves the bands from the
 * parsed rankings + the recommendation engine and passes plain rows.
 */
export function renderCheatSheetCard(options: CheatSheetCardOptions): Promise<Buffer> {
  const { title, subtitle, tiers, fades, ...renderOptions } = options;
  return renderImage(
    { kind: 'graph', title, subtitle, payload: { type: 'cheat-sheet', tiers, fades } },
    { size: { width: 1080, height: 1350 }, ...renderOptions },
  );
}
