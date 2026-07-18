/**
 * `/canon draftorder` — the draft-order lottery ceremony (#164, ADR 0006).
 *
 * Two-step flow: `setup` posts the public odds preview and freezes the bag; `begin` posts the
 * commitment and runs the paced worst-to-first reveal on regular channel messages (never
 * interaction responses — the ceremony outlives any interaction token). `abort` follows the
 * ADR 0006 disclosure policy; `status` is an ephemeral peek.
 *
 * Teams default to the ESPN league's `mTeam` roster; a manual `teams` option overrides for
 * dry-runs and leagues without ESPN access. All orchestration lives in
 * `lib/draftOrderCeremony.ts` so it stays testable without discord.js.
 */
import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { DraftOrderTeamInput } from '@fantasy-canon/core';
import { BotContext } from '../../config.js';
import { resolveLeagueId } from '../../lib/leagueId.js';
import { ensureSnapshot } from '../../lib/snapshots.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import {
  buildPreviewPost,
  CeremonyAborted,
  CeremonyIo,
  CeremonyPost,
  clearCeremony,
  createCeremony,
  getCeremony,
  markPreviewPosted,
  requestAbort,
  runCeremony,
  setCeremony,
} from '../../lib/draftOrderCeremony.js';

export const DEFAULT_REVEAL_DELAY_SECONDS = 20;

/** Hard cap on bonus balls per team — the bag is materialized ball-by-ball, so unbounded input is a foot-gun. */
export const MAX_BONUS_BALLS = 10;

interface ParsedTeam {
  name: string;
  bonusBalls: number;
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

/**
 * Parse the `bonus` option (`"Sharks:2, Ducks:1"`) and apply it onto the team list by
 * case-insensitive display-name match. Throws when a name matches no team.
 */
export function applyBonusOverrides(
  teams: { teamId: string; name: string; bonusBalls: number }[],
  bonusInput: string | undefined,
): void {
  if (!bonusInput) return;
  const byName = new Map(teams.map((team) => [team.name.toLowerCase(), team]));
  for (const parsed of parseManualTeams(bonusInput)) {
    const team = byName.get(parsed.name.toLowerCase());
    if (!team) {
      const known = teams.map((t) => t.name).join(', ');
      throw new Error(`No team named "${parsed.name}". Teams: ${known}`);
    }
    team.bonusBalls = parsed.bonusBalls;
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
  send(payload: { content?: string; files?: AttachmentBuilder[] }): Promise<{ id: string }>;
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
  interaction: ChatInputCommandInteraction,
  context: BotContext,
  season: number,
): Promise<{ teamId: string; name: string; bonusBalls: number }[]> {
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    throw new Error(
      'League ID is required — set it via /canon config set, ESPN_LEAGUE_ID, or pass a manual `teams` list.',
    );
  }
  const payload = await ensureSnapshot(context, leagueId, season, 'mTeam');
  const nameMap = buildTeamNameMap(payload);
  if (nameMap.size === 0) {
    throw new Error(`No teams found for league ${leagueId}, season ${season}.`);
  }
  return [...nameMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([teamId, name]) => ({ teamId: String(teamId), name, bonusBalls: 0 }));
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
    const teams = manualTeams
      ? parseManualTeams(manualTeams).map((team, index) => ({
          teamId: `team-${index + 1}`,
          name: team.name,
          bonusBalls: team.bonusBalls,
        }))
      : await resolveEspnTeams(interaction, context, season);
    applyBonusOverrides(teams, bonusInput);

    const configTeams: DraftOrderTeamInput[] = teams.map((team) => ({
      teamId: team.teamId,
      displayName: team.name,
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

    await interaction.editReply({
      content:
        `Odds preview posted — the bag is frozen at ${teams.length} teams. ` +
        'Run `/canon draftorder begin` to post the commitment and start the reveal. ' +
        'Changing teams/balls means re-running setup (fresh public preview) first.',
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

  const channel = sendableChannel(interaction);
  if (!channel) {
    await interaction.reply({
      content: "I can't post in this channel — check my permissions.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const delaySeconds = interaction.options.getInteger('delay') ?? DEFAULT_REVEAL_DELAY_SECONDS;

  await interaction.reply({
    content: `Sealing the bag — commitment posts now, first reveal ~${delaySeconds}s after its drum roll. Abort with \`/canon draftorder abort\` (the seed gets revealed either way).`,
    flags: MessageFlags.Ephemeral,
  });

  // Re-validate after the reply await: an abort (or a replacing setup) may have raced us.
  // runCeremony's own pre-commit abort check is the backstop; this avoids even starting.
  if (getCeremony(guildId) !== session || session.abort.signal.aborted) {
    await interaction.followUp({
      content: 'The ceremony was aborted before it could start — nothing was committed.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Fire and forget: the ceremony runs on channel messages and outlives this interaction's
  // 15-minute token. Errors land in the channel via the abort disclosure + the log.
  void runCeremony(session, channelIo(channel), { delayMs: delaySeconds * 1000 }).catch((error) => {
    if (!(error instanceof CeremonyAborted)) {
      console.error('[draftorder] ceremony failed:', error);
    }
  });
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
  await interaction.reply({ content: 'Ceremony cancelled.', flags: MessageFlags.Ephemeral });
}
