export type SeasonYear = number;

export interface LeagueIdentifiers {
  leagueId: string;
  season: SeasonYear;
}

export interface EnvConfig {
  discordToken: string;
  discordAppId: string;
  databaseUrl?: string;
  defaultLeagueId?: string;
}

export interface LeagueConfig {
  leagueId: string;
  startSeason?: SeasonYear;
  endSeason?: SeasonYear;
}

export interface SnapshotMeta extends LeagueIdentifiers {
  view: string;
  fetchedAt: Date;
}

export interface GuildLeagueConfig extends LeagueConfig {
  guildId: string;
  postChannelId?: string;
  timezone?: string;
}

export interface SnapshotEnvelope {
  meta: SnapshotMeta;
  payload: unknown;
}
