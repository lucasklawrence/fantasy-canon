export function formatTeamName(
  team: { location?: unknown; nickname?: unknown; name?: unknown; abbrev?: unknown },
  teamId: number,
): string {
  const location = typeof team.location === 'string' ? team.location : '';
  const nickname = typeof team.nickname === 'string' ? team.nickname : '';
  const nameField = typeof team.name === 'string' ? team.name : '';
  const abbrev = typeof team.abbrev === 'string' ? team.abbrev : '';
  if (location || nickname) return `${location} ${nickname}`.trim();
  if (nameField) return nameField;
  if (abbrev) return abbrev;
  return `Team ${teamId}`;
}

export function buildTeamNameMap(payload: unknown): Map<number, string> {
  const map = new Map<number, string>();
  if (!payload || typeof payload !== 'object') return map;
  const maybeTeams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(maybeTeams)) return map;

  for (const team of maybeTeams) {
    if (!team || typeof team !== 'object') continue;
    const t = team as {
      id?: unknown;
      location?: unknown;
      nickname?: unknown;
      name?: unknown;
      abbrev?: unknown;
    };
    const teamId = Number(t.id);
    if (!Number.isFinite(teamId)) continue;
    map.set(teamId, formatTeamName(t, teamId));
  }
  return map;
}

/**
 * Per-team logo URLs from an `mTeam` payload (#242). ESPN carries a `logo` URL on each team —
 * user-uploaded or one of ESPN's stock images. http(s) only: the URL ends up fetched by the
 * Activity backend's image proxy, so a `javascript:`/`data:` value must never get that far, and
 * anything else (blank, malformed, not a string) simply means "no logo" — the ceremony renders
 * the plain hue ball exactly as before.
 */
export function buildTeamLogoMap(payload: unknown): Map<number, string> {
  const map = new Map<number, string>();
  if (!payload || typeof payload !== 'object') return map;
  const maybeTeams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(maybeTeams)) return map;

  for (const team of maybeTeams) {
    if (!team || typeof team !== 'object') continue;
    const t = team as { id?: unknown; logo?: unknown };
    const teamId = Number(t.id);
    if (!Number.isFinite(teamId)) continue;
    if (typeof t.logo !== 'string') continue;
    const logo = t.logo.trim();
    if (!/^https?:\/\//i.test(logo)) continue;
    map.set(teamId, logo);
  }
  return map;
}
