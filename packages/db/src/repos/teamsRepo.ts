import { SeasonYear } from "@fantasy-canon/shared";

export interface TeamRecord {
  season: SeasonYear;
  teamId: number;
  name: string;
  owners?: string[];
  pointsFor?: number;
  pointsAgainst?: number;
}

export class TeamsRepo {
  private readonly teams = new Map<string, TeamRecord>();

  upsertTeams(teams: TeamRecord[]): Promise<void> {
    teams.forEach((team) => {
      const key = `${team.season}-${team.teamId}`;
      this.teams.set(key, team);
    });
    return Promise.resolve();
  }
}
