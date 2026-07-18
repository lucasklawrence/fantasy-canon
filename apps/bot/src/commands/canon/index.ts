import {
  AutocompleteInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  MessageComponentInteraction,
  SlashCommandBuilder,
} from 'discord.js';
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
import { handleDraftCheatsheetSubcommand } from './draftCheatsheet.js';
import {
  handleDraftStartSubcommand,
  handleDraftPickSubcommand,
  handleDraftBestSubcommand,
  handleDraftStatusSubcommand,
  handleDraftGradeSubcommand,
  handleDraftStopSubcommand,
  handleDraftBoardSubcommand,
  handleGradeViewSelect,
  handleGradeShare,
  handleBoardRefresh,
  handleBoardGrade,
  GRADE_VIEW_ID,
  GRADE_SHARE_ID,
  BOARD_REFRESH_ID,
  BOARD_GRADE_ID,
} from './draftSession.js';
import {
  handleDraftOrderSetupSubcommand,
  handleDraftOrderMinigameSubcommand,
  handleDraftOrderBeginSubcommand,
  handleDraftOrderStatusSubcommand,
  handleDraftOrderAbortSubcommand,
} from './draftOrder.js';
import { handleRivalrySubcommand, handleRivalriesSubcommand } from './rivalries.js';
import { handleLegacySubcommand, handleLegacyHistorySubcommand } from './legacy.js';
import { handleManagersSubcommand } from './managers.js';
import { handleAllPlaySubcommand } from './allPlay.js';
import { handleLineupSubcommand } from './lineup.js';
import { handleScoutSubcommand, handleScoutAutocomplete } from './scout.js';
import { handleTrophiesSubcommand } from './trophies.js';
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
      .setName('trophies')
      .setDescription('Weekly trophies — high/low score, blowout, closest, luckiest, unluckiest')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('week')
          .setDescription('Week (matchup period)')
          .setRequired(true)
          .setMinValue(1),
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
  .addSubcommand((sub) =>
    sub
      .setName('scout')
      .setDescription('Scout an opponent: record, tendencies, and roster snapshot')
      .addIntegerOption((opt) =>
        opt.setName('season').setDescription('Season year (e.g., 2025)').setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('opponent')
          .setDescription('Opponent team or manager (pick from suggestions)')
          .setRequired(true)
          .setAutocomplete(true),
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
                { name: 'power-ranking', value: 'power-ranking' },
                { name: 'standings', value: 'standings' },
                { name: 'awards', value: 'awards' },
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
  // --- /canon draft … (draft-day tools) ---
  .addSubcommandGroup((group) =>
    group
      .setName('draft')
      .setDescription('Draft-day tools')
      .addSubcommand((sub) =>
        sub
          .setName('cheatsheet')
          .setDescription(
            'Best-available draft board from our research (updates as players are drafted)',
          )
          .addStringOption((opt) =>
            opt
              .setName('drafted')
              .setDescription('Players already drafted, comma-separated (updates best-available)'),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('pick')
              .setDescription('Your draft slot (1..teams) — enables reach/wait timing')
              .setMinValue(1),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('teams')
              .setDescription('League size (default 12)')
              .setMinValue(2)
              .setMaxValue(20),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('start')
          .setDescription('Open a live draft session (best-available updates as picks land)')
          .addIntegerOption((opt) =>
            opt
              .setName('pick')
              .setDescription('Your draft slot (1..teams)')
              .setRequired(true)
              .setMinValue(1),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('teams')
              .setDescription('League size (default 12)')
              .setMinValue(2)
              .setMaxValue(20),
          )
          .addStringOption((opt) =>
            opt
              .setName('source')
              .setDescription('Where picks come from (default manual)')
              .addChoices(
                { name: 'manual — you type picks', value: 'manual' },
                { name: 'espn — auto-capture from your ESPN draft room', value: 'espn' },
              ),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('rounds')
              .setDescription('Total rounds (default: roster size)')
              .setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('pick')
          .setDescription('Record a pick in the live session (comma-separate to add several)')
          .addStringOption((opt) =>
            opt.setName('player').setDescription('Player(s) just drafted').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('best').setDescription('Show the live best-available board for this session'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('board')
          .setDescription('Post a self-updating live board to this channel (ticks as picks land)'),
      )
      .addSubcommand((sub) =>
        sub.setName('status').setDescription('Where the live draft session stands'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('grade')
          .setDescription('Grade your roster so far (value-vs-ADP, steals, reaches, starters)'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('stop')
          .setDescription('End the live draft session (frees the ESPN capture port)'),
      ),
  )
  // --- /canon draftorder … (the lottery ceremony — commit-reveal, ADR 0006) ---
  .addSubcommandGroup((group) =>
    group
      .setName('draftorder')
      .setDescription('Draft-order lottery ceremony (provably fair commit-reveal)')
      .addSubcommand((sub) =>
        sub
          .setName('setup')
          .setDescription('Freeze the bag and post the public odds preview')
          .addIntegerOption((opt) =>
            opt.setName('season').setDescription('Season year (e.g., 2026)').setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('teams')
              .setDescription('Manual team list "Name[:bonus], …" (default: ESPN league teams)'),
          )
          .addStringOption((opt) =>
            opt
              .setName('bonus')
              .setDescription('Bonus balls by team name, e.g. "Sharks:2, Ducks:1"'),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('base')
              .setDescription('Base balls per team (default 1)')
              .setMinValue(1)
              .setMaxValue(10),
          )
          .addStringOption((opt) =>
            opt.setName('leagueid').setDescription('Override league ID (defaults to config/env)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('minigame')
          .setDescription('Reaction round for bonus balls (runs before begin seals the bag)')
          .addIntegerOption((opt) =>
            opt
              .setName('window')
              .setDescription('Click window in seconds after GO (default 15)')
              .setMinValue(5)
              .setMaxValue(60),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('begin')
          .setDescription('Post the commitment and run the worst-to-first reveal')
          .addIntegerOption((opt) =>
            opt
              .setName('delay')
              .setDescription('Seconds between drum roll and reveal (default 20)')
              .setMinValue(5)
              .setMaxValue(120),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('status').setDescription('Where the lottery ceremony stands'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('abort')
          .setDescription('Abort the ceremony (the committed seed is revealed anyway)'),
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

  if (group === 'draft') {
    if (subcommand === 'cheatsheet') {
      await handleDraftCheatsheetSubcommand(interaction);
    } else if (subcommand === 'start') {
      await handleDraftStartSubcommand(interaction);
    } else if (subcommand === 'pick') {
      await handleDraftPickSubcommand(interaction);
    } else if (subcommand === 'best') {
      await handleDraftBestSubcommand(interaction);
    } else if (subcommand === 'board') {
      await handleDraftBoardSubcommand(interaction);
    } else if (subcommand === 'status') {
      await handleDraftStatusSubcommand(interaction);
    } else if (subcommand === 'grade') {
      await handleDraftGradeSubcommand(interaction);
    } else if (subcommand === 'stop') {
      await handleDraftStopSubcommand(interaction);
    } else {
      await handleNotImplemented(interaction, subcommand);
    }
    return;
  }

  if (group === 'draftorder') {
    if (subcommand === 'setup') {
      await handleDraftOrderSetupSubcommand(interaction, context);
    } else if (subcommand === 'minigame') {
      await handleDraftOrderMinigameSubcommand(interaction);
    } else if (subcommand === 'begin') {
      await handleDraftOrderBeginSubcommand(interaction);
    } else if (subcommand === 'status') {
      await handleDraftOrderStatusSubcommand(interaction);
    } else if (subcommand === 'abort') {
      await handleDraftOrderAbortSubcommand(interaction);
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
  } else if (subcommand === 'lineup') {
    await handleLineupSubcommand(interaction, context);
  } else if (subcommand === 'trophies') {
    await handleTrophiesSubcommand(interaction, context);
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
  } else if (subcommand === 'scout') {
    await handleScoutSubcommand(interaction, context);
  } else {
    await handleNotImplemented(interaction, subcommand);
  }
}

/**
 * Route `/canon` autocomplete interactions. Only `scout` exposes an autocomplete option today;
 * any other focused field gets an empty menu.
 */
export async function handleCanonAutocomplete(
  interaction: AutocompleteInteraction,
  context: BotContext,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  if (subcommand === 'scout') {
    await handleScoutAutocomplete(interaction, context);
    return;
  }
  await interaction.respond([]);
}

/**
 * Route `/canon` message-component interactions (buttons, select menus). customIds are namespaced
 * `canon:<feature>:<action>` so `discord.ts` can hand everything `canon:`-prefixed here; each feature
 * owns its slice. Today only the interactive draft grade uses it — a reusable seam for future
 * commands that want buttons/menus.
 */
export async function handleCanonComponent(
  interaction: MessageComponentInteraction,
): Promise<void> {
  const { customId } = interaction;
  // customIds carry a `:<sessionId>` suffix (see buildGradeComponents/buildBoardComponents), so
  // match by prefix.
  if (customId.startsWith(`${GRADE_VIEW_ID}:`) && interaction.isStringSelectMenu()) {
    await handleGradeViewSelect(interaction);
  } else if (customId.startsWith(`${GRADE_SHARE_ID}:`) && interaction.isButton()) {
    await handleGradeShare(interaction);
  } else if (customId.startsWith(`${BOARD_REFRESH_ID}:`) && interaction.isButton()) {
    await handleBoardRefresh(interaction);
  } else if (customId.startsWith(`${BOARD_GRADE_ID}:`) && interaction.isButton()) {
    await handleBoardGrade(interaction);
  }
  // Unknown/stale component: ignore. (A stale button on an old message just no-ops.)
}
