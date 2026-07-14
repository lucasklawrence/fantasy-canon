import { RenderOptions, renderImage } from '../render.js';

/** One drafted position's contribution — count drafted and mean value-vs-ADP (signed). */
export interface GradePositionBar {
  /** Position label, e.g. "RB". */
  pos: string;
  count: number;
  /** Mean value-vs-ADP for the position (positive = beat the market). */
  avgValue: number;
}

/** A single pick in the steals/reaches columns. */
export interface GradePickRow {
  playerName: string;
  /** 1-based overall pick number. */
  overall: number;
  /** `overall − adp`, signed; positive = steal, negative = reach. */
  value?: number;
  position?: string;
}

export interface GradeCardOptions extends RenderOptions {
  /** Card title, e.g. a team name or "Your draft grade". */
  title: string;
  subtitle?: string;
  /** Letter grade, e.g. "A-". */
  grade: string;
  /** Composite score behind the letter (value minus construction penalty). */
  score: number;
  /** Mean value-vs-ADP across graded picks, before the penalty. */
  valueScore: number;
  starters: { filled: number; required: number; missing: string[] };
  /** Per-position bars, caller-ordered (e.g. RB, WR, TE, QB). */
  byPosition: GradePositionBar[];
  /** Best-value picks first, up to 3. */
  steals: GradePickRow[];
  /** Worst reaches first, up to 3. */
  reaches: GradePickRow[];
  /** Small print, e.g. "ADP as of 2026-07-13 • grade assumes a completed roster". */
  footer?: string;
}

/**
 * Post-draft **grade card** — a shareable report card for a completed roster: a big letter grade,
 * the value/score/starters headline, per-position value bars, and Steals/Reaches columns. Portrait
 * canvas since the breakdown is tall; callers can override via RenderOptions. Like the other cards
 * the renderer stays decoupled from core — the bot command maps `RosterGrade` → these plain rows.
 */
export function renderGradeCard(options: GradeCardOptions): Promise<Buffer> {
  const {
    title,
    subtitle,
    grade,
    score,
    valueScore,
    starters,
    byPosition,
    steals,
    reaches,
    footer,
    ...renderOptions
  } = options;
  return renderImage(
    {
      kind: 'graph',
      title,
      subtitle,
      payload: {
        type: 'grade',
        grade,
        score,
        valueScore,
        starters,
        byPosition,
        steals,
        reaches,
        footer,
      },
    },
    { size: { width: 1080, height: 1200 }, ...renderOptions },
  );
}
