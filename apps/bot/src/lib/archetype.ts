/**
 * Manager archetype classification — the single source of truth shared by
 * `/canon manager-archetypes` (storylines) and the opponent scout report.
 *
 * A team is labelled by which transaction tendency most exceeds the league
 * average — Wire Addict (acquisitions), Lineup Tinkerer (lineup moves), or IR
 * Surgeon (IR moves) — unless it transacts well below average overall, in which
 * case it's a Minimalist. Pure: no I/O. Defined over the minimal stat surface so
 * any caller with these four counts can use it without coupling to a fuller type.
 */

export interface ArchetypeStats {
  acquisitions: number;
  moves: number;
  movesToIr: number;
  totalMoves: number;
}

function ratio(value: number, baseline: number): number {
  if (!Number.isFinite(baseline) || baseline === 0) {
    return Number.isFinite(value) ? value : 0;
  }
  return value / baseline;
}

export interface Archetype {
  label: 'Wire Addict' | 'Lineup Tinkerer' | 'IR Surgeon' | 'Minimalist';
  /** Short supporting stat, e.g. "adds 14" or "lineup moves 9". */
  detail: string;
}

/**
 * Classify a team's manager archetype relative to the league averages.
 * `allTeams` supplies the baselines (averages of each count). Ties between
 * tendencies resolve in declaration order (Wire Addict → Lineup Tinkerer → IR
 * Surgeon). A team whose total moves are below half the league average is a
 * Minimalist regardless of its leading tendency.
 */
export function classifyArchetype(team: ArchetypeStats, allTeams: ArchetypeStats[]): Archetype {
  const avg = (field: keyof ArchetypeStats): number => {
    if (allTeams.length === 0) return 0;
    const total = allTeams.reduce((acc, t) => acc + (t[field] ?? 0), 0);
    return total / allTeams.length;
  };

  const ratios = [
    { key: 'Wire Addict' as const, score: ratio(team.acquisitions, avg('acquisitions')) },
    { key: 'Lineup Tinkerer' as const, score: ratio(team.moves, avg('moves')) },
    { key: 'IR Surgeon' as const, score: ratio(team.movesToIr, avg('movesToIr')) },
  ];
  const best = [...ratios].sort((a, b) => b.score - a.score)[0];
  const minimalist = ratio(team.totalMoves, avg('totalMoves')) < 0.5;
  const label: Archetype['label'] = minimalist ? 'Minimalist' : best.key;

  const detail =
    label === 'Minimalist'
      ? `total moves ${team.totalMoves}`
      : label === 'Wire Addict'
        ? `adds ${team.acquisitions}`
        : label === 'Lineup Tinkerer'
          ? `lineup moves ${team.moves}`
          : `IR moves ${team.movesToIr}`;

  return { label, detail };
}
