import { ChatInputCommandInteraction, MessageFlags, channelMention } from 'discord.js';
import { GuildLeagueConfig } from '@fantasy-canon/shared';
import { BotContext } from '../../config.js';

export async function handleConfigSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: 'Guild-only command. Run this inside a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();
  if (sub === 'show') {
    await showConfig(interaction, context, guildId);
    return;
  }

  if (sub === 'set') {
    await setConfig(interaction, context, guildId);
    return;
  }

  await interaction.reply({
    content: `Unknown config subcommand "${sub}"`,
    flags: MessageFlags.Ephemeral,
  });
}

async function showConfig(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
  guildId: string,
): Promise<void> {
  const existing = await context.leagueConfigRepo.getByGuildId(guildId);
  const leagueId = existing?.leagueId ?? context.env.defaultLeagueId ?? 'not set';
  const seasonRange =
    existing?.startSeason || existing?.endSeason
      ? `${existing?.startSeason ?? '?'}-${existing?.endSeason ?? '?'}`
      : 'not set';
  const channel = existing?.postChannelId ? channelMention(existing.postChannelId) : 'not set';
  const timezone = existing?.timezone ?? 'not set';

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: [
      `League: ${leagueId}`,
      `Seasons: ${seasonRange}`,
      `Channel: ${channel}`,
      `Timezone: ${timezone}`,
    ].join('\n'),
  });
}

async function setConfig(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
  guildId: string,
): Promise<void> {
  const leagueIdInput = interaction.options.getString('leagueid') ?? undefined;
  const startSeason = interaction.options.getInteger('startseason') ?? undefined;
  const endSeason = interaction.options.getInteger('endseason') ?? undefined;
  const channel = interaction.options.getChannel('channel', false);
  const timezone = interaction.options.getString('timezone') ?? undefined;

  if (channel && 'guildId' in channel && channel.guildId !== guildId) {
    await interaction.reply({
      content: 'Channel must belong to this guild.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = await context.leagueConfigRepo.getByGuildId(guildId);
  const leagueId = leagueIdInput ?? existing?.leagueId ?? context.env.defaultLeagueId ?? '';

  if (!leagueId) {
    await interaction.reply({
      content: 'League ID is required (set leagueId here or in ESPN_LEAGUE_ID).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (startSeason !== undefined && endSeason !== undefined && startSeason > endSeason) {
    await interaction.reply({
      content: 'Start season must be less than or equal to end season.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const newConfig: GuildLeagueConfig = {
    guildId,
    leagueId,
    startSeason: startSeason ?? existing?.startSeason,
    endSeason: endSeason ?? existing?.endSeason,
    postChannelId: channel?.id ?? existing?.postChannelId,
    timezone: timezone ?? existing?.timezone,
  };

  await context.leagueConfigRepo.upsert(newConfig);

  const summary = [
    `League: ${newConfig.leagueId}`,
    `Seasons: ${
      newConfig.startSeason || newConfig.endSeason
        ? `${newConfig.startSeason ?? '?'}-${newConfig.endSeason ?? '?'}`
        : 'not set'
    }`,
    `Channel: ${newConfig.postChannelId ? channelMention(newConfig.postChannelId) : 'not set'}`,
    `Timezone: ${newConfig.timezone ?? 'not set'}`,
  ].join('\n');

  await interaction.reply({
    content: `Config saved.\n${summary}`,
    flags: MessageFlags.Ephemeral,
  });
}
