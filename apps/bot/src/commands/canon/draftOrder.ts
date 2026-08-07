/**
 * `/canon draftorder` — the draft-order lottery ceremony (#164, ADR 0006).
 *
 * Two-step flow: `setup` posts the public odds preview and freezes the bag; `begin` posts the
 * commitment and runs the paced ball-by-ball reveal on regular channel messages (never
 * interaction responses — the ceremony outlives any interaction token). `abort` follows the
 * ADR 0006 disclosure policy; `status` is an ephemeral peek. Between them, the optional
 * `minigame` (#166) runs the reaction round while the bag is still mutable — its results and
 * a fresh odds preview always post publicly before `begin` can seal the bag.
 *
 * Teams default to the ESPN league's `mTeam` roster; a manual `teams` option overrides for
 * dry-runs and leagues without ESPN access. All orchestration lives in
 * `lib/draftOrderCeremony.ts` so it stays testable without discord.js.
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import {
  computePickOdds,
  DraftOrderState,
  DraftOrderTeamInput,
  MAX_TEAM_BALLS,
} from '@fantasy-canon/core';
import { BotContext } from '../../config.js';
import { resolveLeagueId } from '../../lib/leagueId.js';
import { ensureSnapshot } from '../../lib/snapshots.js';
import { buildTeamLogoMap, buildTeamNameMap } from '../../lib/teamNames.js';
import { deriveStandingsBaseBalls, extractFinalRanks } from '../../lib/finalStandings.js';
import {
  applyLobbyAdjustments,
  applyLobbyRenames,
  buildAdjustedPreviewPost,
  buildHypePost,
  buildPreviewPost,
  captureBag,
  CeremonyAborted,
  CeremonyIo,
  CeremonyPost,
  type CeremonySession,
  clearCeremony,
  createCeremony,
  getCeremony,
  hasAnyCeremony,
  interruptedDisclosureContent,
  markPreviewPosted,
  oddsRows,
  requestAbort,
  restoreBag,
  runCeremony,
  setCeremony,
} from '../../lib/draftOrderCeremony.js';
import {
  createFileCeremonyStore,
  recallLotteryChannel,
  rememberLotteryChannel,
  type CeremonyStore,
} from '../../lib/ceremonyStore.js';
import {
  DEFAULT_STAGE_URL,
  stageFromEnv,
  type InspectableRevealStage,
} from '../../lib/lotteryStageClient.js';
import {
  createStageWatcher,
  type StageBeginRequest,
  type StageSetupRequest,
} from '../../lib/lotteryStageWatcher.js';
import { prefetchLogoBytes, pushTeamLogos, type LogoBytes } from '../../lib/logoPush.js';
import { DEFAULT_WINDOW_MS, runReactionRound } from '../../lib/reactionRound.js';

export const DEFAULT_REVEAL_DELAY_SECONDS = 20;

/** Hard cap on bonus balls per team — the bag is materialized ball-by-ball, so unbounded input is a foot-gun. */
export const MAX_BONUS_BALLS = 10;

/**
 * Cap for the `balls` set-override — above any sane standings weight, below bag-size foot-guns.
 * Re-exported from core so this option and the in-Activity stepper (#210) can never drift apart.
 */
export const MAX_BASE_BALLS = MAX_TEAM_BALLS;

interface ParsedTeam {
  name: string;
  bonusBalls: number;
}

interface SetupTeam {
  teamId: string;
  name: string;
  bonusBalls: number;
  /** Set by standings weighting or the `balls` override; absent = the flat `base` option. */
  baseBalls?: number;
  /** ESPN team logo URL (#242) — cosmetic; rides the lobby/start rows for the Activity visuals. */
  logo?: string;
}

/**
 * Parse the manual `teams` option: comma-separated `Name` or `Name:bonus` entries, e.g.
 * `"Sharks, Vipers:2, Ducks"`. Names keep inner spaces; bonus must be a non-negative integer.
 */
export function parseManualTeams(input: string): ParsedTeam[] {
  const entries = input
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.map((entry) => {
    const splitAt = entry.lastIndexOf(':');
    if (splitAt === -1) {
      return { name: entry, bonusBalls: 0 };
    }
    const name = entry.slice(0, splitAt).trim();
    const bonusRaw = entry.slice(splitAt + 1).trim();
    const bonus = Number(bonusRaw);
    if (!name || !Number.isInteger(bonus) || bonus < 0) {
      throw new Error(`Can't parse team entry "${entry}" — use "Name" or "Name:bonusBalls".`);
    }
    if (bonus > MAX_BONUS_BALLS) {
      throw new Error(`"${entry}": bonus balls are capped at ${MAX_BONUS_BALLS} per team.`);
    }
    return { name, bonusBalls: bonus };
  });
}

function matchTeamByName<T extends { name: string }>(teams: T[], name: string): T {
  const team = teams.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!team) {
    const known = teams.map((t) => t.name).join(', ');
    throw new Error(`No team named "${name}". Teams: ${known}`);
  }
  return team;
}

/**
 * Parse the `bonus` option (`"Sharks:2, Ducks:1"`) and apply it onto the team list by
 * case-insensitive display-name match. Throws when a name matches no team.
 */
export function applyBonusOverrides(teams: SetupTeam[], bonusInput: string | undefined): void {
  if (!bonusInput) return;
  for (const parsed of parseManualTeams(bonusInput)) {
    matchTeamByName(teams, parsed.name).bonusBalls = parsed.bonusBalls;
  }
}

/**
 * Parse the `balls` option (`"Sharks:5, Ducks:2"`) and *set* each named team's base balls —
 * the commissioner's override for standings-derived weights, able to lower as well as raise
 * (unlike `bonus`, which only adds on top). Every entry requires the `Name:count` form.
 */
export function applyBallsOverrides(teams: SetupTeam[], ballsInput: string | undefined): void {
  if (!ballsInput) return;
  const entries = ballsInput
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const splitAt = entry.lastIndexOf(':');
    const name = splitAt === -1 ? '' : entry.slice(0, splitAt).trim();
    const count = splitAt === -1 ? NaN : Number(entry.slice(splitAt + 1).trim());
    if (!name || !Number.isInteger(count) || count < 1) {
      throw new Error(`Can't parse balls entry "${entry}" — use "Name:count" with count >= 1.`);
    }
    if (count > MAX_BASE_BALLS) {
      throw new Error(`"${entry}": base balls are capped at ${MAX_BASE_BALLS} per team.`);
    }
    matchTeamByName(teams, name).baseBalls = count;
  }
}

function isCommissioner(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function denyUnlessCommissioner(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'The lottery ceremony runs in a server channel, not in DMs.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  if (!isCommissioner(interaction)) {
    await interaction.reply({
      content: 'Only the commissioner (Manage Server permission) can run the lottery.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  return true;
}

interface SendableChannel {
  send(payload: {
    content?: string;
    files?: AttachmentBuilder[];
    components?: (
      ActionRowBuilder<ButtonBuilder> | ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']>
    )[];
    /** Always `{ parse: [] }` on ceremony surfaces — posts echo ESPN-controlled names (#222). */
    allowedMentions?: { parse: never[] };
  }): Promise<{ id: string }>;
}

function sendableChannel(interaction: ChatInputCommandInteraction): SendableChannel | undefined {
  const channel = interaction.channel;
  if (!channel || !('send' in channel) || !channel.isSendable()) return undefined;
  return channel;
}

function channelIo(channel: SendableChannel): CeremonyIo {
  return {
    async post(post: CeremonyPost) {
      const files = post.image
        ? [new AttachmentBuilder(post.image.data, { name: post.image.name })]
        : undefined;
      // Ceremony posts echo ESPN team names — user-controlled text from our side. A team renamed
      // to `@everyone` (or carrying a role mention) must not ping the server on every post of a
      // paced 12-pick ceremony; nothing the ceremony says needs to mention anyone (#222).
      const message = await channel.send({
        content: post.content,
        files,
        allowedMentions: { parse: [] },
      });
      return { id: message.id };
    },
  };
}

/** The `teamId → logo URL` map a roster carries (#242); empty entries are simply omitted. */
function teamLogoMap(teams: SetupTeam[]): Map<string, string> {
  return new Map(teams.flatMap((team) => (team.logo ? [[team.teamId, team.logo] as const] : [])));
}

/** Where a guild's lottery lives (#253) — injectable so tests never touch the state dir. */
export interface LotteryChannelMemo {
  remember(guildId: string, channelId: string): void;
  recall(guildId: string): string | undefined;
}

const fileChannelMemo: LotteryChannelMemo = {
  remember: (guildId, channelId) => rememberLotteryChannel(guildId, channelId),
  recall: (guildId) => recallLotteryChannel(guildId),
};

/** The cookie pair every logo fetch shares — attached only to https ESPN hosts downstream. */
function espnCookies(context: BotContext): { espnS2?: string; espnSwid?: string } {
  return { espnS2: context.env.espnS2, espnSwid: context.env.espnSwid };
}

/** A roster's full logo dress (#254): the URL map plus the prefetched bytes behind it. */
interface SessionLogoDress {
  logos: Map<string, string>;
  logoBytes: Map<string, LogoBytes> | undefined;
}

/**
 * Fetch the roster's logo bytes (#254) under the prefetch's soft deadline, so the odds card
 * about to render can wear them; slow hosts keep filling the map in the background, and the
 * stage push and the finish board see more later. Pure fetch, no session writes: callers run
 * this BEFORE their registry re-validation and stamp the result with {@link dressSession}
 * afterwards — a network wait must never sit inside a check-then-act window, and the stamp
 * must never suspend halfway through a roster install.
 */
async function fetchSessionLogoDress(
  teams: SetupTeam[],
  context: BotContext,
): Promise<SessionLogoDress> {
  const logos = teamLogoMap(teams);
  const logoBytes =
    logos.size > 0 ? await prefetchLogoBytes(logos, espnCookies(context)) : undefined;
  return { logos, logoBytes };
}

/**
 * Stamp a fetched dress onto the session, synchronously and in full — `logoBytes` is REPLACED
 * even when the new roster has none, so a re-import that shed its logos also sheds the stale
 * byte cache instead of dressing ghost art onto later cards.
 */
function dressSession(session: CeremonySession, dress: SessionLogoDress): void {
  session.logos = dress.logos;
  session.logoBytes = dress.logoBytes;
}

/**
 * Fire-and-forget logo delivery (#249): fetch what only the bot can (league cookies for ESPN
 * hosts, resvg for stock SVGs) and push raster bytes to the stage's same-origin cache. Never
 * awaited on a hot path — the ceremony must never depend on cosmetics. The #254 prefetch cache
 * rides along so nothing already fetched for the cards is fetched twice.
 */
function pushSessionLogos(
  session: CeremonySession,
  context: BotContext,
  stage: InspectableRevealStage = stageFromEnv(),
): void {
  const logos = session.logos;
  if (!logos || logos.size === 0) return;
  void pushTeamLogos(stage, logos, espnCookies(context), {}, session.logoBytes)
    .then((pushed) => {
      if (pushed > 0) console.log(`[draftorder] pushed ${pushed} team logo(s) to the stage`);
    })
    .catch((error: unknown) => {
      console.error('[draftorder] logo push failed:', error);
    });
}

async function resolveEspnTeams(
  context: BotContext,
  leagueId: string,
  season: number,
  refresh = false,
): Promise<SetupTeam[]> {
  const payload = await ensureSnapshot(context, leagueId, season, 'mTeam', { refresh });
  const nameMap = buildTeamNameMap(payload);
  if (nameMap.size === 0) {
    throw new Error(`No teams found for league ${leagueId}, season ${season}.`);
  }
  const logoMap = buildTeamLogoMap(payload);
  return [...nameMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([teamId, name]) => ({
      teamId: String(teamId),
      name,
      bonusBalls: 0,
      ...(logoMap.has(teamId) ? { logo: logoMap.get(teamId) } : {}),
    }));
}

/**
 * Derive per-team base balls from last season's final standings (worst finish → most balls,
 * #165) and stamp them onto the roster. Returns human-readable notes for the setup reply; on
 * any ESPN failure it leaves the roster untouched (equal weights) and says so — the ceremony
 * must never be blocked by a standings fetch.
 */
async function applyStandingsWeights(
  context: BotContext,
  leagueId: string,
  season: number,
  teams: SetupTeam[],
  refresh = false,
): Promise<string[]> {
  const lastSeason = season - 1;
  try {
    const payload = await ensureSnapshot(context, leagueId, lastSeason, 'mTeam', { refresh });
    const ranks = extractFinalRanks(payload);
    if (ranks.size === 0) {
      throw new Error(`no final standings in the ${lastSeason} snapshot`);
    }
    const { baseBallsByTeam, missingRank } = deriveStandingsBaseBalls(
      teams.map((team) => team.teamId),
      ranks,
    );
    for (const team of teams) {
      team.baseBalls = baseBallsByTeam.get(team.teamId);
    }
    const notes = [`Weights: ${lastSeason} final standings — worst finish gets the most balls.`];
    if (missingRank.length > 0) {
      const flagged = teams
        .filter((team) => missingRank.includes(team.teamId))
        .map((team) => team.name)
        .join(', ');
      notes.push(
        `No ${lastSeason} finish for ${flagged} — defaulted to mid-pack ${Math.ceil(teams.length / 2)} ball(s); adjust with the \`balls\` option if needed.`,
      );
    }
    return notes;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`Couldn't derive ${lastSeason} standings weights (${message}) — using equal weights.`];
  }
}

export async function handleDraftOrderSetupSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
  memo: LotteryChannelMemo = fileChannelMemo,
): Promise<void> {
  if (!(await denyUnlessCommissioner(interaction))) return;
  const guildId = interaction.guildId as string;

  const existing = getCeremony(guildId);
  if (existing?.state === 'LOTTERY_RUNNING') {
    await interaction.reply({
      content: 'A ceremony is already running — `/canon draftorder abort` it first.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const season = interaction.options.getInteger('season', true);
  const manualTeams = interaction.options.getString('teams') ?? undefined;
  const bonusInput = interaction.options.getString('bonus') ?? undefined;
  const ballsInput = interaction.options.getString('balls') ?? undefined;
  const weightsMode = interaction.options.getString('weights') ?? 'standings';
  const baseBallCount = interaction.options.getInteger('base') ?? 1;

  const channel = sendableChannel(interaction);
  if (!channel) {
    await interaction.reply({
      content: "I can't post in this channel — check my permissions.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const notes: string[] = [];
    let resolvedLeagueId: string | undefined;
    let teams: SetupTeam[];
    if (manualTeams) {
      teams = parseManualTeams(manualTeams).map((team, index) => ({
        teamId: `team-${index + 1}`,
        name: team.name,
        bonusBalls: team.bonusBalls,
      }));
    } else {
      resolvedLeagueId = await resolveLeagueId(interaction, context);
      const leagueId = resolvedLeagueId;
      if (!leagueId) {
        throw new Error(
          'League ID is required — set it via /canon config set, ESPN_LEAGUE_ID, or pass a manual `teams` list.',
        );
      }
      teams = await resolveEspnTeams(context, leagueId, season);
      if (weightsMode === 'standings') {
        notes.push(...(await applyStandingsWeights(context, leagueId, season, teams)));
      }
    }
    applyBallsOverrides(teams, ballsInput);
    applyBonusOverrides(teams, bonusInput);

    const configTeams: DraftOrderTeamInput[] = teams.map((team) => ({
      teamId: team.teamId,
      displayName: team.name,
      baseBalls: team.baseBalls,
      bonusBalls: team.bonusBalls,
    }));
    const names = new Map(teams.map((team) => [team.teamId, team.name]));
    const session = createCeremony(
      guildId,
      `${season} Draft Lottery`,
      { teams: configTeams, baseBallCount },
      names,
    );

    // Cosmetic only (#242): the Activity's odds table, drop ball, race cars — and, since #254,
    // the odds/board cards — wear these; the commitment preimage never sees a logo. Manual
    // `teams:` setups simply have none. Fetched (bounded) BEFORE the re-validation below so
    // the check-then-act window never spans this network wait, and before the preview renders
    // so the first public card already carries them.
    const dress = await fetchSessionLogoDress(teams, context);

    // Re-validate after the awaits above (ESPN fetch, logo prefetch): if a ceremony started
    // running meanwhile, replacing it now would orphan a live draw.
    if (getCeremony(guildId)?.state === 'LOTTERY_RUNNING') {
      await interaction.editReply({
        content: 'A ceremony started running while setup was working — abort it first.',
      });
      return;
    }
    dressSession(session, dress);
    const preview = await buildPreviewPost(session);
    await channelIo(channel).post(preview);
    markPreviewPosted(session);
    // Where the odds preview just landed — the audit line for an in-Activity edit (#220) posts
    // here, since it fires before `begin` has captured `channelId`.
    session.lobbyChannelId = interaction.channelId;
    // What an in-Activity re-import (#219) refetches: the exact league + season this setup opened,
    // and the member allowed to ask for it. A manual `teams:` setup leaves leagueId unset, so a
    // re-import correctly refuses — there is no ESPN league behind it.
    session.leagueId = resolvedLeagueId;
    session.season = season;
    session.commissionerIds = [interaction.user.id];
    setCeremony(session);
    // The Activity's "start a lottery" press (#253) anchors here next time — a doorbell from a
    // dead-idle stage has no channel of its own.
    memo.remember(guildId, interaction.channelId);

    // Best-effort: arm the Activity lobby (#198) so members can join before `begin`.
    // Failures are logged but never propagate — the ceremony state is already committed above.
    // `commissionerIds` is what makes the lobby editable from inside the Activity (#210): the
    // member who ran this command, which `denyUnlessCommissioner` already gated on Manage Server.
    // No `keepAdjustments` — this is a brand-new bag, so edits to the previous one are meaningless.
    const lobbyRows = oddsRows(session);
    const armStage = stageFromEnv();
    void armStage
      .lobby({
        title: session.title,
        teamCount: session.config.teams.length,
        totalBalls: lobbyRows.reduce((s, r) => s + r.balls, 0),
        rows: lobbyRows,
        guildId,
        commissionerIds: [interaction.user.id],
      })
      .then(() => {
        // Deliver the logos the api can't fetch itself (#249): ESPN-hosted art needs the league's
        // cookies, stock logos need rasterizing. Strictly AFTER the lobby claimed the stage — a
        // rejected arm (another guild's ceremony owns it) must not seed the shared cache with
        // this guild's art under colliding ESPN team ids.
        pushSessionLogos(session, context, armStage);
      })
      .catch((error: unknown) => {
        console.error('[draftorder] failed to arm the Activity lobby:', error);
      });

    await interaction.editReply({
      content: [
        `Odds preview posted — the bag is frozen at ${teams.length} teams. ` +
          'Run `/canon draftorder begin` to post the commitment and start the reveal. ' +
          'Changing teams/balls means re-running setup (fresh public preview) first. ' +
          'Build the countdown with `/canon draftorder hype`.',
        ...notes,
      ].join('\n'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ content: `Setup failed: ${message}` });
  }
}

/**
 * `stage` is injected so tests never open a socket (same seam as
 * {@link recoverInterruptedCeremonies}). One client for the whole handler: the pre-commitment
 * drain (#210), the channel-mode lobby disarm, and the reveal pacing all talk to the same stage.
 */
export async function handleDraftOrderBeginSubcommand(
  interaction: ChatInputCommandInteraction,
  stage: InspectableRevealStage = stageFromEnv(),
): Promise<void> {
  if (!(await denyUnlessCommissioner(interaction))) return;
  const guildId = interaction.guildId as string;

  const session = getCeremony(guildId);
  if (!session || session.state !== 'GAME_OPEN') {
    await interaction.reply({
      content:
        session?.state === 'LOTTERY_RUNNING'
          ? 'The ceremony is already running.'
          : 'No ceremony is set up — run `/canon draftorder setup` first (it posts the odds preview).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (session.miniGameActive || session.reimportActive) {
    await interaction.reply({
      content: session.reimportActive
        ? 'A re-import from ESPN is still publishing — wait for its odds card, then `begin`.'
        : 'A reaction round is still collecting clicks — the bag is in flux. Wait for its results post, then `begin`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = sendableChannel(interaction);
  if (!channel) {
    await interaction.reply({
      content: "I can't post in this channel — check my permissions.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const delaySeconds = interaction.options.getInteger('delay') ?? DEFAULT_REVEAL_DELAY_SECONDS;
  const stageMode = interaction.options.getString('stage') ?? 'channel';
  const direction = (interaction.options.getString('direction') ?? 'worst-to-first') as
    'worst-to-first' | 'first-to-last';
  const visual = (interaction.options.getString('visual') ?? 'machine') as 'machine' | 'race';

  const directionNote =
    direction === 'first-to-last' ? ' Revealing pick #1 first (first-to-last).' : '';
  await interaction.reply({
    content: `Sealing the bag — commitment posts now, first reveal ~${delaySeconds}s after its drum roll.${stageMode === 'activity' ? ' The reveal streams in the Lottery Machine Activity.' : ''}${directionNote} Abort with \`/canon draftorder abort\` (the seed gets revealed either way).`,
    flags: MessageFlags.Ephemeral,
  });

  // Re-validate after the reply await: an abort (or a replacing setup) may have raced us.
  // runCeremony's own pre-commit abort check is the backstop; this avoids even starting.
  // A reaction round that armed while we awaited the reply also stops us — sealing the bag
  // would just doom that round to a public discard — and a concurrent `begin` that already
  // moved the state gets a clean refusal instead of an assertTransition error in the log.
  // Widened via assertion: another handler can mutate the state across the await above, which
  // TS's narrowing (still "GAME_OPEN" from the top guard, even through a const alias) can't see.
  const stateNow = session.state as DraftOrderState;
  if (
    getCeremony(guildId) !== session ||
    session.abort.signal.aborted ||
    session.miniGameActive ||
    session.reimportActive ||
    stateNow !== 'GAME_OPEN'
  ) {
    const content = session.reimportActive
      ? 'A re-import from ESPN started just now — wait for its odds card, then `begin`.'
      : session.miniGameActive
        ? 'A reaction round armed just now — wait for its results post, then `begin`.'
        : stateNow === 'LOTTERY_RUNNING'
          ? 'The ceremony is already running.'
          : 'The ceremony was aborted before it could start — nothing was committed.';
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  // The commitment + reveal post to *this* channel, which may differ from where `setup` ran — so
  // recovery discloses beside the commitment, capture it here, not at setup (#176).
  session.channelId = interaction.channelId;

  // #210: the single drain point for in-Activity ball edits. The stage holds them as a pending
  // delta; this is where they become the authoritative bag, and it has to happen before the
  // commitment binds anything. Runs in channel mode too — the lobby is armed from `setup`
  // regardless of how `begin` is run, so an edit made there must not be silently dropped.
  await foldInActivityEdits(
    session,
    channel,
    (content) => interaction.followUp({ content, flags: MessageFlags.Ephemeral }),
    stage,
  );

  // Re-validate after the drain's awaits (stage read, card render, preview post) — same pattern as
  // the block above and as `setup`/`hype`/`minigame`. A replacing `setup` during those awaits has
  // already posted its own public preview; starting this session now would put a commitment for
  // the *old* bag into the channel after it. A reaction round that armed meanwhile is the same
  // hazard the earlier block guards: sealing a bag in flux dooms that round to a public discard.
  if (
    getCeremony(guildId) !== session ||
    session.abort.signal.aborted ||
    session.miniGameActive ||
    session.reimportActive ||
    (session.state as DraftOrderState) !== 'GAME_OPEN'
  ) {
    await interaction
      .followUp({
        content: session.reimportActive
          ? 'A re-import from ESPN started while the Activity edits were being applied — wait for its odds card, then `begin`.'
          : session.miniGameActive
            ? 'A reaction round armed while the Activity edits were being applied — wait for its results post, then `begin`.'
            : 'The ceremony changed while the Activity edits were being applied — nothing was committed.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  // Activity mode (#169): invite the league into the Lottery Machine before the commitment posts.
  // The reveal itself streams there; commitment, final board, and seed reveal still post here.
  // Best-effort — a failed invite post (permissions, transient API error) must never block the
  // ceremony itself, which the commissioner was just told is starting.
  if (stageMode === 'activity') {
    try {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${DRAFT_ORDER_LAUNCH_ID}:${session.createdAt}`)
          .setLabel('🎰 Open the Lottery Machine')
          .setStyle(ButtonStyle.Primary),
      );
      await channel.send({
        content: `🎰 **${session.title}** — the ball-by-ball reveal streams live in the Lottery Machine. Click to watch; the commitment, final board, and seed verification still post right here.`,
        components: [row],
        allowedMentions: { parse: [] }, // uniform ceremony-surface policy (#222)
      });
    } catch (error) {
      console.error('[draftorder] failed to post the lottery-machine launch button:', error);
      await interaction
        .followUp({
          content:
            'Could not post the Lottery Machine button — the ceremony still runs (members can open the Activity from the app launcher).',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }

  // Channel mode never touches the stage, so the lobby `setup` armed (#198) would otherwise sit
  // there forever — showing pre-draw odds after the order is public, and shadowing the draft
  // dashboard at the Activity root. Disarm it now; activity mode's `start` replaces it instead.
  if (stageMode !== 'activity') {
    void stage.clear({ guildId }).catch((error: unknown) => {
      console.error('[draftorder] failed to disarm the Activity lobby for a channel run:', error);
    });
  }

  // Fire and forget: the ceremony runs on channel messages and outlives this interaction's
  // 15-minute token. Errors land in the channel via the abort disclosure + the log.
  void runCeremony(session, channelIo(channel), {
    delayMs: delaySeconds * 1000,
    direction,
    visual,
    store: createFileCeremonyStore(),
    stage: stageMode === 'activity' ? stage : undefined,
  }).catch((error) => {
    if (!(error instanceof CeremonyAborted)) {
      console.error('[draftorder] ceremony failed:', error);
    }
  });
}

/**
 * Fold the commissioner's in-Activity ball edits (#210) into the bag `begin` is about to commit,
 * and — when anything actually changed — post the fresh public odds card ADR 0006 requires after
 * a bag change. The channel post is what keeps "the Discord posts are the record" true: an edit
 * made in the Activity ends up named in the channel beside the commitment it produced.
 *
 * Best-effort by design. An unreachable stage means nobody could be looking at the Activity
 * either, so the ceremony proceeds on the un-edited bag rather than blocking on presentation —
 * but the commissioner is told via `warn`, because it's the one case where what they saw and what
 * gets committed can differ. `warn` is a callback because `begin` has two front doors: the slash
 * handler warns ephemerally, the Activity's seal button (#233) has no interaction to whisper
 * through, so its warning goes to the channel.
 */
async function foldInActivityEdits(
  session: CeremonySession,
  channel: SendableChannel,
  warn: (content: string) => Promise<unknown>,
  stage: InspectableRevealStage,
): Promise<void> {
  // Undo point: everything below the stage read can fail *after* the bag is edited (the odds card
  // renders, then goes to Discord). Committing a half-published bag is precisely the ADR 0006
  // failure this whole drain exists to prevent, so a failure rolls all the way back.
  const before = captureBag(session);
  try {
    const snapshot = await stage.state();
    // The stage is one process-wide slot serving one ceremony at a time (multi-league partitioning
    // is #191), and team ids collide across guilds trivially — manual setups produce `team-1`,
    // ESPN produces small integers. So a lobby belonging to anyone else is not ours to drain:
    // another guild's edits must never land in this guild's bag.
    if (snapshot.phase !== 'lobby' || snapshot.lobby?.guildId !== session.guildId) return;
    const applied = applyLobbyAdjustments(session, snapshot.adjustments ?? []);
    const renamed = applyLobbyRenames(session, snapshot.renames ?? []);
    if (applied.length === 0 && renamed.length === 0) return;
    await channelIo(channel).post(await buildAdjustedPreviewPost(session, applied, renamed));
    console.log(
      `[draftorder] folded ${applied.length} ball edit(s) and ${renamed.length} rename(s) into the bag before committing`,
    );
  } catch (error) {
    restoreBag(session, before);
    console.error('[draftorder] failed to fold in the Activity ball edits:', error);
    await warn(
      "Couldn't apply the Lottery Machine's pending edits — committing the bag as `setup` left it. " +
        'If you adjusted balls in the Activity, abort and re-run `setup` with the `balls:` option.',
    ).catch(() => {});
  }
}

/**
 * Post an in-Activity edit's audit line (#220) to the channel where that guild's `setup` ran.
 *
 * Routed strictly through this process's own ceremony registry: an edit only reaches Discord if
 * *this* bot holds a still-open (`GAME_OPEN`) ceremony for that guild, so a stale lobby on a
 * shared stage can never make the bot post into a league it isn't running. Returns false when
 * there is nowhere legitimate to post, which the watcher treats as "drop it".
 */
export function postActivityEditLine(
  client: Client,
): (guildId: string | undefined, content: string) => Promise<boolean> {
  return async (guildId, content) => {
    if (!guildId) return false;
    const session = getCeremony(guildId);
    // Past GAME_OPEN the bag is sealed and the stage can't be showing an editable lobby for us —
    // anything arriving then is stale, and posting it beside a commitment would be misleading.
    if (!session || session.state !== 'GAME_OPEN' || !session.lobbyChannelId) return false;
    const channelId = session.lobbyChannelId;
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable()) return false;
    // Re-check after the fetch: a `begin`, `abort`, or replacing `setup` can land while Discord is
    // answering, and the guard above is the whole reason this line is safe to send. Same pattern
    // the ceremony handlers use after their awaits.
    const current = getCeremony(guildId);
    if (
      current !== session ||
      current.state !== 'GAME_OPEN' ||
      current.lobbyChannelId !== channelId
    ) {
      return false;
    }
    // Team names come from ESPN, so a league could have one called `@everyone`. This announcement
    // never needs to mention anyone; without this it would ping the server on every edit. The
    // SuppressNotifications flag (#252, live commissioner feedback) keeps the line as channel
    // record without badging the whole league for every stepper tap.
    await channel.send({
      content,
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressNotifications,
    });
    return true;
  };
}

/**
 * Honour an in-Activity "re-import from ESPN" request (#219).
 *
 * The api has no league config and no ESPN cookies, so the Activity can only *ask*; this is where
 * the refetch actually happens. It rebuilds the bag exactly the way `setup` does — `resolveEspnTeams`
 * for the roster, then last season's standings weights (#165) — publishes a fresh public odds
 * preview, and re-arms the lobby with the result.
 *
 * **Pending edits are dropped**, which is why the re-arm carries no `keepAdjustments`: the whole
 * point of a refetch is to start from what ESPN says now, and a ball edit or rename made against
 * the roster it replaces is stale. The fresh preview shows exactly what survived.
 *
 * Season and league come from the session and the guild's config, so a re-import can never
 * silently retarget a different league than the one `setup` opened.
 */
export function performActivityReimport(
  client: Client,
  context: BotContext,
  stage: InspectableRevealStage = stageFromEnv(),
): (guildId: string | undefined) => Promise<boolean> {
  return async (guildId) => {
    if (!guildId) return false;
    const session = getCeremony(guildId);
    if (!session || session.state !== 'GAME_OPEN' || !session.lobbyChannelId) return false;
    const { leagueId, season } = session;
    if (!leagueId || season === undefined) {
      // A manual `teams:` setup has no ESPN league behind it, so there is nothing to refetch.
      console.error('[draftorder] re-import requested for a ceremony with no ESPN league');
      return false;
    }
    const channel = await client.channels.fetch(session.lobbyChannelId);
    if (!channel?.isSendable()) return false;

    // Forced refresh, not the cache-first `setup` path: every ESPN-backed setup has already cached
    // this league/season/view, so a cache read would hand back exactly the roster the commissioner
    // is asking us to replace and the re-import would silently do nothing.
    const teams = await resolveEspnTeams(context, leagueId, season, true);
    const notes = await applyStandingsWeights(context, leagueId, season, teams, true);
    // The refetched roster's logo bytes (#254), fetched HERE with the other slow round-trips —
    // never between the re-validation below and the roster install, which must stay adjacent.
    const dress = await fetchSessionLogoDress(teams, context);
    // Re-validate after the round-trips above (ESPN, logo prefetch) — a `begin`/`abort`/replacing
    // `setup` can land while we were fetching, and rebuilding a session that is no longer current
    // would be a silent clobber of whatever replaced it.
    const current = getCeremony(guildId);
    if (current !== session || current.state !== 'GAME_OPEN') return false;

    // Validate the refetched roster the way `createCeremony` would, *before* installing it. ESPN
    // can hand back two teams with the same display name (or a league that outgrew the odds DP
    // cap), and a session built straight from that would only fail later — at `begin`, or on an
    // unrelated rename whose uniqueness check trips over it.
    const refetched = teams.map((team) => ({
      teamId: team.teamId,
      displayName: team.name,
      baseBalls: team.baseBalls,
      bonusBalls: team.bonusBalls,
    }));
    const seenNames = new Set<string>();
    for (const team of refetched) {
      const key = (team.displayName ?? team.teamId).toLowerCase();
      if (seenNames.has(key)) {
        throw new Error(
          `ESPN returned two teams called "${team.displayName}" — re-import refused.`,
        );
      }
      seenNames.add(key);
    }
    computePickOdds(refetched, session.config.baseBallCount);

    // The bag is about to change and its fresh public preview has not posted yet, so `begin` must
    // not be able to seal it in between — exactly the interlock `miniGameActive` provides for the
    // reaction round. Without it a commitment could go out for the new bag *before* the preview
    // that ADR 0006 requires to precede it.
    session.reimportActive = true;
    const previous = {
      teams: session.config.teams,
      names: session.names,
      logos: session.logos,
      logoBytes: session.logoBytes,
      miniGameBonuses: session.miniGameBonuses,
    };
    try {
      // The whole install is synchronous — nothing may suspend between the first field and the
      // last, or a reaction round scoring in the gap would bake bonuses into a half-built roster.
      session.config.teams = refetched;
      session.names = new Map(teams.map((team) => [team.teamId, team.name]));
      // Logos travel with the roster they belong to (#242), bytes prefetched above (#254) so
      // the fresh preview below can wear them.
      dressSession(session, dress);
      // A refetched roster invalidates whatever the mini-game awarded against the old one.
      session.miniGameBonuses = undefined;

      const rows = oddsRows(session);
      try {
        await channel.send({
          content: [
            `🔄 **${session.title}** — the commissioner re-imported the league from ESPN.`,
            `${teams.length} teams, ${rows.reduce((sum, row) => sum + row.balls, 0)} balls. Any earlier in-Activity edits were reset.`,
            ...notes,
          ].join('\n'),
          allowedMentions: { parse: [] },
        });
        await channelIo(channel).post(await buildPreviewPost(session));
      } catch (error) {
        // The card render or the channel send failed, so the new bag has no public preview. Keeping
        // it would let a later `begin` commit a bag the league never saw — put the old one back.
        session.config.teams = previous.teams;
        session.names = previous.names;
        session.logos = previous.logos;
        session.logoBytes = previous.logoBytes;
        session.miniGameBonuses = previous.miniGameBonuses;
        throw error;
      }

      // Best-effort: the refetch and the public preview have already landed, so a stage that is
      // down must not turn a completed re-import into a failure. The next `setup`/`begin` re-arms.
      await stage
        .lobby({
          title: session.title,
          teamCount: session.config.teams.length,
          totalBalls: rows.reduce((sum, row) => sum + row.balls, 0),
          rows,
          guildId,
          commissionerIds: session.commissionerIds ?? [],
        })
        .then(() => {
          // The refetched roster's logos travel the same push channel as setup's (#249), and
          // with the same ordering rule: only after the re-arm proved this guild still owns the
          // stage. Entries record their source URL, so a changed logo replaces cleanly.
          pushSessionLogos(session, context, stage);
        })
        .catch((error: unknown) => {
          console.error(
            '[draftorder] re-imported, but could not re-arm the Activity lobby:',
            error,
          );
        });
    } finally {
      session.reimportActive = false;
    }
    console.log(`[draftorder] re-imported ${teams.length} teams from ESPN for guild ${guildId}`);
    return true;
  };
}

/**
 * Free a pending Activity begin press this bot can never honour from where it stands (#233): a
 * keepAdjustments re-arm republishes the bag exactly as it is pending edits and all, which clears
 * `beginRequested` at the source and re-enables every commissioner's button. Fire-and-forget —
 * the refusal stands either way, and if the stage is down there is no stuck button to free.
 */
function releaseBeginRequest(
  session: CeremonySession,
  stage: InspectableRevealStage,
  guildId: string,
): void {
  const rows = oddsRows(session);
  void stage
    .lobby({
      title: session.title,
      teamCount: session.config.teams.length,
      totalBalls: rows.reduce((sum, row) => sum + row.balls, 0),
      rows,
      guildId,
      commissionerIds: session.commissionerIds ?? [],
      keepAdjustments: true,
    })
    .catch((error: unknown) => {
      console.error('[draftorder] could not release the pending Activity begin press:', error);
    });
}

/**
 * Honour an in-Activity "seal the bag & start the draw" request (#233).
 *
 * The Activity's button is a doorbell: the api records the request and broadcasts it, and this is
 * where the ceremony actually starts — the **identical** flow as `/canon draftorder begin` in
 * activity mode (drain pending edits with their fresh public odds card, post the launch invite,
 * commit in-channel, start the paced reveal), so ADR 0006's audit trail is byte-for-byte the same
 * shape regardless of which front door was used. The bot stays the sole committer.
 *
 * Refusals return false and post nothing, and none of them can strand the Activity in
 * "sealing…": a press this bot can never honour from here (no lobby channel recorded, channel
 * unreachable or unsendable) actively *releases* the request via a keepAdjustments re-arm, while
 * every other refusal is already on a path that clears it — state moved (the winning `begin`'s
 * `start`/`clear` replaces the lobby), the interlocks (mini-game and re-import both end in a
 * re-arm), an abort (tears the stage down), or a bot restart (the boot reconciler clears the
 * orphaned lobby).
 */
export function performActivityBegin(
  client: Client,
  stage: InspectableRevealStage = stageFromEnv(),
  run: typeof runCeremony = runCeremony,
): (guildId: string | undefined, request: StageBeginRequest) => Promise<boolean> {
  return async (guildId, request) => {
    if (!guildId) return false;
    const session = getCeremony(guildId);
    if (!session || session.state !== 'GAME_OPEN') return false;
    if (session.miniGameActive || session.reimportActive || session.abort.signal.aborted) {
      return false;
    }
    if (!session.lobbyChannelId) {
      // Defensive — `setup` always records it — but nothing else would ever clear the press.
      releaseBeginRequest(session, stage, guildId);
      return false;
    }
    // Belt over the watcher's frame guard: this function is exported, and the delay becomes real
    // timer pacing — junk falls back to the slash command's default rather than being honoured.
    const delaySeconds =
      Number.isInteger(request.delaySeconds) &&
      request.delaySeconds >= 5 &&
      request.delaySeconds <= 60
        ? request.delaySeconds
        : DEFAULT_REVEAL_DELAY_SECONDS;
    const direction = request.direction === 'first-to-last' ? 'first-to-last' : 'worst-to-first';
    const visual = request.visual === 'race' ? 'race' : 'machine';
    const ballFaces = request.ballFaces === 'logos' ? 'logos' : 'numbers';

    const channel = await client.channels.fetch(session.lobbyChannelId).catch(() => null);
    if (!channel?.isSendable()) {
      // Misconfiguration (bot lost the channel or its send permission): no re-arm is coming from
      // anywhere else, so free the press or every commissioner's button stays disabled for good.
      releaseBeginRequest(session, stage, guildId);
      return false;
    }
    // Re-validate after the fetch — same discipline as the slash handler after its reply await: a
    // slash `begin`, an abort, or a replacing `setup` can land while Discord round-trips.
    if (
      getCeremony(guildId) !== session ||
      session.abort.signal.aborted ||
      session.miniGameActive ||
      session.reimportActive ||
      (session.state as DraftOrderState) !== 'GAME_OPEN'
    ) {
      return false;
    }

    // The commitment + reveal post where `setup` ran — an Activity press has no "this channel".
    session.channelId = session.lobbyChannelId;

    // Same single drain point as the slash path (#210). The presser has no ephemeral surface, so
    // the drain-failure warning goes to the channel the ceremony is anchored in.
    await foldInActivityEdits(
      session,
      channel,
      (content) => channel.send({ content: `⚠️ ${content}`, allowedMentions: { parse: [] } }),
      stage,
    );
    // Re-validate after the drain's awaits (stage read, card render, preview post) — a replacing
    // `setup` in that window has already posted its own preview, and sealing the old bag after it
    // is exactly what the slash handler's twin check prevents.
    if (
      getCeremony(guildId) !== session ||
      session.abort.signal.aborted ||
      session.miniGameActive ||
      session.reimportActive ||
      (session.state as DraftOrderState) !== 'GAME_OPEN'
    ) {
      return false;
    }

    // One post carries the audit line ("who sealed, from where") and the launch invite — the
    // in-channel record ADR 0006 wants, in the slot the slash path's ephemeral reply + launch
    // button occupy. Best-effort like the slash path's button post: a failed invite must never
    // block the ceremony, whose commitment is the actual record.
    try {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${DRAFT_ORDER_LAUNCH_ID}:${session.createdAt}`)
          .setLabel('🎰 Open the Lottery Machine')
          .setStyle(ButtonStyle.Primary),
      );
      const who = request.requestedBy ? `<@${request.requestedBy}>` : 'The commissioner';
      await channel.send({
        content: `🔒 **${session.title}** — ${who} sealed the bag from inside the Lottery Machine. The commitment posts now; first reveal ~${delaySeconds}s after its drum roll, streaming live in the Activity.`,
        components: [row],
        allowedMentions: { parse: [] }, // uniform ceremony-surface policy (#222)
      });
    } catch (error) {
      console.error('[draftorder] failed to post the Activity-begin seal line:', error);
    }
    // Re-validate once more after the seal line's await — the same replacing-`setup` hazard as
    // the checkpoints above, one await later. A detached session must never commit after the
    // replacement's fresh preview; the stray seal line (already posted) is cosmetic, the
    // commitment is what must not follow it.
    if (
      getCeremony(guildId) !== session ||
      session.abort.signal.aborted ||
      session.miniGameActive ||
      session.reimportActive ||
      (session.state as DraftOrderState) !== 'GAME_OPEN'
    ) {
      return false;
    }

    // Fire and forget, exactly as the slash handler does: the ceremony runs on channel messages.
    // `stage` always rides along — an Activity-initiated begin is activity mode by definition.
    void run(session, channelIo(channel), {
      delayMs: delaySeconds * 1000,
      direction,
      visual,
      ballFaces,
      store: createFileCeremonyStore(),
      stage,
    }).catch((error) => {
      if (!(error instanceof CeremonyAborted)) {
        console.error('[draftorder] ceremony failed:', error);
      }
    });
    return true;
  };
}

/**
 * Honour a "start a lottery" press from a dead-idle stage (#253).
 *
 * The one doorbell whose authority the lobby cannot vouch for — there IS no lobby yet — so the
 * gate is the slash command's own: **Manage Server in the named guild, verified against
 * Discord**, never against anything the client claimed. Past the gate this is the slash `setup`
 * ESPN path verbatim: import the roster, derive standings weights, post the public odds preview
 * (to the guild's remembered lottery channel — a doorbell has no channel of its own), stamp the
 * presser as commissioner, arm the lobby (which answers the doorbell at the stage), push logos.
 *
 * Every refusal *releases* the press with a reason the idle screens show once (#236's rule):
 * a denied press must never strand every viewer's start button.
 */
export function performActivitySetup(
  client: Client,
  context: BotContext,
  stage: InspectableRevealStage = stageFromEnv(),
  memo: LotteryChannelMemo = fileChannelMemo,
): (request: StageSetupRequest) => Promise<boolean> {
  return async (request) => {
    const { guildId, requestedBy, season } = request;
    const release = (reason: string): false => {
      void stage.setupRelease?.({ guildId, reason }).catch((error: unknown) => {
        console.error('[draftorder] could not release the setup press:', error);
      });
      return false;
    };

    let allowed: boolean;
    try {
      const guild = await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(requestedBy);
      allowed = member.permissions.has(PermissionFlagsBits.ManageGuild);
    } catch (error) {
      console.error('[draftorder] setup press permission check failed:', error);
      return release('could not verify your server permissions — try again in a moment');
    }
    if (!allowed) {
      return release('only a member with Manage Server can start the lottery');
    }

    if (getCeremony(guildId)?.state === 'LOTTERY_RUNNING') {
      return release('a ceremony is already running — abort it first');
    }

    const channelId = memo.recall(guildId);
    if (!channelId) {
      return release(
        'run /canon draftorder setup once from your lottery channel — after that the Activity remembers it',
      );
    }
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) {
      return release(
        'the remembered lottery channel is unreachable — run /canon draftorder setup once from the channel you want',
      );
    }

    const leagueId =
      (await context.leagueConfigRepo.getByGuildId(guildId))?.leagueId ??
      context.env.defaultLeagueId;
    if (!leagueId) {
      return release('no ESPN league is configured for this server — use /canon draftorder setup');
    }

    try {
      const teams = await resolveEspnTeams(context, leagueId, season);
      const notes = await applyStandingsWeights(context, leagueId, season, teams);
      const configTeams: DraftOrderTeamInput[] = teams.map((team) => ({
        teamId: team.teamId,
        displayName: team.name,
        baseBalls: team.baseBalls,
        bonusBalls: team.bonusBalls,
      }));
      const names = new Map(teams.map((team) => [team.teamId, team.name]));
      // Throws on a roster `begin` would later choke on (duplicate names, odds cap) — caught
      // below and released with the reason, before anything posts.
      const session = createCeremony(
        guildId,
        `${season} Draft Lottery`,
        { teams: configTeams, baseBallCount: 1 },
        names,
      );
      // Fetched (bounded) before the re-validation below — the check-then-act window must not
      // span this network wait — and before the preview renders so the card wears them (#254).
      const dress = await fetchSessionLogoDress(teams, context);

      // Re-validate after the round-trips above (ESPN, logo prefetch), same as the slash
      // handler: replacing a session that started running meanwhile would orphan a live draw.
      if (getCeremony(guildId)?.state === 'LOTTERY_RUNNING') {
        return release('a ceremony started while the import was running');
      }
      dressSession(session, dress);

      // The preview is the public record the whole feature hangs off (ADR 0006). The intro line
      // names who pressed the button — the same audit slot the slash runner's command invocation
      // occupies in the channel history. The setup notes ride here too: there is no ephemeral
      // surface to whisper them through.
      await channel.send({
        content: [
          `🎰 **${session.title}** — <@${requestedBy}> started the lottery from the Activity.`,
          ...notes,
        ].join('\n'),
        allowedMentions: { parse: [] },
      });
      await channelIo(channel).post(await buildPreviewPost(session));
      markPreviewPosted(session);
      session.lobbyChannelId = channelId;
      session.leagueId = leagueId;
      session.season = season;
      session.commissionerIds = [requestedBy];
      setCeremony(session);
      memo.remember(guildId, channelId);

      const lobbyRows = oddsRows(session);
      await stage
        .lobby({
          title: session.title,
          teamCount: session.config.teams.length,
          totalBalls: lobbyRows.reduce((s, r) => s + r.balls, 0),
          rows: lobbyRows,
          guildId,
          commissionerIds: [requestedBy],
        })
        .then(() => {
          pushSessionLogos(session, context, stage);
        })
        .catch((error: unknown) => {
          // The ceremony exists and its preview is public — but the arm is what answers the
          // doorbell, so a failed arm must still free the idle screens.
          console.error('[draftorder] Activity setup armed nothing — stage unreachable:', error);
          release(
            'the stage is unreachable — the ceremony is set up; continue with /canon draftorder',
          );
        });
      console.log(
        `[draftorder] Activity setup: ${teams.length} teams for guild ${guildId} by ${requestedBy}`,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[draftorder] in-Activity setup failed:', error);
      return release(`setup failed: ${message.slice(0, 200)}`);
    }
  };
}

/**
 * Start watching the stage for commissioner activity (#220 edits, #219 re-import requests,
 * #233 begin requests, #253 setup requests). Best-effort and non-blocking: an unreachable api
 * just retries with backoff, and nothing about the ceremony depends on it — `begin` still
 * re-posts the full odds card before the commitment.
 */
export function watchActivityEdits(
  client: Client,
  context: BotContext,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const watcher = createStageWatcher({
    baseUrl: env.FANTASY_STAGE_URL ?? DEFAULT_STAGE_URL,
    post: postActivityEditLine(client),
    reimport: performActivityReimport(client, context),
    begin: performActivityBegin(client),
    setup: performActivitySetup(client, context),
  });
  watcher.start();
}

/** Component id prefix for the ceremony's LAUNCH_ACTIVITY button (#169). */
export const DRAFT_ORDER_LAUNCH_ID = 'canon:draftorder:launch';

/**
 * The "Open the Lottery Machine" button: responds with LAUNCH_ACTIVITY (type 12), which opens the
 * Activity iframe for the clicking member. Launching is idempotent and harmless when stale, so no
 * session-marker validation — the machine simply shows whatever the stage currently holds.
 */
export async function handleDraftOrderLaunchButton(interaction: ButtonInteraction): Promise<void> {
  try {
    await interaction.launchActivity();
  } catch (error) {
    console.error('[draftorder] launchActivity failed:', error);
    await interaction
      .reply({
        content:
          'Could not launch the Lottery Machine — Activities may not be enabled for this app yet (see #168). The reveal still runs; results post in this channel.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }
}

export const DEFAULT_MINIGAME_WINDOW_SECONDS = DEFAULT_WINDOW_MS / 1000;

export async function handleDraftOrderMinigameSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await denyUnlessCommissioner(interaction))) return;
  const guildId = interaction.guildId as string;

  const session = getCeremony(guildId);
  if (!session || session.state !== 'GAME_OPEN') {
    await interaction.reply({
      content:
        session?.state === 'LOTTERY_RUNNING'
          ? 'The bag is already sealed — the mini-game has to run before `begin`.'
          : 'No ceremony is set up — run `/canon draftorder setup` first, then the mini-game, then `begin`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (session.miniGameActive) {
    await interaction.reply({
      content: 'A reaction round is already in progress.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = sendableChannel(interaction);
  if (!channel) {
    await interaction.reply({
      content: "I can't post in this channel — check my permissions.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const windowSeconds = interaction.options.getInteger('window') ?? DEFAULT_MINIGAME_WINDOW_SECONDS;

  await interaction.reply({
    content: `Reaction round armed — GO flips after a surprise delay, then a ${windowSeconds}s click window. Results and a fresh odds preview post when it closes.`,
    flags: MessageFlags.Ephemeral,
  });

  // Re-validate after the reply await: an abort, a replacing setup, or another round may have
  // raced us. finishReactionRound re-checks at scoring time; this avoids even arming.
  if (getCeremony(guildId) !== session || session.state !== 'GAME_OPEN' || session.miniGameActive) {
    await interaction.followUp({
      content: 'The ceremony changed before the round could arm — nothing was posted.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.miniGameActive = true;
  try {
    // Awaited on purpose (unlike `begin`): the round lasts well under a minute, and holding
    // `miniGameActive` for its whole life is what lets `begin` refuse to seal a bag in flux.
    await runReactionRound(session, channel, channelIo(channel), {
      windowMs: windowSeconds * 1000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[minigame] reaction round failed:', error);
    await interaction
      .followUp({ content: `Reaction round failed: ${message}`, flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
  } finally {
    session.miniGameActive = false;
    // Best-effort: re-arm the Activity lobby so the odds reflect the updated bag.
    // Guard: only re-arm if the session is still live and hasn't moved past GAME_OPEN.
    if (getCeremony(guildId) === session && session.state === 'GAME_OPEN') {
      const lobbyRows = oddsRows(session);
      void stageFromEnv()
        .lobby({
          title: session.title,
          teamCount: session.config.teams.length,
          totalBalls: lobbyRows.reduce((s, r) => s + r.balls, 0),
          rows: lobbyRows,
          guildId,
          commissionerIds: [interaction.user.id],
          // These rows come from the session, which has *not* absorbed any in-Activity edits yet
          // (#210 — `begin` is the single drain point). Without this the re-arm would silently
          // revert the commissioner's adjustments in front of everyone watching.
          keepAdjustments: true,
        })
        .catch((error: unknown) => {
          console.error('[draftorder] failed to re-arm the Activity lobby after minigame:', error);
        });
    }
  }
}

export async function handleDraftOrderStatusSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const session = interaction.guildId ? getCeremony(interaction.guildId) : undefined;
  if (!session) {
    await interaction.reply({
      content: 'No lottery ceremony in this server. `/canon draftorder setup` starts one.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const lines = [
    `**${session.title}** — state: \`${session.state}\``,
    `${session.config.teams.length} teams, base ${session.config.baseBallCount ?? 1} ball(s) each.`,
  ];
  if (session.commitment) {
    lines.push(`Commitment: \`${session.commitment}\``);
  }
  if (session.state === 'FINALIZED' && session.draws) {
    const order = session.draws
      .slice()
      .sort((a, b) => a.pick - b.pick)
      .map((d) => `#${d.pick} ${session.names.get(d.teamId) ?? d.teamId}`)
      .join(' · ');
    lines.push(order);
  }
  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

export async function handleDraftOrderAbortSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await denyUnlessCommissioner(interaction))) return;
  const guildId = interaction.guildId as string;

  const session = getCeremony(guildId);
  if (!session) {
    await interaction.reply({
      content: 'No ceremony to abort.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (session.state === 'LOTTERY_RUNNING') {
    // The running ceremony posts the ADR 0006 disclosure (seed revealed) and flips to CANCELLED.
    requestAbort(session);
    clearCeremony(guildId);
    await interaction.reply({
      content: 'Aborting — the committed seed gets revealed in the channel (nothing stays hidden).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Flip the signal even for not-yet-running sessions so a raced `begin` cannot start the
  // ceremony after this abort (its pre-commit check sees the aborted signal).
  requestAbort(session);
  clearCeremony(guildId);
  const channel = sendableChannel(interaction);
  if (session.state === 'GAME_OPEN' && channel) {
    await channelIo(channel).post({
      kind: 'abort',
      content: `⛔ **${session.title}** — setup cancelled before any commitment existed. No seed, nothing drawn.`,
    });
  }
  if (session.state === 'GAME_OPEN') {
    // Nothing was ever committed, so there is no reveal to abort on the stage — just the lobby
    // `setup` armed (#198). Disarm it so the Activity stops advertising a cancelled ceremony.
    void stageFromEnv()
      .clear({ guildId })
      .catch((error: unknown) => {
        console.error('[draftorder] failed to disarm the Activity lobby on cancel:', error);
      });
  }
  await interaction.reply({ content: 'Ceremony cancelled.', flags: MessageFlags.Ephemeral });
}

/**
 * `/canon draftorder hype` — commissioner-triggered countdown post (#165): rotating copy + the
 * frozen odds card, as a regular channel message. Requires a frozen (GAME_OPEN) bag so the
 * published odds are always exactly what the commitment will bind.
 */
export async function handleDraftOrderHypeSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!(await denyUnlessCommissioner(interaction))) return;
  const guildId = interaction.guildId as string;

  const session = getCeremony(guildId);
  if (!session || session.state !== 'GAME_OPEN') {
    await interaction.reply({
      content:
        session?.state === 'LOTTERY_RUNNING'
          ? 'The ceremony is already running — hype time is over, reveal time is now.'
          : 'No frozen bag to hype — run `/canon draftorder setup` first (it posts the odds preview).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = sendableChannel(interaction);
  if (!channel) {
    await interaction.reply({
      content: "I can't post in this channel — check my permissions.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const note = interaction.options.getString('note') ?? undefined;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const hype = await buildHypePost(session, note);

  // Re-validate after the awaits (defer, card render): a begin/abort/replacing setup may have
  // raced us — never advertise a stale bag as "frozen" next to a fresher public record.
  if (
    getCeremony(guildId) !== session ||
    session.state !== 'GAME_OPEN' ||
    session.abort.signal.aborted
  ) {
    await interaction.editReply({
      content: 'The ceremony changed while the hype card was rendering — nothing was posted.',
    });
    return;
  }
  await channelIo(channel).post(hype);
  await interaction.editReply({ content: 'Hype posted. The hopper thanks you.' });
}

/**
 * On bot startup (#176): for every ceremony that committed but never finalized — a crash/restart
 * between the commitment post and the seed reveal — post the seed disclosure to its origin channel
 * and clear the record. Keeps the ADR 0006 promise that a committed hash is always openable.
 *
 * Best-effort per record: a transient channel-fetch failure leaves the record for the next startup
 * (so an undisclosed seed is never silently dropped); a successful post clears it.
 *
 * Then reconcile the Activity stage (#205). Sessions live only in this process's memory, so after
 * a restart nothing on the stage can still have a pacer: an armed lobby is disarmed (guild-scoped
 * `clear`, from the snapshot's own guild) and a stranded `waiting`/`revealing` run is aborted so
 * viewers see the banner instead of a frozen drum-roll — with the reason pointing at the seed
 * disclosure when this pass just posted one. Assumes the single-bot deployment (this process is
 * the only pacer; multi-tenant partitioning is #191). Skipped entirely while any in-memory
 * ceremony exists — a `setup`'s fresh lobby or a `begin`'s live reveal must never be torn down
 * by a stale snapshot — and the abort is additionally commitment-conditional server-side.
 */
export async function recoverInterruptedCeremonies(
  client: Client,
  store: CeremonyStore = createFileCeremonyStore(),
  stage: InspectableRevealStage = stageFromEnv(),
): Promise<void> {
  const disclosed = new Set<string>();
  for (const record of store.loadPending()) {
    // Never disclose over a ceremony that's live in memory for this guild.
    if (getCeremony(record.guildId)?.state === 'LOTTERY_RUNNING') continue;
    try {
      const channel = record.channelId ? await client.channels.fetch(record.channelId) : null;
      if (!channel || !channel.isSendable()) {
        console.error(
          `[draftorder] interrupted ceremony ${record.commitment.slice(0, 12)}…: channel ${record.channelId} is not sendable; keeping the record`,
        );
        continue;
      }
      // Re-check after the async fetch: a `begin` may have started a live ceremony in the interim.
      if (getCeremony(record.guildId)?.state === 'LOTTERY_RUNNING') continue;
      await channel.send({
        content: interruptedDisclosureContent(record),
        allowedMentions: { parse: [] }, // the stored title can carry ESPN-derived text (#222)
      });
      // Remove by commitment (not guild): a newer run for the same guild has a different key, so
      // this can never clobber a still-undisclosed record.
      store.remove(record.commitment);
      disclosed.add(record.commitment);
      console.log(
        `[draftorder] disclosed interrupted ceremony seed (commitment ${record.commitment.slice(0, 12)}…)`,
      );
    } catch (error) {
      console.error('[draftorder] failed to disclose an interrupted ceremony:', error);
    }
  }
  await reconcileStage(stage, disclosed);
}

/**
 * The #205 stage-reconciliation pass — see {@link recoverInterruptedCeremonies}. Best-effort as a
 * whole: an unreachable api at boot just logs (its in-memory stage will have restarted empty by
 * the time it's back, or the next bot boot sweeps it).
 */
async function reconcileStage(
  stage: InspectableRevealStage,
  disclosed: Set<string>,
): Promise<void> {
  // Any in-memory session — not just a running reveal — means the stage may reflect current
  // state (a `setup` arms its lobby right after `setCeremony`), so tear-down is only safe when
  // this process knows of no ceremony at all.
  if (hasAnyCeremony()) return;
  try {
    const snapshot = await stage.state();
    // Re-check after the async fetch (same pattern as the disclosure loop): a `setup`/`begin`
    // that landed during the GET must not have its fresh state torn down over a stale snapshot.
    if (hasAnyCeremony()) return;
    if (snapshot.phase === 'lobby') {
      // Targeted disarm via the existing lobby-only, guild-scoped route — it can never touch a
      // committed run. (A same-guild `setup` racing this POST is closed off by the interlock
      // above up to server ordering; the residual window is microseconds at boot.)
      await stage.clear({
        ...(snapshot.lobby?.guildId ? { guildId: snapshot.lobby.guildId } : {}),
      });
      console.log('[draftorder] cleared an orphaned Activity lobby left from before the restart');
    } else if (snapshot.phase === 'waiting' || snapshot.phase === 'revealing') {
      const seedPosted = !!snapshot.start?.commitment && disclosed.has(snapshot.start.commitment);
      await stage.abort({
        reason: seedPosted
          ? 'The bot restarted mid-reveal. The secret seed was just disclosed in the channel — verify the commitment there, then re-run setup for a fresh ceremony.'
          : 'The bot restarted mid-reveal, so this ceremony cannot continue. Check the channel for the disclosure, then re-run setup for a fresh ceremony.',
        // Conditional server-side: the stage only aborts if it is still showing THIS committed
        // run, so a fresh `begin` that replaced it mid-flight can never be marked aborted.
        ...(snapshot.start?.commitment ? { ifCommitment: snapshot.start.commitment } : {}),
      });
      console.log(
        `[draftorder] aborted a stranded Activity reveal (commitment ${snapshot.start?.commitment?.slice(0, 12) ?? 'unknown'}…)`,
      );
    }
  } catch (error) {
    console.error('[draftorder] failed to reconcile the Activity stage at startup:', error);
  }
}
