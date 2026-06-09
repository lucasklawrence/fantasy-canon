import { GuildLeagueConfig } from '@fantasy-canon/shared';

export interface LeagueConfigRepo {
  upsert(config: GuildLeagueConfig): Promise<GuildLeagueConfig>;
  getByGuildId(guildId: string): Promise<GuildLeagueConfig | undefined>;
}

export class InMemoryLeagueConfigRepo implements LeagueConfigRepo {
  private readonly configs = new Map<string, GuildLeagueConfig>();

  upsert(config: GuildLeagueConfig): Promise<GuildLeagueConfig> {
    this.configs.set(config.guildId, config);
    return Promise.resolve(config);
  }

  getByGuildId(guildId: string): Promise<GuildLeagueConfig | undefined> {
    return Promise.resolve(this.configs.get(guildId));
  }
}
