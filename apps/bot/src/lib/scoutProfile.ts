/**
 * Pure formatting of an opponent "scouting report" from already-extracted team stats.
 *
 * Reuses the same tendency signals as the public storyline commands — record, home/away
 * split, current streak, and manager archetype — but focused on a single opponent and
 * computed relative to the rest of the league (archetype needs league averages). No I/O.
 */

import { TeamInfo } from './teamStats.js';
import { RosterPlayer } from './roster.js';
import { classifyArchetype } from './archetype.js';

function winPct(wins: number, losses: number): number {
  const total = wins + losses;
  return total === 0 ? 0 : wins / total;
}

function streakLine(team: TeamInfo): string {
  if (team.streakLength <= 0 || !team.streakType) return 'Streak: none';
  const kind = team.streakType === 'WIN' ? 'W' : team.streakType === 'LOSS' ? 'L' : team.streakType;
  return `Streak: ${kind}${team.streakLength}`;
}

function rosterLines(roster: RosterPlayer[]): string[] {
  if (roster.length === 0) return ['Roster: unavailable'];
  const fmt = (p: RosterPlayer): string => `${p.position} ${p.name}`;
  const starters = roster.filter((p) => p.starting);
  const bench = roster.filter((p) => !p.starting);
  const lines = ['Roster:'];
  if (starters.length > 0) lines.push(`  Starters: ${starters.map(fmt).join(', ')}`);
  if (bench.length > 0) lines.push(`  Bench: ${bench.map(fmt).join(', ')}`);
  return lines;
}

export interface ScoutProfileInput {
  team: TeamInfo;
  allTeams: TeamInfo[];
  teamName: string;
  managerName?: string;
  roster: RosterPlayer[];
  season: number;
  leagueLabel: string;
}

/**
 * Build the multi-line ephemeral scouting report. Pure: returns the lines; the caller joins
 * and replies.
 */
export function buildScoutProfile(input: ScoutProfileInput): string[] {
  const { team, allTeams, teamName, managerName, roster, season, leagueLabel } = input;
  const heading = managerName ? `${teamName} (${managerName})` : teamName;
  const record =
    team.ties > 0 ? `${team.wins}-${team.losses}-${team.ties}` : `${team.wins}-${team.losses}`;
  const archetype = classifyArchetype(team, allTeams);
  const homePct = (winPct(team.homeWins, team.homeLosses) * 100).toFixed(0);
  const awayPct = (winPct(team.awayWins, team.awayLosses) * 100).toFixed(0);

  const lines = [
    `League ${leagueLabel} • Season ${season} • Scout`,
    heading,
    `Record: ${record} • PF ${team.pointsFor.toFixed(1)} • PA ${team.pointsAgainst.toFixed(1)}`,
    `Home ${homePct}% (${team.homeWins}-${team.homeLosses}) / Away ${awayPct}% (${team.awayWins}-${team.awayLosses})`,
    streakLine(team),
    `Archetype: ${archetype.label} (${archetype.detail})`,
    `Trade block: ${team.tradeBlockOn} on the block, ${team.tradeBlockUntouchable} untouchable`,
    ...rosterLines(roster),
  ];
  return lines;
}
