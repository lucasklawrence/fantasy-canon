/**
 * Weekly trophies — the banter engine. Given one week's head-to-head matchups
 * (and, optionally, projected points and optimal-lineup percentages), pick the
 * team that earns each award. The ~10-category set is the research-backed one
 * (docs/14-data-surfacing-research.md §2, §5; GameDayBot), not the narrower
 * 4-category version.
 *
 * Pure and deterministic: no I/O. Six categories come from matchup scores alone
 * and are always computed; four depend on extra data (projected points,
 * optimal-lineup %) and are emitted only when that data is supplied — so the
 * engine is complete now and the remaining trophies light up for free once
 * their ESPN extractors land. Ties in `teamId` break to the lower id for stable
 * output.
 */

export interface TrophyTeamScore {
  teamId: number;
  /** Points the team scored that week. */
  score: number;
}

export interface TrophyMatchup {
  home: TrophyTeamScore;
  away: TrophyTeamScore;
}

export interface TrophyExtras {
  /** Projected points per teamId — enables Overachiever / Underachiever. */
  projected?: ReadonlyMap<number, number>;
  /** Optimal-lineup % (0..1) per teamId — enables Best / Worst Manager. */
  optimalPct?: ReadonlyMap<number, number>;
}

export type TrophyKey =
  | 'high-score'
  | 'low-score'
  | 'blowout'
  | 'closest'
  | 'luckiest'
  | 'unluckiest'
  | 'overachiever'
  | 'underachiever'
  | 'best-manager'
  | 'worst-manager';

export interface Trophy {
  key: TrophyKey;
  emoji: string;
  label: string;
  teamId: number;
  /** The numeric the award ranks on (points, margin, %, or delta). */
  value: number;
  /** Short human-readable detail, e.g. "142.3 pts" or "won by 1.2". */
  detail: string;
}

interface Candidate {
  teamId: number;
  value: number;
}

/** Highest value wins; ties break to the lower teamId. Null if no candidates. */
function pickMax(candidates: Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (!best || c.value > best.value || (c.value === best.value && c.teamId < best.teamId)) {
      best = c;
    }
  }
  return best;
}

/** Lowest value wins; ties break to the lower teamId. Null if no candidates. */
function pickMin(candidates: Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (!best || c.value < best.value || (c.value === best.value && c.teamId < best.teamId)) {
      best = c;
    }
  }
  return best;
}

const pts = (n: number): string => n.toFixed(1);

/**
 * Compute the weekly trophies from a single week's matchups.
 *
 * Always emitted (from scores alone): High score 👑, Low score 💩, Biggest
 * blowout 😱, Closest win 😅, Luckiest 🍀 (the lowest-scoring winner — won
 * despite scoring low), Unluckiest 😡 (the highest-scoring loser).
 *
 * Emitted when the matching extra is provided: Overachiever 📈 / Underachiever
 * 📉 (actual − projected) and Best 🤖 / Worst 🤡 Manager (optimal-lineup %).
 *
 * Categories with no eligible team (e.g. every matchup tied → no Closest win)
 * are omitted. The result is ordered by the canonical category order above.
 */
export function computeWeeklyTrophies(
  matchups: TrophyMatchup[],
  extras: TrophyExtras = {},
): Trophy[] {
  const sides: TrophyTeamScore[] = [];
  const winners: Candidate[] = [];
  const losers: Candidate[] = [];
  const margins: Array<{ winnerId: number; margin: number }> = [];

  for (const m of matchups) {
    sides.push(m.home, m.away);
    if (m.home.score === m.away.score) continue; // tie → no winner/loser/margin
    const [hi, lo] = m.home.score > m.away.score ? [m.home, m.away] : [m.away, m.home];
    winners.push({ teamId: hi.teamId, value: hi.score });
    losers.push({ teamId: lo.teamId, value: lo.score });
    margins.push({ winnerId: hi.teamId, margin: hi.score - lo.score });
  }

  const trophies: Trophy[] = [];
  const scores: Candidate[] = sides.map((s) => ({ teamId: s.teamId, value: s.score }));

  const high = pickMax(scores);
  if (high) {
    trophies.push({
      key: 'high-score',
      emoji: '👑',
      label: 'High Score',
      teamId: high.teamId,
      value: high.value,
      detail: `${pts(high.value)} pts`,
    });
  }

  const low = pickMin(scores);
  if (low) {
    trophies.push({
      key: 'low-score',
      emoji: '💩',
      label: 'Low Score',
      teamId: low.teamId,
      value: low.value,
      detail: `${pts(low.value)} pts`,
    });
  }

  const marginCands = margins.map((m) => ({ teamId: m.winnerId, value: m.margin }));
  const blowout = pickMax(marginCands);
  if (blowout) {
    trophies.push({
      key: 'blowout',
      emoji: '😱',
      label: 'Biggest Blowout',
      teamId: blowout.teamId,
      value: blowout.value,
      detail: `won by ${pts(blowout.value)}`,
    });
  }

  const closest = pickMin(marginCands);
  if (closest) {
    trophies.push({
      key: 'closest',
      emoji: '😅',
      label: 'Closest Win',
      teamId: closest.teamId,
      value: closest.value,
      detail: `won by ${pts(closest.value)}`,
    });
  }

  // Luckiest: the lowest-scoring team that still won its matchup.
  const luckiest = pickMin(winners);
  if (luckiest) {
    trophies.push({
      key: 'luckiest',
      emoji: '🍀',
      label: 'Luckiest',
      teamId: luckiest.teamId,
      value: luckiest.value,
      detail: `won with just ${pts(luckiest.value)}`,
    });
  }

  // Unluckiest: the highest-scoring team that still lost its matchup.
  const unluckiest = pickMax(losers);
  if (unluckiest) {
    trophies.push({
      key: 'unluckiest',
      emoji: '😡',
      label: 'Unluckiest',
      teamId: unluckiest.teamId,
      value: unluckiest.value,
      detail: `lost with ${pts(unluckiest.value)}`,
    });
  }

  if (extras.projected && extras.projected.size > 0) {
    const deltas: Candidate[] = [];
    for (const s of sides) {
      const proj = extras.projected.get(s.teamId);
      if (proj !== undefined) deltas.push({ teamId: s.teamId, value: s.score - proj });
    }
    const over = pickMax(deltas);
    if (over) {
      trophies.push({
        key: 'overachiever',
        emoji: '📈',
        label: 'Overachiever',
        teamId: over.teamId,
        value: over.value,
        detail: `${over.value >= 0 ? '+' : ''}${pts(over.value)} vs projected`,
      });
    }
    const under = pickMin(deltas);
    if (under) {
      trophies.push({
        key: 'underachiever',
        emoji: '📉',
        label: 'Underachiever',
        teamId: under.teamId,
        value: under.value,
        detail: `${under.value >= 0 ? '+' : ''}${pts(under.value)} vs projected`,
      });
    }
  }

  if (extras.optimalPct && extras.optimalPct.size > 0) {
    const pcts: Candidate[] = [];
    for (const s of sides) {
      const pct = extras.optimalPct.get(s.teamId);
      if (pct !== undefined) pcts.push({ teamId: s.teamId, value: pct });
    }
    const best = pickMax(pcts);
    if (best) {
      trophies.push({
        key: 'best-manager',
        emoji: '🤖',
        label: 'Best Manager',
        teamId: best.teamId,
        value: best.value,
        detail: `${Math.round(best.value * 100)}% optimal`,
      });
    }
    const worst = pickMin(pcts);
    if (worst) {
      trophies.push({
        key: 'worst-manager',
        emoji: '🤡',
        label: 'Worst Manager',
        teamId: worst.teamId,
        value: worst.value,
        detail: `${Math.round(worst.value * 100)}% optimal`,
      });
    }
  }

  return trophies;
}
