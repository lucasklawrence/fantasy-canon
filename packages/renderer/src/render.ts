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

export function renderCard(options: RenderSpec): Promise<Buffer> {
  return renderImage(options);
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
