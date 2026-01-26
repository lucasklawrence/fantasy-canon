import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { assertTransition } from "@fantasy-canon/core";
import {
  DraftOrderAttemptStatus,
  DraftOrderSession,
  DraftOrderSessionState,
  buildDraftOrderProjection
} from "@fantasy-canon/db";
import { BotContext } from "../../config.js";

export const draftOrderCommand = new SlashCommandBuilder()
  .setName("draft-order")
  .setDescription("Draft order lottery")
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Create a draft order session")
      .addStringOption((opt) =>
        opt.setName("seed").setDescription("Public seed for deterministic draws")
      )
      .addIntegerOption((opt) =>
        opt
          .setName("baseballs")
          .setDescription("Balls per team before bonuses (default 1)")
          .setMinValue(1)
          .setMaxValue(10)
      )
      .addStringOption((opt) =>
        opt
          .setName("teams")
          .setDescription("Comma-separated team IDs to register (e.g., team1,team2,team3)")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("config")
      .setDescription("Register teams for the active session")
      .addStringOption((opt) =>
        opt
          .setName("teams")
          .setDescription("Comma-separated team IDs to register (e.g., team1,team2,team3)")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) => sub.setName("open-game").setDescription("Open reaction-time mini game"))
  .addSubcommand((sub) =>
    sub
      .setName("start-lottery")
      .setDescription("Start lottery and compute draft order")
      .addStringOption((opt) =>
        opt
          .setName("attempts")
          .setDescription("Optional reaction times 'team:ms,team2:ms' (ms <=0 counts as early)")
      )
  )
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Show status for the latest draft order session")
  )
  .addSubcommand((sub) =>
    sub.setName("finalize").setDescription("Finalize the current draft order session")
  )
  .addSubcommand((sub) => sub.setName("cancel").setDescription("Cancel the current session"));

type ParsedAttempt = {
  teamId: string;
  reactionMs?: number;
  status: DraftOrderAttemptStatus;
};

function parseTeamList(raw?: string | null): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseAttempts(raw?: string | null): ParsedAttempt[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const [teamId, msStr] = token.split(":").map((part) => part.trim());
      const ms = msStr ? Number(msStr) : undefined;
      const status: DraftOrderAttemptStatus =
        typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? "valid" : "early";
      return { teamId, reactionMs: Number.isFinite(ms) ? ms : undefined, status };
    });
}

function findActiveSession(sessions: DraftOrderSession[]): DraftOrderSession | undefined {
  const openStates: DraftOrderSessionState[] = ["CREATED", "GAME_OPEN", "LOTTERY_RUNNING"];
  return sessions
    .filter((session) => openStates.includes(session.state))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

async function getOrReplySession(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<DraftOrderSession | undefined> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "Draft order commands must be run inside a server.",
      flags: MessageFlags.Ephemeral
    });
    return undefined;
  }

  const sessions = await context.draftOrderStore.listSessionsByGuild(guildId);
  const active = findActiveSession(sessions);
  if (!active) {
    await interaction.reply({
      content: "No active draft order session found. Use /draft-order create first.",
      flags: MessageFlags.Ephemeral
    });
    return undefined;
  }

  return active;
}

async function handleCreate(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "Draft order sessions must be created inside a server.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const seed = interaction.options.getString("seed") ?? `seed-${Date.now()}`;
  const baseBalls = interaction.options.getInteger("baseballs") ?? 1;
  const teamsRaw = interaction.options.getString("teams");
  const teams = parseTeamList(teamsRaw);

  const session = await context.draftOrderStore.createSession({
    guildId,
    channelId: interaction.channelId ?? undefined,
    seed,
    baseBallCount: baseBalls,
    createdBy: interaction.user.id
  });

  await context.draftOrderStore.appendEvent({
    sessionId: session.id,
    type: "session_created",
    payload: { seed, baseBalls, teams: teams.length }
  });

  if (teams.length > 0) {
    for (const teamId of teams) {
      await context.draftOrderStore.addTeam({
        sessionId: session.id,
        teamId,
        displayName: teamId
      });
    }
  }

  await interaction.reply({
    content: `Draft order session created with seed "${seed}" and ${teams.length} team(s).`,
    flags: MessageFlags.Ephemeral
  });
}

async function handleConfig(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const session = await getOrReplySession(interaction, context);
  if (!session) return;

  if (session.state === "FINALIZED" || session.state === "CANCELLED") {
    await interaction.reply({
      content: `Session ${session.id} is closed and cannot be updated.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const teams = parseTeamList(interaction.options.getString("teams"));
  let added = 0;

  for (const teamId of teams) {
    await context.draftOrderStore.addTeam({
      sessionId: session.id,
      teamId,
      displayName: teamId
    });
    added += 1;
  }

  if (added > 0) {
    await context.draftOrderStore.appendEvent({
      sessionId: session.id,
      type: "team_registered",
      payload: { teams: teams }
    });
  }

  await interaction.reply({
    content: `Registered ${added} team(s).`,
    flags: MessageFlags.Ephemeral
  });
}

async function handleOpenGame(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const session = await getOrReplySession(interaction, context);
  if (!session) return;

  if (session.state !== "CREATED") {
    await interaction.reply({
      content: `Session is currently ${session.state}; mini-game can only be opened from CREATED.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  assertTransition(session.state, "GAME_OPEN");

  const updated = await context.draftOrderStore.updateSession(session.id, {
    state: "GAME_OPEN"
  });

  await context.draftOrderStore.appendEvent({
    sessionId: session.id,
    type: "game_opened",
    payload: {}
  });

  await interaction.reply({
    content: `Mini-game opened for session ${updated.id}. Teams may submit reaction attempts.`,
    flags: MessageFlags.Ephemeral
  });
}

async function handleStartLottery(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const session = await getOrReplySession(interaction, context);
  if (!session) return;

  if (session.state !== "GAME_OPEN") {
    await interaction.reply({
      content: `Session is currently ${session.state}; lottery can only start after the mini-game is open.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  assertTransition(session.state, "LOTTERY_RUNNING");

  const attemptsInput = parseAttempts(interaction.options.getString("attempts"));
  for (const attempt of attemptsInput) {
    await context.draftOrderStore.recordAttempt({
      sessionId: session.id,
      teamId: attempt.teamId,
      status: attempt.status,
      reactionMs: attempt.reactionMs
    });
    await context.draftOrderStore.appendEvent({
      sessionId: session.id,
      type: "mini_game_attempted",
      payload: {
        teamId: attempt.teamId,
        reactionMs: attempt.reactionMs,
        status: attempt.status
      }
    });
  }

  const teams = await context.draftOrderStore.listTeams(session.id);
  if (teams.length === 0) {
    await interaction.reply({
      content: "No teams registered. Add teams with /draft-order config before starting the lottery.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const updated = await context.draftOrderStore.updateSession(session.id, {
    state: "LOTTERY_RUNNING"
  });

  await context.draftOrderStore.appendEvent({
    sessionId: session.id,
    type: "lottery_started",
    payload: { attemptsRecorded: attemptsInput.length }
  });

  const attempts = await context.draftOrderStore.listAttempts(session.id);
  const projection = buildDraftOrderProjection({ session: updated, teams, attempts });

  const drawsText =
    projection.draws.length === 0
      ? "No teams registered yet."
      : projection.draws.map((draw) => `#${draw.pick} - ${draw.teamId} (${draw.ballId})`).join("\n");

  await interaction.reply({
    content: `Lottery started. Current draft order:\n${drawsText}`,
    flags: MessageFlags.Ephemeral
  });
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const session = await getOrReplySession(interaction, context);
  if (!session) return;

  const teams = await context.draftOrderStore.listTeams(session.id);
  const attempts = await context.draftOrderStore.listAttempts(session.id);

  if (teams.length === 0) {
    await interaction.reply({
      content: `State: ${session.state}\nSeed: ${session.seed}\nNo teams registered yet.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const projection = buildDraftOrderProjection({ session, teams, attempts });

  const awards =
    projection.awards.length > 0
      ? projection.awards
          .map((award) => `Rank ${award.rank}: ${award.teamId} (+${award.bonusBalls} balls, ${award.reactionMs}ms)`)
          .join("\n")
      : "No reaction-time bonuses yet.";

  const draws =
    projection.draws.length > 0
      ? projection.draws.map((draw) => `#${draw.pick} - ${draw.teamId} (${draw.ballId})`).join("\n")
      : "Lottery not started.";

  const teamLines =
    projection.teams.length > 0
      ? projection.teams
          .map(
            (team) =>
              `${team.teamId}: ${team.totalBalls} balls (base ${team.baseBalls}, manual ${team.bonusBalls}, bonus ${team.computedBonusBalls})`
          )
          .join("\n")
      : "No teams registered.";

  await interaction.reply({
    content: [
      `State: ${session.state}`,
      `Seed: ${session.seed}`,
      `Teams:\n${teamLines}`,
      `Reaction game:\n${awards}`,
      `Draft order:\n${draws}`
    ].join("\n"),
    flags: MessageFlags.Ephemeral
  });
}

async function handleFinalize(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const session = await getOrReplySession(interaction, context);
  if (!session) return;

  if (session.state !== "LOTTERY_RUNNING") {
    await interaction.reply({
      content: `Session is currently ${session.state}; finalize after the lottery is running.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  assertTransition(session.state, "FINALIZED");

  const updated = await context.draftOrderStore.updateSession(session.id, {
    state: "FINALIZED",
    finalizedAt: new Date()
  });

  await context.draftOrderStore.appendEvent({
    sessionId: session.id,
    type: "finalized",
    payload: {}
  });

  await interaction.reply({
    content: `Session ${updated.id} finalized.`,
    flags: MessageFlags.Ephemeral
  });
}

async function handleCancel(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const session = await getOrReplySession(interaction, context);
  if (!session) return;

  if (session.state === "FINALIZED") {
    await interaction.reply({
      content: "Cannot cancel a finalized session.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  assertTransition(session.state, "CANCELLED");

  const updated = await context.draftOrderStore.updateSession(session.id, {
    state: "CANCELLED",
    cancelledAt: new Date()
  });

  await context.draftOrderStore.appendEvent({
    sessionId: session.id,
    type: "cancelled",
    payload: {}
  });

  await interaction.reply({
    content: `Session ${updated.id} cancelled.`,
    flags: MessageFlags.Ephemeral
  });
}

export async function handleDraftOrderInteraction(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "create") {
    await handleCreate(interaction, context);
  } else if (subcommand === "config") {
    await handleConfig(interaction, context);
  } else if (subcommand === "open-game") {
    await handleOpenGame(interaction, context);
  } else if (subcommand === "start-lottery") {
    await handleStartLottery(interaction, context);
  } else if (subcommand === "status") {
    await handleStatus(interaction, context);
  } else if (subcommand === "finalize") {
    await handleFinalize(interaction, context);
  } else if (subcommand === "cancel") {
    await handleCancel(interaction, context);
  } else {
    await interaction.reply({
      content: `Subcommand "${subcommand}" is not implemented yet.`,
      flags: MessageFlags.Ephemeral
    });
  }
}
