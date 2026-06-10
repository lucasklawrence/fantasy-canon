/**
 * Resolve manager (member) display names from an ESPN `mTeam` payload, keyed by team id.
 *
 * ESPN stores managers in a top-level `members[]` array (id → displayName / nickname /
 * first+last) and links each team to its owner(s) via `team.primaryOwner` / `team.owners[]`
 * (member SWID strings). We join the two so a team id maps to a human name. Falls back to
 * owner metadata embedded on the team entry when the members list is unavailable.
 *
 * Mirrors the join already used by `/canon legacy managers`; extracted here so the scout
 * command (and future commands) can reuse it.
 */

export type ManagerOwnerFields = {
  id?: unknown;
  owners?: unknown;
  primaryOwner?: unknown;
  owner?: unknown;
};

/** Build a map of member SWID id → display name from the league `members[]` list. */
export function buildOwnerDisplayMap(payload: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!payload || typeof payload !== 'object') return map;
  const members = (payload as { members?: unknown }).members;
  if (!Array.isArray(members)) return map;
  for (const member of members) {
    if (!member || typeof member !== 'object') continue;
    const m = member as {
      id?: unknown;
      displayName?: unknown;
      firstName?: unknown;
      lastName?: unknown;
      nickname?: unknown;
    };
    const id = typeof m.id === 'string' ? m.id : undefined;
    if (!id) continue;
    const dn = typeof m.displayName === 'string' ? m.displayName : undefined;
    const nick = typeof m.nickname === 'string' ? m.nickname : undefined;
    const first = typeof m.firstName === 'string' ? m.firstName : '';
    const last = typeof m.lastName === 'string' ? m.lastName : '';
    const combo = `${first} ${last}`.trim();
    const name = dn || nick || combo || undefined;
    if (name) map.set(id, name);
  }
  return map;
}

/** Best-available manager SWID id for a team, falling back to a synthetic per-team id. */
export function getManagerId(team: ManagerOwnerFields, fallbackId: number): string {
  const primary =
    typeof team.primaryOwner === 'string' && team.primaryOwner ? team.primaryOwner : undefined;
  if (primary) return primary;
  if (Array.isArray(team.owners)) {
    const ownerId = team.owners.find((o) => typeof o === 'string' && o) as string | undefined;
    if (ownerId) return ownerId;
  }
  const owner = typeof team.owner === 'string' && team.owner ? team.owner : undefined;
  if (owner) return owner;
  return `team-${fallbackId}`;
}

/** Pick a displayable manager name from owner metadata embedded on the team entry. */
export function getEmbeddedManagerName(team: ManagerOwnerFields): string | undefined {
  if (Array.isArray(team.owners)) {
    for (const entry of team.owners) {
      if (entry && typeof entry === 'object') {
        const nickname = (entry as { nickname?: unknown }).nickname;
        const first = (entry as { firstName?: unknown }).firstName;
        const last = (entry as { lastName?: unknown }).lastName;
        const combined =
          `${typeof first === 'string' ? first : ''} ${typeof last === 'string' ? last : ''}`.trim();
        if (typeof nickname === 'string' && nickname) return nickname;
        if (combined) return combined;
      }
    }
  }
  return undefined;
}

/**
 * Map team id → manager display name for an `mTeam` payload. Teams without a resolvable
 * manager name are omitted.
 */
export function buildManagerNameMap(payload: unknown): Map<number, string> {
  const result = new Map<number, string>();
  if (!payload || typeof payload !== 'object') return result;
  const teams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(teams)) return result;
  const ownerMap = buildOwnerDisplayMap(payload);
  for (const team of teams) {
    if (!team || typeof team !== 'object') continue;
    const t = team as ManagerOwnerFields;
    const teamId = Number(t.id);
    if (!Number.isFinite(teamId)) continue;
    const managerId = getManagerId(t, teamId);
    const name = ownerMap.get(managerId) ?? getEmbeddedManagerName(t);
    if (name) result.set(teamId, name);
  }
  return result;
}
