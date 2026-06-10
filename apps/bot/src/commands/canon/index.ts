import { ChannelType, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { BotContext } from '../../config.js';
import { handleStatusSubcommand } from './status.js';
import { handlePingSubcommand } from './ping.js';
import { handleInspectSubcommand } from './inspect.js';
import { handleConfigSubcommand } from './leagueConfig.js';
import { handleIngestSubcommand } from './ingest.js';
import { handleTeamsSubcommand } from './teams.js';
import { handleLeaderboardSubcommand } from './leaderboard.js';
import { handleTransactionsSubcommand } from './transactions.js';
import { handleFaabPaceSubcommand } from './faabPace.js';
import { handleBidsSubcommand } from './bids.js';
import { handleTimelineSubcommand } from './timeline.js';
import { handleGraphSubcommand } from './graph.js';
import { handleRivalrySubcommand, handleRivalriesSubcommand } from './rivalries.js';
import { handleLegacySubcommand, handleLegacyHistorySubcommand } from './legacy.js';
import { handleManagersSubcommand } from './managers.js';
import { handleAllPlaySubcommand } from './allPlay.js';
import { handleTrophiesSubcommand } from './trophies.js';
import { handleLineupSubcommand } from './lineup.js';
import {
  handleLuckSubcommand,
  handleDraftProphecySubcommand,
  handleStreaksSubcommand,
  handleManagerArchetypesSubcommand,
  handleTradeBlockSubcommand,
  handleHomeAwaySubcommand,
  handleChampSubcommand,
  handleChampsSubcommand,
} from './storylines.js';

export const canonCommand = new SlashCommandBuilder()
  .setName('canon')
  .setDescription('Fantasy Canon commands')
  // --- Top-level analytics & fun (most-used verbs stay one keystroke away) ---
  .addSubcommand((sub) =>
    sub
      .setName('luck')
      .setDescription('Luck vs win outcomes')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('allplay')
      .setDescription('All-play record (Wins vs. All %) — schedule-independent strength')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt.setName('limit').setDescription('Number of teams to show (default all)').setMinValue(1),
      )
      .addStringOption((opt) =>
        opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('trophies')
      .setDescription('Weekly trophies — high/low score, blowout, closest, luckiest, unluckiest…')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('week')
          .setDescription('Week (matchup period)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(18),
      )
      .addStringOption((opt) =>
        opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('lineup')
      .setDescription('Optimal-lineup % leaderboard (points left on the bench)')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('weeks')
          .setDescription('Number of weeks to include (default: regular season)')
          .setMinValue(1)
          .setMaxValue(18),
      )
      .addIntegerOption((opt) =>
        opt.setName('limit').setDescription('Number of teams to show (default all)').setMinValue(1),
      )
      .addStringOption((opt) =>
        opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('draft-prophecy')
      .setDescription('Draft expectations vs results')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('streaks')
      .setDescription('Longest and current streaks')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('homeaway')
      .setDescription('Home vs away performance')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('manager-archetypes')
      .setDescription('Classify managers by behavior')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('tradeblock')
      .setDescription('Teams with the busiest trade block')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('rivalry')
      .setDescription('Head-to-head rivalry between two teams')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('teama').setDescription('Team A name or ID').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('teamb').setDescription('Team B name or ID').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('rivalries')
      .setDescription('Top head-to-head rivalries by win differential')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt.setName('limit').setDescription('Number of rows (default 5)').setMinValue(1),
      )
      .addStringOption((opt) =>
        opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
      ),
  )
  // --- /canon faab … (waiver/FAAB & transaction surfaces) ---
  .addSubcommandGroup((group) =>
    group
      .setName('faab')
      .setDescription('FAAB, waivers, and transaction surfaces')
      .addSubcommand((sub) =>
        sub
          .setName('leaderboard')
          .setDescription('Show season leaderboard for a metric')
          .addStringOption((opt) =>
            opt
              .setName('metric')
              .setDescription('Metric to rank')
              .setRequired(true)
              .addChoices({ name: 'faab', value: 'faab' }),
          )
          .addIntegerOption((opt) =>
            opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('limit')
              .setDescription('Number of teams to show (default 12)')
              .setMinValue(1),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('faabpace')
          .setDescription('FAAB spend/left pacing by week')
          .addIntegerOption((opt) =>
            opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('mode')
              .setDescription('Show spent or left')
              .addChoices({ name: 'spent', value: 'spent' }, { name: 'left', value: 'left' }),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('budget')
              .setDescription('FAAB budget to compute remaining (default 100)')
              .setMinValue(1),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('bids')
          .setDescription('Find close or lopsided FAAB bids on the same player')
          .addIntegerOption((opt) =>
            opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('mode')
              .setDescription('Close or lopsided')
              .addChoices(
                { name: 'close', value: 'close' },
                { name: 'lopsided', value: 'lopsided' },
              ),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('threshold')
              .setDescription('For close: max spread ($). For lopsided: min ratio.')
              .setMinValue(1),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('limit')
              .setDescription('Number of rows to show (default 5)')
              .setMinValue(1),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('transactions')
          .setDescription('Show latest transactions')
          .addIntegerOption((opt) =>
            opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
          )
          .addIntegerOption((opt) =>
            opt.setName('limit').setDescription('Number of rows (default 10)').setMinValue(1),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      ),
  )
  // --- /canon legacy … (awards, champions, multi-season records) ---
  .addSubcommandGroup((group) =>
    group
      .setName('legacy')
      .setDescription('Awards, champions, and multi-season records')
      .addSubcommand((sub) =>
        sub
          .setName('season')
          .setDescription('Legacy awards (luck, dominance, archetypes) for a season')
          .addIntegerOption((opt) =>
            opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('history')
          .setDescription('Legacy awards across multiple seasons')
          .addStringOption((opt) =>
            opt
              .setName('seasons')
              .setDescription('Comma list or range (e.g., 2022-2025 or 2024,2025)')
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('champ')
          .setDescription('Announce the season champion')
          .addIntegerOption((opt) =>
            opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('champs')
          .setDescription('List champions for seasons')
          .addStringOption((opt) =>
            opt
              .setName('seasons')
              .setDescription('Comma list or range (e.g., 2022-2025 or 2024,2025)')
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('managers')
          .setDescription('Manager records across multiple seasons')
          .addStringOption((opt) =>
            opt
              .setName('seasons')
              .setDescription('Comma list or range (e.g., 2022-2025 or 2024,2025)')
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('sort')
              .setDescription('Sort field')
              .addChoices(
                { name: 'wins', value: 'wins' },
                { name: 'win% (games)', value: 'winpct' },
                { name: 'points for', value: 'points' },
                { name: 'moves', value: 'moves' },
              ),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('limit')
              .setDescription('Number of rows to show (default 10)')
              .setMinValue(1),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      ),
  )
  // --- /canon admin … (plumbing: status, data ingest, inspection, rendering) ---
  .addSubcommandGroup((group) =>
    group
      .setName('admin')
      .setDescription('Plumbing: status, data ingest, inspection, and rendering')
      .addSubcommand((sub) => sub.setName('status').setDescription('Check bot status and config'))
      .addSubcommand((sub) => sub.setName('ping').setDescription('Simple health check (pong)'))
      .addSubcommand((sub) =>
        sub
          .setName('teams')
          .setDescription('List teams for a season')
          .addIntegerOption((opt) =>
            opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('inspect')
          .setDescription('Fetch an ESPN view and summarize it')
          .addIntegerOption((opt) =>
            opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('view')
              .setDescription('ESPN view to fetch')
              .addChoices(
                { name: 'mTeam', value: 'mTeam' },
                { name: 'mRoster', value: 'mRoster' },
                { name: 'mTransactions', value: 'mTransactions' },
                { name: 'mDraftDetail', value: 'mDraftDetail' },
              ),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to env)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('ingest')
          .setDescription('Fetch and store ESPN snapshots')
          .addStringOption((opt) =>
            opt
              .setName('season')
              .setDescription("Season year (e.g., 2025) or 'all' to use configured range")
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('views')
              .setDescription('View set: default|all|comma list (e.g., mTeam,mRoster)')
              .addChoices({ name: 'default', value: 'default' }, { name: 'all', value: 'all' }),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('timeline')
          .setDescription('Show canon timeline events')
          .addStringOption((opt) =>
            opt
              .setName('seasons')
              .setDescription('Comma list or range (optional, e.g., 2022-2025 or 2024,2025)'),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('limit')
              .setDescription('Rows to show (default 10)')
              .setMinValue(1)
              .setMaxValue(50),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('offset')
              .setDescription('Offset for pagination (default 0)')
              .setMinValue(0),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('graph')
          .setDescription('Render a storyline graph')
          .addStringOption((opt) =>
            opt
              .setName('metric')
              .setDescription('Graph to render')
              .setRequired(true)
              .addChoices(
                { name: 'luck', value: 'luck' },
                { name: 'draft-prophecy', value: 'draft-prophecy' },
                { name: 'faab-pace', value: 'faab-pace' },
              ),
          )
          .addIntegerOption((opt) =>
            opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      ),
  )
  // --- /canon config … (per-guild defaults; stays its own group — Discord forbids group nesting) ---
  .addSubcommandGroup((group) =>
    group
      .setName('config')
      .setDescription('Configure league defaults')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set league, season range, channel, and timezone')
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('League ID to use by default'),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('startseason')
              .setDescription('Start season (e.g., 2020)')
              .setMinValue(2000)
              .setMaxValue(2100),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('endseason')
              .setDescription('End season (e.g., 2025)')
              .setMinValue(2000)
              .setMaxValue(2100),
          )
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel for scheduled posts')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addStringOption((opt) =>
            opt.setName('timezone').setDescription('IANA timezone (e.g., America/Los_Angeles)'),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('show').setDescription('Show current league configuration for this server'),
      ),
  );

async function handleNotImplemented(
  interaction: ChatInputCommandInteraction,
  subcommand: string,
): Promise<void> {
  await interaction.reply({
    content: `Subcommand "${subcommand}" is not implemented yet.`,
    ephemeral: true,
  });
}

export async function handleCanonInteraction(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (group === 'config') {
    await handleConfigSubcommand(interaction, context);
    return;
  }

  if (group === 'legacy') {
    if (subcommand === 'season') {
      await handleLegacySubcommand(interaction, context);
    } else if (subcommand === 'history') {
      await handleLegacyHistorySubcommand(interaction, context);
    } else if (subcommand === 'champ') {
      await handleChampSubcommand(interaction, context);
    } else if (subcommand === 'champs') {
      await handleChampsSubcommand(interaction, context);
    } else if (subcommand === 'managers') {
      await handleManagersSubcommand(interaction, context);
    } else {
      await handleNotImplemented(interaction, subcommand);
    }
    return;
  }

  if (group === 'faab') {
    if (subcommand === 'leaderboard') {
      await handleLeaderboardSubcommand(interaction, context);
    } else if (subcommand === 'faabpace') {
      await handleFaabPaceSubcommand(interaction, context);
    } else if (subcommand === 'bids') {
      await handleBidsSubcommand(interaction, context);
    } else if (subcommand === 'transactions') {
      await handleTransactionsSubcommand(interaction, context);
    } else {
      await handleNotImplemented(interaction, subcommand);
    }
    return;
  }

  if (group === 'admin') {
    if (subcommand === 'status') {
      await handleStatusSubcommand(interaction, context);
    } else if (subcommand === 'ping') {
      await handlePingSubcommand(interaction);
    } else if (subcommand === 'teams') {
      await handleTeamsSubcommand(interaction, context);
    } else if (subcommand === 'inspect') {
      await handleInspectSubcommand(interaction, context);
    } else if (subcommand === 'ingest') {
      await handleIngestSubcommand(interaction, context);
    } else if (subcommand === 'timeline') {
      await handleTimelineSubcommand(interaction, context);
    } else if (subcommand === 'graph') {
      await handleGraphSubcommand(interaction, context);
    } else {
      await handleNotImplemented(interaction, subcommand);
    }
    return;
  }

  // Top-level analytics & fun (no subcommand group).
  if (subcommand === 'luck') {
    await handleLuckSubcommand(interaction, context);
  } else if (subcommand === 'allplay') {
    await handleAllPlaySubcommand(interaction, context);
  } else if (subcommand === 'trophies') {
    await handleTrophiesSubcommand(interaction, context);
  } else if (subcommand === 'lineup') {
    await handleLineupSubcommand(interaction, context);
  } else if (subcommand === 'draft-prophecy') {
    await handleDraftProphecySubcommand(interaction, context);
  } else if (subcommand === 'streaks') {
    await handleStreaksSubcommand(interaction, context);
  } else if (subcommand === 'homeaway') {
    await handleHomeAwaySubcommand(interaction, context);
  } else if (subcommand === 'manager-archetypes') {
    await handleManagerArchetypesSubcommand(interaction, context);
  } else if (subcommand === 'tradeblock') {
    await handleTradeBlockSubcommand(interaction, context);
  } else if (subcommand === 'rivalry') {
    await handleRivalrySubcommand(interaction, context);
  } else if (subcommand === 'rivalries') {
    await handleRivalriesSubcommand(interaction, context);
  } else {
    await handleNotImplemented(interaction, subcommand);
  }
}
