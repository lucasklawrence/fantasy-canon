import { InMemoryLeagueConfigRepo } from '../leagueConfigRepo.js';

describe('InMemoryLeagueConfigRepo', () => {
  it('upserts and retrieves guild configs', async () => {
    const repo = new InMemoryLeagueConfigRepo();
    const config = {
      guildId: 'guild-123',
      leagueId: 'league-9',
      startSeason: 2020,
      endSeason: 2025,
      timezone: 'America/Los_Angeles',
      postChannelId: 'channel-1',
    };

    await repo.upsert(config);
    const stored = await repo.getByGuildId('guild-123');

    expect(stored).toEqual(config);
  });
});
