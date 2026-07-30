/**
 * `/canon draftorder` — the draft-order lottery ceremony (#164, ADR 0006).
 *
 * Two-step flow: `setup` posts the public odds preview and freezes the bag; `begin` posts the
 * commitment and runs the paced worst-to-first reveal on regular channel messages (never
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
import { DraftOrderState, DraftOrderTeamInput } from '@fantasy-canon/core';
import { BotContext } from '../../config.js';
import { resolveLeagueId } from '../../lib/leagueId.js';
import { ensureSnapshot } from '../../lib/snapshots.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import { deriveStandingsBaseBalls, extractFinalRanks } from '../../lib/finalStandings.js';
import {
  buildHypePost,
  buildPreviewPost,
  CeremonyAborted,
  CeremonyIo,
  CeremonyPost,
  clearCeremony,
  createCeremony,
  getCeremony,
  interruptedDisclosureContent,
  markPreviewPosted,
  oddsRows,
  requestAbort,
  runCeremony,
  setCeremony,
} from '../../lib/draftOrderCeremony.js';
import { createFileCeremonyStore, type CeremonyStore } from '../../lib/ceremonyStore.js';
import { stageFromEnv } from '../../lib/lotteryStageClient.js';
import { DEFAULT_WINDOW_MS, runReactionRound } from '../../lib/reactionRound.js';

export const DEFAULT_REVEAL_DELAY_SECONDS = 20;

/** Hard cap on bonus balls per team — the bag is materialized ball-by-ball, so unbounded input is a foot-gun. */
export const MAX_BONUS_BALLS = 10;

/** Cap for the `balls` set-override — above any sane standings weight, below bag-size foot-guns. */
export const MAX_BASE_BALLS = 30;

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
      const message = await channel.send({ content: post.content, files });
      return { id: message.id };
    },
  };
}

async function resolveEspnTeams(
  context: BotContext,
  leagueId: string,
  season: number,
): Promise<SetupTeam[]> {
  const payload = await ensureSnapshot(context, leagueId, season, 'mTeam');
  const nameMap = buildTeamNameMap(payload);
  if (nameMap.size === 0) {
    throw new Error(`No teams found for league ${leagueId}, season ${season}.`);
  }
  return [...nameMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([teamId, name]) => ({ teamId: String(teamId), name, bonusBalls: 0 }));
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
): Promise<string[]> {
  const lastSeason = season - 1;
  try {
    const payload = await ensureSnapshot(context, leagueId, lastSeason, 'mTeam');
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
    let teams: SetupTeam[];
    if (manualTeams) {
      teams = parseManualTeams(manualTeams).map((team, index) => ({
        teamId: `team-${index + 1}`,
        name: team.name,
        bonusBalls: team.bonusBalls,
      }));
    } else {
      const leagueId = await resolveLeagueId(interaction, context);
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

    // Re-validate after the awaits above (ESPN fetch, card render): if a ceremony started
    // running meanwhile, replacing it now would orphan a live draw.
    if (getCeremony(guildId)?.state === 'LOTTERY_RUNNING') {
      await interaction.editReply({
        content: 'A ceremony started running while setup was working — abort it first.',
      });
      return;
    }
    const preview = await buildPreviewPost(session);
    await channelIo(channel).post(preview);
    markPreviewPosted(session);
    setCeremony(session);

    // Best-effort: arm the Activity lobby (#198) so members can join before `begin`.
    // Failures are logged but never propagate — the ceremony state is already committed above.
    const lobbyRows = oddsRows(session);
    void stageFromEnv()
      .lobby({
        title: session.title,
        teamCount: session.config.teams.length,
        totalBalls: lobbyRows.reduce((s, r) => s + r.balls, 0),
        rows: lobbyRows,
        guildId,
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

export async function handleDraftOrderBeginSubcommand(
  interaction: ChatInputCommandInteraction,
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
  if (session.miniGameActive) {
    await interaction.reply({
      content:
        'A reaction round is still collecting clicks — the bag is in flux. Wait for its results post, then `begin`.',
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

  await interaction.reply({
    content: `Sealing the bag — commitment posts now, first reveal ~${delaySeconds}s after its drum roll.${stageMode === 'activity' ? ' The reveal streams in the Lottery Machine Activity.' : ''} Abort with \`/canon draftorder abort\` (the seed gets revealed either way).`,
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
    stateNow !== 'GAME_OPEN'
  ) {
    const content = session.miniGameActive
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
    void stageFromEnv()
      .clear({ guildId })
      .catch((error: unknown) => {
        console.error('[draftorder] failed to disarm the Activity lobby for a channel run:', error);
      });
  }

  // Fire and forget: the ceremony runs on channel messages and outlives this interaction's
  // 15-minute token. Errors land in the channel via the abort disclosure + the log.
  void runCeremony(session, channelIo(channel), {
    delayMs: delaySeconds * 1000,
    store: createFileCeremonyStore(),
    stage: stageMode === 'activity' ? stageFromEnv() : undefined,
  }).catch((error) => {
    if (!(error instanceof CeremonyAborted)) {
      console.error('[draftorder] ceremony failed:', error);
    }
  });
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
 */
export async function recoverInterruptedCeremonies(
  client: Client,
  store: CeremonyStore = createFileCeremonyStore(),
): Promise<void> {
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
      await channel.send({ content: interruptedDisclosureContent(record) });
      // Remove by commitment (not guild): a newer run for the same guild has a different key, so
      // this can never clobber a still-undisclosed record.
      store.remove(record.commitment);
      console.log(
        `[draftorder] disclosed interrupted ceremony seed (commitment ${record.commitment.slice(0, 12)}…)`,
      );
    } catch (error) {
      console.error('[draftorder] failed to disclose an interrupted ceremony:', error);
    }
  }
}
