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
  DRAFT_ORDER_LAUNCH_ID,
  handleDraftOrderLaunchButton,
  handleDraftOrderSetupSubcommand,
  handleDraftOrderMinigameSubcommand,
  handleDraftOrderBeginSubcommand,
  handleDraftOrderStatusSubcommand,
  handleDraftOrderAbortSubcommand,
  handleDraftOrderHypeSubcommand,
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
              .setName('weights')
              .setDescription("Ball weights (default: last season's standings for ESPN teams)")
              .addChoices(
                { name: 'standings — worst finish gets most balls', value: 'standings' },
                { name: 'equal — every team gets the same base', value: 'equal' },
              ),
          )
          .addStringOption((opt) =>
            opt
              .setName('balls')
              .setDescription('Set base balls by team name, e.g. "Sharks:5, Ducks:2"'),
          )
          .addStringOption((opt) =>
            opt
              .setName('bonus')
              .setDescription('Bonus balls by team name, e.g. "Sharks:2, Ducks:1"'),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('base')
              .setDescription('Base balls per team under equal weights (default 1)')
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
          .setName('hype')
          .setDescription('Post a countdown hype message with the frozen odds card')
          .addStringOption((opt) =>
            opt.setName('note').setDescription('Extra line to append to the hype post'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('begin')
          .setDescription('Post the commitment and run the ball-by-ball reveal')
          .addIntegerOption((opt) =>
            opt
              .setName('delay')
              .setDescription('Seconds between drum roll and reveal (default 20)')
              .setMinValue(5)
              .setMaxValue(120),
          )
          .addStringOption((opt) =>
            opt
              .setName('stage')
              .setDescription('Where the ball-by-ball reveal plays (default: channel cards)')
              .addChoices(
                { name: 'channel — card posts in this channel', value: 'channel' },
                { name: 'activity — the Lottery Machine (Embedded App)', value: 'activity' },
              ),
          )
          .addStringOption((opt) =>
            opt
              .setName('direction')
              .setDescription('Reveal order (default: worst-to-first — suspense builds to pick #1)')
              .addChoices(
                {
                  name: 'worst-to-first — reveal last pick down to pick 1 (default)',
                  value: 'worst-to-first',
                },
                {
                  name: 'first-to-last — reveal pick #1 first, then 2…N',
                  value: 'first-to-last',
                },
              ),
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

/**
 * A `/canon` subcommand handler. Every handler accepts `(interaction, context)`; handlers that
 * don't need `context` (e.g. the draft-session commands, which read module-level state) simply
 * declare the one parameter — TypeScript still accepts them here, since a lower-arity function is
 * assignable to a higher-arity type.
 */
type CanonSubcommandHandler = (
  interaction: ChatInputCommandInteraction,
  context: BotContext,
) => Promise<void>;

/**
 * Build the dispatch key for a subcommand: `"group:sub"` when the subcommand lives in a group,
 * or just `"sub"` for a top-level subcommand. Discord forbids a group and a top-level subcommand
 * sharing a name at the same level, so this is unambiguous. Used by both the router and the
 * routing test, so the two never drift.
 */
export function canonRouteKey(group: string | null, subcommand: string): string {
  return group ? `${group}:${subcommand}` : subcommand;
}

/**
 * Table-driven `/canon` router: `"group:sub"` (or `"sub"` for top-level) → handler. Replaces the
 * former nested `if/else` chains. `canonRouter.test.ts` asserts this table and `canonCommand`'s
 * registered subcommands are in exact bijection, so a new subcommand can't be registered without a
 * route (or vice versa). The `config` group has no per-sub branching — both `set` and `show` route
 * to `handleConfigSubcommand`, which reads the subcommand itself.
 */
export const CANON_ROUTES: Record<string, CanonSubcommandHandler> = {
  // config
  'config:set': handleConfigSubcommand,
  'config:show': handleConfigSubcommand,
  // legacy
  'legacy:season': handleLegacySubcommand,
  'legacy:history': handleLegacyHistorySubcommand,
  'legacy:champ': handleChampSubcommand,
  'legacy:champs': handleChampsSubcommand,
  'legacy:managers': handleManagersSubcommand,
  // faab
  'faab:leaderboard': handleLeaderboardSubcommand,
  'faab:faabpace': handleFaabPaceSubcommand,
  'faab:bids': handleBidsSubcommand,
  'faab:transactions': handleTransactionsSubcommand,
  // draft
  'draft:cheatsheet': handleDraftCheatsheetSubcommand,
  'draft:start': handleDraftStartSubcommand,
  'draft:pick': handleDraftPickSubcommand,
  'draft:best': handleDraftBestSubcommand,
  'draft:board': handleDraftBoardSubcommand,
  'draft:status': handleDraftStatusSubcommand,
  'draft:grade': handleDraftGradeSubcommand,
  'draft:stop': handleDraftStopSubcommand,
  // draftorder
  'draftorder:setup': handleDraftOrderSetupSubcommand,
  'draftorder:minigame': handleDraftOrderMinigameSubcommand,
  'draftorder:begin': handleDraftOrderBeginSubcommand,
  'draftorder:hype': handleDraftOrderHypeSubcommand,
  'draftorder:status': handleDraftOrderStatusSubcommand,
  'draftorder:abort': handleDraftOrderAbortSubcommand,
  // admin
  'admin:status': handleStatusSubcommand,
  'admin:ping': handlePingSubcommand,
  'admin:teams': handleTeamsSubcommand,
  'admin:inspect': handleInspectSubcommand,
  'admin:ingest': handleIngestSubcommand,
  'admin:timeline': handleTimelineSubcommand,
  'admin:graph': handleGraphSubcommand,
  // top-level analytics & fun (no subcommand group)
  luck: handleLuckSubcommand,
  allplay: handleAllPlaySubcommand,
  lineup: handleLineupSubcommand,
  trophies: handleTrophiesSubcommand,
  'draft-prophecy': handleDraftProphecySubcommand,
  streaks: handleStreaksSubcommand,
  homeaway: handleHomeAwaySubcommand,
  'manager-archetypes': handleManagerArchetypesSubcommand,
  tradeblock: handleTradeBlockSubcommand,
  rivalry: handleRivalrySubcommand,
  rivalries: handleRivalriesSubcommand,
  scout: handleScoutSubcommand,
};

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
  const subcommand = interaction.options.getSubcommand();
  const key = canonRouteKey(interaction.options.getSubcommandGroup(false), subcommand);
  const handler = CANON_ROUTES[key];
  if (!handler) {
    await handleNotImplemented(interaction, subcommand);
    return;
  }
  await handler(interaction, context);
}

/**
 * Table of `/canon` autocomplete handlers, keyed like {@link CANON_ROUTES}. Only `scout` exposes
 * an autocomplete option today; any other focused field falls through to an empty menu.
 */
export const CANON_AUTOCOMPLETE_ROUTES: Record<
  string,
  (interaction: AutocompleteInteraction, context: BotContext) => Promise<void>
> = {
  scout: handleScoutAutocomplete,
};

/**
 * Route `/canon` autocomplete interactions via {@link CANON_AUTOCOMPLETE_ROUTES}.
 */
export async function handleCanonAutocomplete(
  interaction: AutocompleteInteraction,
  context: BotContext,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  const handler = subcommand
    ? CANON_AUTOCOMPLETE_ROUTES[
        canonRouteKey(interaction.options.getSubcommandGroup(false), subcommand)
      ]
    : undefined;
  if (handler) {
    await handler(interaction, context);
    return;
  }
  await interaction.respond([]);
}

/**
 * Table of `/canon` message-component routes: a customId prefix → guarded handler. customIds are
 * namespaced `canon:<feature>:<action>` (with a trailing `:<sessionId>`, see
 * buildGradeComponents/buildBoardComponents), so `discord.ts` hands everything `canon:`-prefixed
 * here and we match by prefix. Each entry re-checks the component type: a customId whose component
 * kind doesn't match (a spoofed or malformed interaction) no-ops rather than mis-dispatching.
 */
const CANON_COMPONENT_ROUTES: {
  prefix: string;
  handle: (interaction: MessageComponentInteraction) => Promise<void> | undefined;
}[] = [
  {
    prefix: `${GRADE_VIEW_ID}:`,
    handle: (i) => (i.isStringSelectMenu() ? handleGradeViewSelect(i) : undefined),
  },
  { prefix: `${GRADE_SHARE_ID}:`, handle: (i) => (i.isButton() ? handleGradeShare(i) : undefined) },
  {
    prefix: `${BOARD_REFRESH_ID}:`,
    handle: (i) => (i.isButton() ? handleBoardRefresh(i) : undefined),
  },
  { prefix: `${BOARD_GRADE_ID}:`, handle: (i) => (i.isButton() ? handleBoardGrade(i) : undefined) },
  {
    prefix: `${DRAFT_ORDER_LAUNCH_ID}:`,
    handle: (i) => (i.isButton() ? handleDraftOrderLaunchButton(i) : undefined),
  },
];

/**
 * Route `/canon` message-component interactions (buttons, select menus). Today only the
 * interactive draft grade and live board use it — a reusable seam for future commands that want
 * buttons/menus. Unknown/stale components are ignored (a leftover button on an old message no-ops).
 */
export async function handleCanonComponent(
  interaction: MessageComponentInteraction,
): Promise<void> {
  const route = CANON_COMPONENT_ROUTES.find((r) => interaction.customId.startsWith(r.prefix));
  await route?.handle(interaction);
}
