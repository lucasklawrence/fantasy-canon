import { Resvg } from '@resvg/resvg-js';
import { DEFAULT_THEME } from './theme.js';

export type RenderBackend = 'svg' | 'png';

export interface RenderSpec {
  kind: 'graph' | 'card';
  title: string;
  subtitle?: string;
  payload: unknown;
}

export interface RenderOptions {
  backend?: RenderBackend;
  themeOverride?: Partial<typeof DEFAULT_THEME>;
  size?: { width: number; height: number };
}

export function renderImage(spec: RenderSpec, options: RenderOptions = {}): Promise<Buffer> {
  const backend = options.backend ?? 'png';
  const theme = { ...DEFAULT_THEME, ...(options.themeOverride ?? {}) };
  const size = options.size ?? theme.sizes.hd;

  const svg = renderSvg(spec, theme, size);

  if (backend === 'svg') {
    return Promise.resolve(Buffer.from(svg, 'utf8'));
  }

  if (backend === 'png') {
    try {
      const resvg = new Resvg(svg, {
        fitTo: {
          mode: 'width',
          value: size.width,
        },
      });
      const rendered = resvg.render();
      return Promise.resolve(Buffer.from(rendered.asPng()));
    } catch (error) {
      console.error('Failed to rasterize SVG, falling back to raw svg buffer', error);
      return Promise.resolve(Buffer.from(svg, 'utf8'));
    }
  }

  const lines = [
    `[${spec.kind}] ${spec.title}`,
    spec.subtitle ? spec.subtitle : '',
    JSON.stringify(spec.payload, null, 2),
  ].filter(Boolean);
  return Promise.resolve(Buffer.from(lines.join('\n'), 'utf8'));
}

/**
 * Rasterize an arbitrary SVG document to PNG bytes (#249) — used by the bot to convert ESPN's
 * stock SVG team logos before pushing them to the Activity's logo cache, which serves raster
 * only (SVG is a script container and those bytes are served from the api's origin). Returns
 * null on anything resvg cannot parse; the caller treats that as "no logo", never an error.
 * resvg neither executes scripts nor fetches external references, so untrusted SVG is inert here.
 */
export function rasterizeSvgLogo(svg: string, width = 128): Buffer | null {
  try {
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
    return Buffer.from(resvg.render().asPng());
  } catch {
    return null;
  }
}

function renderSvg(
  spec: RenderSpec,
  theme: typeof DEFAULT_THEME,
  size: { width: number; height: number },
): string {
  const { width, height } = size;
  const bg = theme.colors.background;
  const text = theme.colors.text;
  const surface = theme.colors.surface;

  let body = `<rect width="${width}" height="${height}" fill="${bg}" />`;
  body += `<text x="${width / 2}" y="60" fill="${text}" font-family="${theme.fonts.heading}" font-size="36" text-anchor="middle">${escape(
    spec.title,
  )}</text>`;
  if (spec.subtitle) {
    body += `<text x="${width / 2}" y="100" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="22" text-anchor="middle">${escape(
      spec.subtitle,
    )}</text>`;
  }

  if (spec.kind === 'graph' && typeof spec.payload === 'object' && spec.payload) {
    const payload = spec.payload as { type?: unknown };
    if (payload.type === 'luck-scatter') {
      body += renderLuckScatter(
        payload as Parameters<typeof renderLuckScatter>[0],
        theme,
        width,
        height,
      );
    } else if (payload.type === 'draft-prophecy') {
      body += renderDraftProphecy(
        payload as Parameters<typeof renderDraftProphecy>[0],
        theme,
        width,
        height,
      );
    } else if (payload.type === 'faab-pace') {
      body += renderFaabPace(payload as Parameters<typeof renderFaabPace>[0], theme, width, height);
    } else if (payload.type === 'power-ranking') {
      body += renderPowerRanking(
        payload as Parameters<typeof renderPowerRanking>[0],
        theme,
        width,
        height,
      );
    } else if (payload.type === 'awards-recap') {
      body += renderAwardsRecap(
        payload as Parameters<typeof renderAwardsRecap>[0],
        theme,
        width,
        height,
      );
    } else if (payload.type === 'bump-chart') {
      body += renderBumpChart(
        payload as Parameters<typeof renderBumpChart>[0],
        theme,
        width,
        height,
      );
    } else if (payload.type === 'throwback') {
      body += renderThrowback(
        payload as Parameters<typeof renderThrowback>[0],
        theme,
        width,
        height,
      );
    } else if (payload.type === 'cheat-sheet') {
      body += renderCheatSheet(
        payload as Parameters<typeof renderCheatSheet>[0],
        theme,
        width,
        height,
      );
    } else if (payload.type === 'grade') {
      body += renderGrade(payload as Parameters<typeof renderGrade>[0], theme, width, height);
    } else if (payload.type === 'lottery-odds') {
      body += renderLotteryOdds(
        payload as Parameters<typeof renderLotteryOdds>[0],
        theme,
        width,
        height,
      );
    } else if (payload.type === 'lottery-reveal') {
      body += renderLotteryReveal(
        payload as Parameters<typeof renderLotteryReveal>[0],
        theme,
        width,
        height,
      );
    } else if (payload.type === 'lottery-board') {
      body += renderLotteryBoard(
        payload as Parameters<typeof renderLotteryBoard>[0],
        theme,
        width,
        height,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">${body}<rect x="40" y="140" width="${
    width - 80
  }" height="${height - 180}" fill="none" stroke="${surface}" stroke-width="2" /></svg>`;
}

function renderLuckScatter(
  payload: {
    points: Array<{ team: string; wins: number; expectedWins: number; luck: number }>;
    axes?: { x?: string; y?: string };
    outliers?: Array<{ team: string; luck: number }>;
  },
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  const plotArea = { x: 80, y: 160, w: width - 160, h: height - 240 };
  const wins = payload.points.map((p) => p.wins);
  const exp = payload.points.map((p) => p.expectedWins);
  const minX = Math.min(...exp, 0);
  const maxX = Math.max(...exp, 1);
  const minY = Math.min(...wins, 0);
  const maxY = Math.max(...wins, 1);

  const scaleX = (val: number) => plotArea.x + ((val - minX) / (maxX - minX || 1)) * plotArea.w;
  const scaleY = (val: number) =>
    plotArea.y + plotArea.h - ((val - minY) / (maxY - minY || 1)) * plotArea.h;

  let body = '';
  // Expected line
  const lineX1 = scaleX(minX);
  const lineY1 = scaleY(minX);
  const lineX2 = scaleX(maxX);
  const lineY2 = scaleY(maxX);
  body += `<line x1="${lineX1}" y1="${lineY1}" x2="${lineX2}" y2="${lineY2}" stroke="${theme.colors.muted}" stroke-dasharray="4 4" />`;

  // gridlines/ticks
  const xStep = niceStep(maxX - minX, 6);
  for (let x = Math.ceil(minX); x <= maxX; x += xStep) {
    const gx = scaleX(x);
    body += `<line x1="${gx}" y1="${plotArea.y}" x2="${gx}" y2="${plotArea.y + plotArea.h}" stroke="${theme.colors.surface}" stroke-width="1" opacity="0.4" />`;
    body += `<text x="${gx}" y="${plotArea.y + plotArea.h + 18}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="12" text-anchor="middle">${x.toFixed(1)}</text>`;
  }
  const yStep = niceStep(maxY - minY, 6);
  for (let y = Math.ceil(minY); y <= maxY; y += yStep) {
    const gy = scaleY(y);
    body += `<line x1="${plotArea.x}" y1="${gy}" x2="${plotArea.x + plotArea.w}" y2="${gy}" stroke="${theme.colors.surface}" stroke-width="1" opacity="0.4" />`;
    body += `<text x="${plotArea.x - 10}" y="${gy + 4}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="12" text-anchor="end">${y.toFixed(1)}</text>`;
  }

  payload.points.forEach((p) => {
    const cx = scaleX(p.expectedWins);
    const cy = scaleY(p.wins);
    const color = p.luck > 0 ? theme.colors.accent : theme.colors.danger;
    body += `<circle cx="${cx}" cy="${cy}" r="6" fill="${color}" />`;
  });

  if (payload.outliers) {
    payload.outliers.forEach((o, idx) => {
      const pt = payload.points.find((p) => p.team === o.team);
      if (!pt) return;
      const cx = scaleX(pt.expectedWins);
      const cy = scaleY(pt.wins);
      body += `<text x="${cx + 8}" y="${cy - 8}" fill="${theme.colors.text}" font-family="${
        theme.fonts.body
      }" font-size="14">${escape(`${idx + 1}. ${o.team}`)}</text>`;
    });
  }

  body += axisLabels(
    theme,
    plotArea,
    payload.axes?.x ?? 'Expected wins',
    payload.axes?.y ?? 'Actual wins',
  );

  return body;
}

function renderDraftProphecy(
  payload: {
    lines: Array<{
      team: string;
      projectedRank?: number | null;
      finalRank?: number | null;
      delta: number | null;
    }>;
    highlight?: { team: string; delta: number | null };
  },
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  const plotArea = { x: 80, y: 160, w: width - 160, h: height - 240 };
  const ranks = payload.lines.flatMap((p) => [p.projectedRank ?? 1, p.finalRank ?? 1]);
  const minRank = Math.min(...ranks, 1);
  const maxRank = Math.max(...ranks, 1);
  const scaleY = (val: number) =>
    plotArea.y + ((val - minRank) / (maxRank - minRank || 1)) * plotArea.h;

  let body = '';

  payload.lines.forEach((p) => {
    if (p.projectedRank == null || p.finalRank == null) return;
    const x1 = plotArea.x;
    const y1 = scaleY(p.projectedRank);
    const x2 = plotArea.x + plotArea.w;
    const y2 = scaleY(p.finalRank);
    const color = p.delta !== null && p.delta < 0 ? theme.colors.danger : theme.colors.accent;
    body += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2" opacity="0.7" />`;
  });

  if (payload.highlight && payload.highlight.delta !== null) {
    const hi = payload.lines.find((p) => p.team === payload.highlight?.team);
    if (hi && hi.projectedRank != null && hi.finalRank != null) {
      const x1 = plotArea.x;
      const y1 = scaleY(hi.projectedRank);
      const x2 = plotArea.x + plotArea.w;
      const y2 = scaleY(hi.finalRank);
      body += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${theme.colors.secondary}" stroke-width="3" />`;
      body += `<text x="${x2 - 10}" y="${y2 - 10}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="14" text-anchor="end">${escape(
        hi.team,
      )}</text>`;
    }
  }

  body += axisLabels(theme, plotArea, 'Projected rank', 'Final rank');

  return body;
}

function renderFaabPace(
  payload: {
    lines: Array<{ team: string; weekly: number[] }>;
    budget: number;
    axes?: { x?: string; y?: string };
  },
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  const plotArea = { x: 80, y: 160, w: width - 160, h: height - 240 };
  const maxWeek = Math.max(...payload.lines.map((l) => l.weekly.length), 1);
  const maxSpend = Math.max(
    payload.budget,
    ...payload.lines.map((l) => (l.weekly.length ? l.weekly[l.weekly.length - 1] : 0)),
  );
  const scaleX = (week: number) =>
    plotArea.x + ((week - 1) / ((maxWeek || 1) - 1 || 1)) * plotArea.w;
  const scaleY = (val: number) => plotArea.y + plotArea.h - (val / (maxSpend || 1)) * plotArea.h;

  let body = '';
  // Budget line
  const by = scaleY(payload.budget);
  body += `<line x1="${plotArea.x}" y1="${by}" x2="${plotArea.x + plotArea.w}" y2="${by}" stroke="${theme.colors.muted}" stroke-dasharray="4 4" />`;

  // X ticks (weeks)
  const stepX = Math.max(1, Math.ceil(maxWeek / 8));
  for (let w = 1; w <= maxWeek; w += stepX) {
    const x = scaleX(w);
    body += `<line x1="${x}" y1="${plotArea.y}" x2="${x}" y2="${plotArea.y + plotArea.h}" stroke="${theme.colors.surface}" stroke-width="1" opacity="0.4" />`;
    body += `<text x="${x}" y="${plotArea.y + plotArea.h + 18}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="12" text-anchor="middle">W${w}</text>`;
  }

  // Y ticks (spend)
  const yStep = niceStep(maxSpend, 6);
  for (let s = 0; s <= maxSpend; s += yStep) {
    const y = scaleY(s);
    body += `<line x1="${plotArea.x}" y1="${y}" x2="${plotArea.x + plotArea.w}" y2="${y}" stroke="${theme.colors.surface}" stroke-width="1" opacity="0.4" />`;
    body += `<text x="${plotArea.x - 10}" y="${y + 4}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="12" text-anchor="end">$${s.toFixed(0)}</text>`;
  }

  payload.lines.forEach((line, idx) => {
    const color = palette(theme, idx);
    const points: string[] = [];
    line.weekly.forEach((cum, i) => {
      const x = scaleX(i + 1);
      const y = scaleY(cum);
      points.push(`${x},${y}`);
    });
    if (points.length >= 2) {
      body += `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2" />`;
    }
    const lastX = scaleX(line.weekly.length);
    const lastY = scaleY(line.weekly[line.weekly.length - 1] ?? 0);
    // label backplate for readability
    body += `<rect x="${lastX + 4}" y="${lastY - 14}" width="140" height="18" fill="${theme.colors.surface}" opacity="0.8" />`;
    body += `<text x="${lastX + 8}" y="${lastY + 1}" fill="${color}" font-family="${theme.fonts.body}" font-size="13">${escape(line.team)}</text>`;
  });

  body += axisLabels(
    theme,
    plotArea,
    payload.axes?.x ?? 'Week',
    payload.axes?.y ?? 'Cumulative FAAB',
  );

  return body;
}

function renderPowerRanking(
  payload: {
    rows: Array<{ rank: number; team: string; score: number; gap: number }>;
  },
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  const plotArea = { x: 80, y: 160, w: width - 160, h: height - 240 };
  const rows = payload.rows;
  if (rows.length === 0) return '';

  const maxScore = Math.max(...rows.map((r) => r.score), 1);
  // Leave room on the right for the score/gap label.
  const barMaxW = plotArea.w - 220;
  const rowH = plotArea.h / rows.length;
  const barH = Math.min(28, rowH * 0.55);

  let body = '';
  rows.forEach((r, idx) => {
    const color = palette(theme, idx);
    const cy = plotArea.y + idx * rowH + rowH / 2;
    const barW = Math.max(2, (r.score / maxScore) * barMaxW);
    const barX = plotArea.x + 150;

    // Rank + team name on the left.
    body += `<text x="${plotArea.x}" y="${cy + 5}" fill="${theme.colors.muted}" font-family="${theme.fonts.heading}" font-size="18" font-weight="bold">${r.rank}.</text>`;
    body += `<text x="${plotArea.x + 34}" y="${cy + 5}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="16">${escape(
      r.team,
    )}</text>`;

    // Score bar.
    body += `<rect x="${barX}" y="${cy - barH / 2}" width="${barW}" height="${barH}" rx="4" fill="${color}" opacity="0.85" />`;

    // Score value, and the gap to the team above (the headline insight).
    const scoreLabel = r.score.toFixed(1);
    body += `<text x="${barX + barW + 10}" y="${cy + 5}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="15">${scoreLabel}</text>`;
    if (idx > 0 && r.gap > 0) {
      body += `<text x="${barX + barW + 70}" y="${cy + 5}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="13">▼ ${r.gap.toFixed(1)}</text>`;
    }
  });

  return body;
}

function renderAwardsRecap(
  payload: {
    awards: Array<{ label: string; winner: string; detail?: string; emoji?: string }>;
  },
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  const awards = payload.awards;
  if (awards.length === 0) return '';

  const plotArea = { x: 60, y: 150, w: width - 120, h: height - 200 };
  const cols = awards.length > 6 ? 2 : 1;
  const rows = Math.ceil(awards.length / cols);
  const colW = plotArea.w / cols;
  const rowH = plotArea.h / rows;
  // Rough character budget so long names don't overrun their tile.
  const charBudget = Math.max(12, Math.floor((colW - 32) / 11));

  let body = '';
  awards.forEach((a, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const tileX = plotArea.x + col * colW + 8;
    const tileY = plotArea.y + row * rowH + 8;
    const textX = tileX + 14;

    body += `<rect x="${tileX}" y="${tileY}" width="${colW - 16}" height="${rowH - 16}" rx="10" fill="${theme.colors.surface}" opacity="0.6" />`;

    const label = (a.emoji ? `${a.emoji} ` : '') + a.label;
    body += `<text x="${textX}" y="${tileY + 30}" fill="${theme.colors.secondary}" font-family="${theme.fonts.heading}" font-size="16" font-weight="bold">${escape(
      truncate(label, charBudget),
    )}</text>`;
    body += `<text x="${textX}" y="${tileY + 58}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="20">${escape(
      truncate(a.winner, charBudget),
    )}</text>`;
    if (a.detail) {
      body += `<text x="${textX}" y="${tileY + 82}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="14">${escape(
        truncate(a.detail, charBudget + 6),
      )}</text>`;
    }
  });

  return body;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function renderBumpChart(
  payload: {
    weeks: number[];
    lines: Array<{ team: string; ranks: number[] }>;
  },
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  const { weeks, lines } = payload;
  if (weeks.length === 0 || lines.length === 0) return '';

  // Reserve space on the right for direct line-end team labels (no side legend).
  const labelSpace = 150;
  const plotArea = { x: 90, y: 160, w: width - 160 - labelSpace, h: height - 240 };
  const maxRank = Math.max(1, ...lines.flatMap((l) => l.ranks));

  const scaleX = (weekIdx: number) =>
    plotArea.x + (weekIdx / Math.max(1, weeks.length - 1)) * plotArea.w;
  // Inverted: rank 1 at the top.
  const scaleY = (rank: number) =>
    plotArea.y + ((rank - 1) / Math.max(1, maxRank - 1)) * plotArea.h;

  let body = '';

  // Y gridlines + rank labels (1..maxRank), rank 1 at top.
  for (let rank = 1; rank <= maxRank; rank += 1) {
    const y = scaleY(rank);
    body += `<line x1="${plotArea.x}" y1="${y}" x2="${plotArea.x + plotArea.w}" y2="${y}" stroke="${theme.colors.surface}" stroke-width="1" opacity="0.35" />`;
    body += `<text x="${plotArea.x - 12}" y="${y + 4}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="12" text-anchor="end">${rank}</text>`;
  }

  // X labels (weeks).
  const stepX = Math.max(1, Math.ceil(weeks.length / 10));
  weeks.forEach((wk, i) => {
    if (i % stepX !== 0 && i !== weeks.length - 1) return;
    const x = scaleX(i);
    body += `<text x="${x}" y="${plotArea.y + plotArea.h + 22}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="12" text-anchor="middle">W${wk}</text>`;
  });

  lines.forEach((line, idx) => {
    const color = palette(theme, idx);
    const pts = line.ranks
      .map((rank, i) => (Number.isFinite(rank) ? `${scaleX(i)},${scaleY(rank)}` : null))
      .filter((p): p is string => p !== null);
    if (pts.length >= 2) {
      body += `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" opacity="0.85" />`;
    }
    line.ranks.forEach((rank, i) => {
      if (!Number.isFinite(rank)) return;
      body += `<circle cx="${scaleX(i)}" cy="${scaleY(rank)}" r="3.5" fill="${color}" />`;
    });
    // Direct end label at the final week.
    const lastIdx = line.ranks.length - 1;
    if (lastIdx >= 0 && Number.isFinite(line.ranks[lastIdx])) {
      const lx = scaleX(lastIdx) + 8;
      const ly = scaleY(line.ranks[lastIdx]) + 4;
      body += `<text x="${lx}" y="${ly}" fill="${color}" font-family="${theme.fonts.body}" font-size="13">${escape(
        line.team,
      )}</text>`;
    }
  });

  body += axisLabels(theme, plotArea, 'Week', 'Standings rank');

  return body;
}

function renderThrowback(
  payload: {
    badge?: string;
    headline: string;
    stats: Array<{ label: string; value: string }>;
  },
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  const cx = width / 2;
  let body = '';
  let y = 240;

  if (payload.badge) {
    body += `<text x="${cx}" y="${y}" fill="${theme.colors.secondary}" font-family="${theme.fonts.heading}" font-size="34" font-weight="bold" text-anchor="middle">${escape(
      truncate(payload.badge, 40),
    )}</text>`;
    y += 84;
  }

  body += `<text x="${cx}" y="${y}" fill="${theme.colors.text}" font-family="${theme.fonts.heading}" font-size="56" font-weight="bold" text-anchor="middle">${escape(
    truncate(payload.headline, 26),
  )}</text>`;
  y += 96;

  // Supporting stats as label (left) / value (right) rows with a hairline divider. Bound the
  // rows to the canvas so a long list (or a smaller caller-supplied size) can't overrun the
  // border and clip against the viewBox.
  const left = 140;
  const right = width - 140;
  const rowH = 78;
  const maxRows = Math.max(0, Math.floor((height - 60 - y) / rowH));
  payload.stats.slice(0, maxRows).forEach((s, i) => {
    const ry = y + i * rowH;
    body += `<text x="${left}" y="${ry}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="26" text-anchor="start">${escape(
      truncate(s.label, 26),
    )}</text>`;
    body += `<text x="${right}" y="${ry}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="30" text-anchor="end">${escape(
      truncate(s.value, 24),
    )}</text>`;
    body += `<line x1="${left}" y1="${ry + 20}" x2="${right}" y2="${ry + 20}" stroke="${theme.colors.surface}" stroke-width="1" opacity="0.6" />`;
  });

  return body;
}

type CheatTone = 'reach' | 'value' | 'wait' | 'fade' | 'neutral';

function renderCheatSheet(
  payload: {
    tiers: Array<{
      label: string;
      players: Array<{
        name: string;
        pos: string;
        adp?: number;
        vor?: number;
        note?: string;
        tone?: CheatTone;
      }>;
    }>;
    fades?: Array<{ name: string; pos: string; reason: string }>;
  },
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  const tiers = payload.tiers ?? [];
  const fades = payload.fades ?? [];
  if (tiers.length === 0 && fades.length === 0) return '';

  const x = 64;
  const w = width - 128;
  const bottom = height - 52;
  const headerH = 40;
  const rowH = 30;

  const toneColor = (tone: CheatTone | undefined): string => {
    switch (tone) {
      case 'reach':
        return theme.colors.secondary;
      case 'value':
        return theme.colors.accent;
      case 'fade':
        return theme.colors.danger;
      case 'wait':
        return theme.colors.muted;
      default:
        return theme.colors.primary;
    }
  };

  const bandHeader = (label: string, y: number): string => {
    let s = `<rect x="${x}" y="${y}" width="${w}" height="32" rx="8" fill="${theme.colors.surface}" opacity="0.7" />`;
    s += `<text x="${x + 14}" y="${y + 22}" fill="${theme.colors.secondary}" font-family="${theme.fonts.heading}" font-size="18" font-weight="bold">${escape(
      label,
    )}</text>`;
    return s;
  };

  const playerRow = (
    p: { name: string; pos: string; adp?: number; vor?: number; note?: string; tone?: CheatTone },
    y: number,
  ): string => {
    const cy = y + rowH / 2;
    const color = toneColor(p.tone);
    let s = `<circle cx="${x + 13}" cy="${cy - 2}" r="5" fill="${color}" />`;
    s += `<text x="${x + 28}" y="${cy + 4}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="17">${escape(
      truncate(p.name, 24),
    )}</text>`;
    if (p.note) {
      s += `<text x="${x + 300}" y="${cy + 4}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="13">${escape(
        truncate(p.note, 34),
      )}</text>`;
    }
    const stats = [
      p.pos,
      typeof p.adp === 'number' ? `ADP ${p.adp}` : '',
      typeof p.vor === 'number' ? `VOR ${signed(p.vor)}` : '',
    ]
      .filter(Boolean)
      .join('  ·  ');
    s += `<text x="${x + w - 12}" y="${cy + 4}" fill="${color}" font-family="${theme.fonts.body}" font-size="14" text-anchor="end">${escape(
      stats,
    )}</text>`;
    return s;
  };

  // Reserve room at the bottom for the fades band so tiers never overwrite it.
  const fadeCount = Math.min(fades.length, 4);
  const reserve = fades.length ? headerH + fadeCount * rowH + 8 : 0;
  const tierFloor = bottom - reserve;

  let body = '';
  let y = 156;
  for (const tier of tiers) {
    if (y + headerH + rowH > tierFloor) break;
    body += bandHeader(tier.label, y);
    y += headerH;
    for (const p of tier.players) {
      if (y + rowH > tierFloor) break;
      body += playerRow(p, y);
      y += rowH;
    }
    y += 8;
  }

  if (fades.length) {
    body += bandHeader('🚫 Fades — priced above their value', y);
    y += headerH;
    for (const f of fades.slice(0, fadeCount)) {
      body += playerRow({ name: f.name, pos: f.pos, note: f.reason, tone: 'fade' }, y);
      y += rowH;
    }
  }

  return body;
}

/** Badge color for a letter grade — green A, blue B, amber C, red D/F. */
function gradeColor(grade: string, theme: typeof DEFAULT_THEME): string {
  switch ((grade[0] ?? '').toUpperCase()) {
    case 'A':
      return theme.colors.accent;
    case 'B':
      return theme.colors.primary;
    case 'C':
      return theme.colors.secondary;
    default:
      return theme.colors.danger;
  }
}

/** Green for value gained vs ADP, red for value spent (a reach), muted at par. */
function valueColor(value: number, theme: typeof DEFAULT_THEME): string {
  if (value > 0) return theme.colors.accent;
  if (value < 0) return theme.colors.danger;
  return theme.colors.muted;
}

/** A Steals / Reaches column: a header, then up to 3 name · pick · signed-value rows. */
function gradeColumn(
  header: string,
  rows: Array<{ playerName: string; overall: number; value?: number; position?: string }>,
  x: number,
  y: number,
  w: number,
  theme: typeof DEFAULT_THEME,
): string {
  let s = `<text x="${x}" y="${y}" fill="${theme.colors.secondary}" font-family="${theme.fonts.heading}" font-size="20" font-weight="bold">${escape(
    header,
  )}</text>`;
  let ry = y + 36;
  if (rows.length === 0) {
    return (
      s +
      `<text x="${x}" y="${ry}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="16">—</text>`
    );
  }
  for (const r of rows.slice(0, 3)) {
    const color = valueColor(r.value ?? 0, theme);
    s += `<text x="${x}" y="${ry}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="18">${escape(
      truncate(r.playerName, 18),
    )}</text>`;
    if (r.value !== undefined) {
      s += `<text x="${x + w}" y="${ry}" fill="${color}" font-family="${theme.fonts.body}" font-size="17" text-anchor="end">${escape(
        signed(r.value),
      )}</text>`;
    }
    s += `<text x="${x}" y="${ry + 18}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="13">${escape(
      `pick ${r.overall}${r.position ? ` · ${r.position}` : ''}`,
    )}</text>`;
    ry += 48;
  }
  return s;
}

function renderGrade(
  payload: {
    grade: string;
    score: number;
    valueScore: number;
    starters: { filled: number; required: number; missing: string[] };
    byPosition: Array<{ pos: string; count: number; avgValue: number }>;
    steals: Array<{ playerName: string; overall: number; value?: number; position?: string }>;
    reaches: Array<{ playerName: string; overall: number; value?: number; position?: string }>;
    footer?: string;
  },
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  const cx = width / 2;
  const inner = { x: 72, w: width - 144 };
  const bottom = height - 48;

  // Hero: a bold grade badge with the value/score/starters headline beneath it.
  const badgeW = 240;
  const badgeH = 210;
  const badgeY = 172;
  const gColor = gradeColor(payload.grade, theme);
  let body = `<rect x="${cx - badgeW / 2}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="26" fill="${gColor}" />`;
  body += `<text x="${cx}" y="${badgeY + badgeH / 2 + 48}" fill="${theme.colors.background}" font-family="${theme.fonts.heading}" font-size="132" font-weight="bold" text-anchor="middle">${escape(
    payload.grade,
  )}</text>`;

  const headlineY = badgeY + badgeH + 52;
  const headline = `value ${signed(payload.valueScore)}   ·   score ${signed(payload.score)}   ·   starters ${payload.starters.filled}/${payload.starters.required}`;
  body += `<text x="${cx}" y="${headlineY}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="27" text-anchor="middle">${escape(
    headline,
  )}</text>`;

  let y = headlineY + 40;
  body += `<line x1="${inner.x}" y1="${y}" x2="${inner.x + inner.w}" y2="${y}" stroke="${theme.colors.surface}" stroke-width="1.5" />`;
  y += 44;

  // Per-position value bars (bar length ∝ picks drafted, color ∝ mean value).
  if (payload.byPosition.length) {
    body += `<text x="${inner.x}" y="${y}" fill="${theme.colors.muted}" font-family="${theme.fonts.heading}" font-size="18" font-weight="bold">By position</text>`;
    y += 34;
    const maxCount = Math.max(1, ...payload.byPosition.map((p) => p.count));
    const labelW = 150;
    const valW = 110;
    const barX = inner.x + labelW;
    const barMaxW = inner.w - labelW - valW;
    const rowH = 44;
    const barH = 22;
    for (const bar of payload.byPosition) {
      const rowCy = y + rowH / 2;
      const color = valueColor(bar.avgValue, theme);
      body += `<text x="${inner.x}" y="${rowCy + 6}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="19">${escape(
        `${bar.pos} ×${bar.count}`,
      )}</text>`;
      body += `<rect x="${barX}" y="${rowCy - barH / 2}" width="${barMaxW}" height="${barH}" rx="6" fill="${theme.colors.surface}" opacity="0.5" />`;
      const barW = Math.max(3, (bar.count / maxCount) * barMaxW);
      body += `<rect x="${barX}" y="${rowCy - barH / 2}" width="${barW}" height="${barH}" rx="6" fill="${color}" opacity="0.9" />`;
      body += `<text x="${inner.x + inner.w}" y="${rowCy + 6}" fill="${color}" font-family="${theme.fonts.body}" font-size="18" text-anchor="end">${escape(
        signed(bar.avgValue),
      )}</text>`;
      y += rowH;
    }
    y += 34;
  }

  // Steals and Reaches, side by side.
  const colGap = 40;
  const colW = (inner.w - colGap) / 2;
  body += gradeColumn('💎 Steals', payload.steals, inner.x, y, colW, theme);
  body += gradeColumn('🟧 Reaches', payload.reaches, inner.x + colW + colGap, y, colW, theme);

  // Unfilled-starter warning + footer small print, pinned to the bottom.
  let footY = bottom;
  if (payload.footer) {
    body += `<text x="${cx}" y="${footY}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="14" text-anchor="middle">${escape(
      payload.footer,
    )}</text>`;
    footY -= 26;
  }
  if (payload.starters.missing.length) {
    body += `<text x="${cx}" y="${footY}" fill="${theme.colors.danger}" font-family="${theme.fonts.body}" font-size="16" text-anchor="middle">${escape(
      `Unfilled starters: ${payload.starters.missing.join(', ')}`,
    )}</text>`;
  }

  return body;
}

function renderLotteryOdds(
  payload: {
    rows: Array<{ team: string; balls: number; firstPct: number; top3Pct: number }>;
  },
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  const rows = payload.rows ?? [];
  if (rows.length === 0) return '';

  const x = 64;
  const w = width - 128;
  const top = 168;
  const bottom = height - 60;
  const headerH = 34;
  const rowH = Math.min(66, (bottom - top - headerH) / rows.length);

  // Right-anchored numeric columns; the ball bar fills the gap between name and numbers.
  const ballsEnd = x + w - 320;
  const firstEnd = x + w - 160;
  const top3End = x + w;
  const barX = x + Math.min(320, w * 0.32);
  const barMaxW = ballsEnd - barX - 90;
  const maxBalls = Math.max(1, ...rows.map((r) => r.balls));

  const headerStyle = `fill="${theme.colors.muted}" font-family="${theme.fonts.heading}" font-size="15" font-weight="bold"`;
  const hy = top + headerH - 12;
  let body = '';
  body += `<text x="${x}" y="${hy}" ${headerStyle}>TEAM</text>`;
  body += `<text x="${ballsEnd}" y="${hy}" ${headerStyle} text-anchor="end">BALLS</text>`;
  body += `<text x="${firstEnd}" y="${hy}" ${headerStyle} text-anchor="end">#1 PICK</text>`;
  body += `<text x="${top3End}" y="${hy}" ${headerStyle} text-anchor="end">TOP 3</text>`;

  rows.forEach((r, idx) => {
    const rowTop = top + headerH + idx * rowH;
    const cy = rowTop + rowH / 2;
    if (idx % 2 === 0) {
      body += `<rect x="${x - 12}" y="${rowTop}" width="${w + 24}" height="${rowH}" rx="8" fill="${theme.colors.surface}" opacity="0.45" />`;
    }
    body += `<text x="${x}" y="${cy + 6}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="20">${escape(
      truncate(r.team, 22),
    )}</text>`;
    const barH = Math.min(16, rowH * 0.35);
    const barW = Math.max(3, (r.balls / maxBalls) * barMaxW);
    body += `<rect x="${barX}" y="${cy - barH / 2}" width="${barW}" height="${barH}" rx="4" fill="${theme.colors.primary}" opacity="0.85" />`;
    body += `<text x="${ballsEnd}" y="${cy + 6}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="19" text-anchor="end">${r.balls}</text>`;
    body += `<text x="${firstEnd}" y="${cy + 6}" fill="${theme.colors.secondary}" font-family="${theme.fonts.body}" font-size="19" text-anchor="end">${pct(
      r.firstPct,
    )}</text>`;
    body += `<text x="${top3End}" y="${cy + 6}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="19" text-anchor="end">${pct(
      r.top3Pct,
    )}</text>`;
  });

  return body;
}

/**
 * Chip strip of the teams still waiting on a pick, pinned above the card's bottom
 * border. Flow-wraps up to two rows and collapses overflow into a "+N more" chip so any
 * team count stays inside the frame.
 */
function remainingStrip(
  remaining: string[],
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  if (remaining.length === 0) return '';

  const x = 80;
  const wContent = width - 160;
  const chipH = 30;
  const gap = 10;
  const rowGap = 8;
  const maxRows = 2;
  const labelY = height - 152;
  const chipTop = height - 138;

  let body = `<text x="${x}" y="${labelY}" fill="${theme.colors.muted}" font-family="${theme.fonts.heading}" font-size="14" font-weight="bold">STILL IN THE HOPPER — ${remaining.length}</text>`;

  const chip = (label: string, cx2: number, cy2: number, chipW: number): string => {
    let s = `<rect x="${cx2}" y="${cy2}" width="${chipW}" height="${chipH}" rx="15" fill="${theme.colors.surface}" opacity="0.9" />`;
    s += `<text x="${cx2 + chipW / 2}" y="${cy2 + chipH / 2 + 5}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="14" text-anchor="middle">${escape(
      label,
    )}</text>`;
    return s;
  };
  // No text measurement in SVG generation — estimate chip width from character count.
  const chipWidth = (label: string): number => Math.min(wContent, label.length * 8.5 + 26);

  // Keep room on the final row for a "+N more" chip so it never overlaps placed chips.
  const moreReserve = chipWidth('+99 more') + gap;
  let cx = x;
  let row = 0;
  for (let i = 0; i < remaining.length; i += 1) {
    const label = truncate(remaining[i], 16);
    const cw = chipWidth(label);
    const lastRow = row === maxRows - 1;
    const hasMoreAfter = i < remaining.length - 1;
    const limit = x + wContent - (lastRow && hasMoreAfter ? moreReserve : 0);
    if (cx + cw > limit) {
      if (lastRow) {
        const more = `+${remaining.length - i} more`;
        body += chip(more, cx, chipTop + row * (chipH + rowGap), chipWidth(more));
        return body;
      }
      row += 1;
      cx = x;
    }
    body += chip(label, cx, chipTop + row * (chipH + rowGap), cw);
    cx += cw + gap;
  }
  return body;
}

function renderLotteryReveal(
  payload: {
    phase: 'beat' | 'reveal';
    pick: number;
    remaining: string[];
    team?: string;
    balls?: number;
    oddsPct?: number;
  },
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  const cx = width / 2;
  let body = '';

  if (payload.phase === 'beat') {
    // Drum-roll frame: the pick number looms, no team yet.
    body += `<text x="${cx}" y="252" fill="${theme.colors.secondary}" font-family="${theme.fonts.heading}" font-size="28" font-weight="bold" text-anchor="middle" letter-spacing="6">REVEALING PICK</text>`;
    body += `<text x="${cx}" y="408" fill="${theme.colors.text}" font-family="${theme.fonts.heading}" font-size="150" font-weight="bold" text-anchor="middle">#${payload.pick}</text>`;
    body += `<text x="${cx}" y="466" fill="${theme.colors.muted}" font-family="${theme.fonts.heading}" font-size="34" text-anchor="middle">• • •</text>`;
  } else {
    body += `<text x="${cx}" y="240" fill="${theme.colors.secondary}" font-family="${theme.fonts.heading}" font-size="26" font-weight="bold" text-anchor="middle" letter-spacing="6">PICK #${payload.pick} GOES TO</text>`;
    body += `<text x="${cx}" y="340" fill="${theme.colors.text}" font-family="${theme.fonts.heading}" font-size="68" font-weight="bold" text-anchor="middle">${escape(
      truncate(payload.team ?? '', 20),
    )}</text>`;
    body += `<rect x="${cx - 180}" y="362" width="360" height="5" rx="2.5" fill="${theme.colors.secondary}" />`;
    const balls = payload.balls ?? 0;
    const stats = `held ${balls} ${balls === 1 ? 'ball' : 'balls'} · ${pct(payload.oddsPct ?? 0)} odds`;
    body += `<text x="${cx}" y="420" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="25" text-anchor="middle">${escape(
      stats,
    )}</text>`;
  }

  body += remainingStrip(payload.remaining ?? [], theme, width, height);
  return body;
}

function renderLotteryBoard(
  payload: {
    entries: Array<{ pick: number; team: string; balls?: number; oddsPct?: number }>;
  },
  theme: typeof DEFAULT_THEME,
  width: number,
  height: number,
): string {
  const entries = payload.entries ?? [];
  if (entries.length === 0) return '';

  const x = 72;
  const w = width - 144;
  const top = 168;
  const bottom = height - 56;
  const rowH = Math.min(72, (bottom - top) / entries.length);
  const r = Math.min(24, rowH * 0.38);

  let body = '';
  entries.forEach((e, idx) => {
    const cy = top + idx * rowH + rowH / 2;
    // Pick 1 gets the gold badge — everyone else the quiet surface chip.
    const badgeFill = idx === 0 ? theme.colors.secondary : theme.colors.surface;
    const numColor = idx === 0 ? theme.colors.background : theme.colors.text;
    body += `<circle cx="${x + r}" cy="${cy}" r="${r}" fill="${badgeFill}" />`;
    body += `<text x="${x + r}" y="${cy + 7}" fill="${numColor}" font-family="${theme.fonts.heading}" font-size="${Math.round(
      r * 0.95,
    )}" font-weight="bold" text-anchor="middle">${e.pick}</text>`;
    body += `<text x="${x + r * 2 + 18}" y="${cy + 8}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="26"${
      idx === 0 ? ' font-weight="bold"' : ''
    }>${escape(truncate(e.team, 24))}</text>`;
    const note = [
      typeof e.balls === 'number' ? `${e.balls} ${e.balls === 1 ? 'ball' : 'balls'}` : '',
      typeof e.oddsPct === 'number' ? `${pct(e.oddsPct)} odds` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (note) {
      body += `<text x="${x + w}" y="${cy + 6}" fill="${theme.colors.muted}" font-family="${theme.fonts.body}" font-size="16" text-anchor="end">${escape(
        note,
      )}</text>`;
    }
    if (idx < entries.length - 1) {
      body += `<line x1="${x}" y1="${cy + rowH / 2}" x2="${x + w}" y2="${cy + rowH / 2}" stroke="${theme.colors.surface}" stroke-width="1" opacity="0.6" />`;
    }
  });

  return body;
}

/** Format a percent (0–100) for display, one decimal. */
function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

/** Format a VOR-style number with an explicit sign, one decimal. */
function signed(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function axisLabels(
  theme: typeof DEFAULT_THEME,
  plotArea: { x: number; y: number; w: number; h: number },
  xLabel: string,
  yLabel: string,
): string {
  const x = plotArea.x + plotArea.w / 2;
  const y = plotArea.y + plotArea.h + 40;
  const lx = `<text x="${x}" y="${y}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="16" text-anchor="middle">${escape(
    xLabel,
  )}</text>`;
  const ly = `<text x="${plotArea.x - 50}" y="${plotArea.y + plotArea.h / 2}" fill="${theme.colors.text}" font-family="${theme.fonts.body}" font-size="16" text-anchor="middle" transform="rotate(-90 ${plotArea.x - 50} ${
    plotArea.y + plotArea.h / 2
  })">${escape(yLabel)}</text>`;
  return lx + ly;
}

function palette(theme: typeof DEFAULT_THEME, idx: number): string {
  const palette = [
    theme.colors.primary,
    theme.colors.secondary,
    theme.colors.accent,
    theme.colors.danger,
    '#4ECDC4',
    '#FF6B6B',
    '#FFD166',
    '#06D6A0',
  ];
  return palette[idx % palette.length];
}

function niceStep(max: number, targetTicks: number): number {
  if (max <= 0) return 1;
  const rough = max / Math.max(1, targetTicks);
  const pow10 = 10 ** Math.floor(Math.log10(rough));
  const options = [1, 2, 5, 10].map((m) => m * pow10);
  return options.find((o) => o >= rough) ?? options[options.length - 1];
}
