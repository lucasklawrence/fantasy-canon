/**
 * In-memory cache of league team (and manager) names, keyed by league + season.
 *
 * Discord autocomplete must respond within 3s and cannot be deferred, so suggestions
 * cannot come from a live ESPN fetch. This cache is populated opportunistically whenever
 * a command fetches an `mTeam` snapshot (including `/canon admin ingest`); the autocomplete
 * handler reads *only* from here and never touches the network on a keystroke.
 *
 * The cache is purely additive and process-local — it mirrors snapshot data we already
 * hold, so a cold cache simply yields no suggestions (graceful) rather than an error.
 */

export interface TeamChoice {
  /** ESPN team id (the value used to resolve the opponent in the command handler). */
  teamId: number;
  /** Best-available team name, e.g. "Team Touchdown". */
  teamName: string;
  /** Manager display name when known, e.g. "Mike R.". */
  managerName?: string;
  /** Autocomplete label, e.g. "Team Touchdown (Mike R.)" or just the team name. */
  label: string;
}

/** Discord caps a single autocomplete response at 25 choices. */
export const MAX_AUTOCOMPLETE_CHOICES = 25;

/** Build the display label for a team/manager pair. */
export function buildChoiceLabel(teamName: string, managerName?: string): string {
  const name = teamName.trim() || 'Team';
  const manager = managerName?.trim();
  return manager && manager !== name ? `${name} (${manager})` : name;
}

export class TeamNameCache {
  private readonly byLeagueSeason = new Map<string, TeamChoice[]>();

  /** Replace the cached choices for one league + season. */
  set(leagueId: string, season: number, choices: TeamChoice[]): void {
    this.byLeagueSeason.set(this.key(leagueId, season), choices);
  }

  /** Cached choices for a specific league + season (empty if none). */
  get(leagueId: string, season: number): TeamChoice[] {
    return this.byLeagueSeason.get(this.key(leagueId, season)) ?? [];
  }

  /**
   * Union of every cached season for a league, deduped by team id (the most recently
   * inserted season's entry wins). Used when the user hasn't picked a season yet.
   */
  getAllForLeague(leagueId: string): TeamChoice[] {
    const prefix = `${leagueId}::`;
    const merged = new Map<number, TeamChoice>();
    for (const [key, choices] of this.byLeagueSeason) {
      if (!key.startsWith(prefix)) continue;
      for (const choice of choices) merged.set(choice.teamId, choice);
    }
    return Array.from(merged.values());
  }

  private key(leagueId: string, season: number): string {
    return `${leagueId}::${season}`;
  }
}

/**
 * Filter team choices by a case-insensitive substring over team and manager name,
 * capped at {@link MAX_AUTOCOMPLETE_CHOICES}. An empty/blank query returns the first
 * N choices so the menu is useful before the user types.
 */
export function filterTeamChoices(
  choices: TeamChoice[],
  query: string,
  limit: number = MAX_AUTOCOMPLETE_CHOICES,
): TeamChoice[] {
  const q = query.trim().toLowerCase();
  const matches = q
    ? choices.filter(
        (c) =>
          c.teamName.toLowerCase().includes(q) ||
          (c.managerName?.toLowerCase().includes(q) ?? false),
      )
    : choices;
  return matches.slice(0, limit);
}
