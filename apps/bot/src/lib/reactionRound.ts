/**
 * Reaction-time bonus-ball round (#166) — the one pre-ceremony mini-game.
 *
 * Flow: post an armed "hands ready…" message with one button per team → flip it to GO after a
 * randomized delay → collect the first click per team (and one click per person) for a fixed
 * window → score with core's `scoreReactionGame` → apply bonuses onto the session's bag → post
 * the public results and a fresh odds preview. The round runs while the ceremony sits in
 * `GAME_OPEN`, strictly before `begin` — the commitment must bind the final locked bag
 * (ADR 0006 fairness ordering), which is why `begin` refuses to start mid-round.
 *
 * Trust model: buttons are self-service (no Discord-user→team registry), so the results post
 * names who clicked for each team — public accountability in a 12-friend league. One click per
 * person means sniping a rival's button burns your own shot. Clicking while armed is a false
 * start: the team's attempt is spent (`early`) and scores nothing.
 *
 * The randomized GO delay is gameplay, not lottery randomness — it never touches the
 * commit-reveal scheme. Like the ceremony, every public beat is a regular channel message;
 * button interactions get one short ephemeral ack each, so the 15-minute token never binds.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type Message,
} from 'discord.js';
import { ReactionAttempt, ReactionGameResult, scoreReactionGame } from '@fantasy-canon/core';
import {
  applyMiniGameBonuses,
  buildPreviewPost,
  CeremonyIo,
  CeremonySession,
  getCeremony,
} from './draftOrderCeremony.js';

/** Discord caps a message at 5 action rows × 5 buttons. */
export const MAX_ROUND_TEAMS = 25;

/** Discord's button-label length cap. */
const BUTTON_LABEL_LIMIT = 80;

export interface RoundTeam {
  teamId: string;
  name: string;
}

/** One button per team, chunked ≤5 per row. Throws over {@link MAX_ROUND_TEAMS} (Discord's grid cap). */
export function buildTeamButtonRows(
  teams: RoundTeam[],
  idPrefix: string,
  opts: { go: boolean; disabled?: boolean } = { go: false },
): ActionRowBuilder<ButtonBuilder>[] {
  if (teams.length > MAX_ROUND_TEAMS) {
    throw new Error(
      `The reaction round supports at most ${MAX_ROUND_TEAMS} teams (${teams.length} given).`,
    );
  }
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < teams.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const team of teams.slice(i, i + 5)) {
      const label =
        team.name.length > BUTTON_LABEL_LIMIT
          ? `${team.name.slice(0, BUTTON_LABEL_LIMIT - 1)}…`
          : team.name;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${idPrefix}:${team.teamId}`)
          .setLabel(label)
          .setStyle(opts.go ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(opts.disabled ?? false),
      );
    }
    rows.push(row);
  }
  return rows;
}

export type ClickOutcome =
  | { kind: 'recorded'; status: 'valid'; reactionMs: number }
  | { kind: 'recorded'; status: 'early' }
  | { kind: 'recorded'; status: 'invalid' }
  | { kind: 'team-locked' }
  | { kind: 'user-spent' };

/**
 * Click-recording state machine for one round: first click per team, one click per person,
 * clicks before {@link markGo} are false starts, clicks past the window are late (`invalid`).
 * Pure bookkeeping — timestamps come in as arguments — so the round rules are unit-testable
 * without discord.js. The window is enforced here by timestamp (not just by stopping the
 * collector) because the collector deliberately outlives the window by a few seconds of
 * slack for in-flight events.
 */
export class ReactionRecorder {
  private goAt: number | undefined;
  private readonly windowMs: number | undefined;
  private readonly attempts: ReactionAttempt[] = [];
  private readonly clickedUsers = new Set<string>();
  private readonly clickers = new Map<string, string>();

  constructor(windowMs?: number) {
    this.windowMs = windowMs;
  }

  /** GO is stamped just before the message flips, so edit latency never turns a fair click into a false start. */
  markGo(at: number): void {
    this.goAt = at;
  }

  /** `early` before GO, `invalid` past the window, `valid` in between — relative to `goAt`. */
  private classify(at: number): ReactionAttempt['status'] {
    if (this.goAt === undefined || at < this.goAt) return 'early';
    if (this.windowMs !== undefined && at > this.goAt + this.windowMs) return 'invalid';
    return 'valid';
  }

  record(teamId: string, userId: string, userLabel: string, at: number): ClickOutcome {
    if (this.clickers.has(teamId)) return { kind: 'team-locked' };
    if (this.clickedUsers.has(userId)) return { kind: 'user-spent' };
    this.clickedUsers.add(userId);
    this.clickers.set(teamId, userLabel);
    const status = this.classify(at);
    if (status !== 'valid') {
      this.attempts.push({ teamId, status, attemptAt: new Date(at) });
      return { kind: 'recorded', status };
    }
    const reactionMs = at - (this.goAt as number);
    this.attempts.push({ teamId, status, reactionMs, attemptAt: new Date(at) });
    return { kind: 'recorded', status, reactionMs };
  }

  /**
   * Replace the provisional local-clock GO with the GO edit's own Discord-server timestamp and
   * reclassify every recorded attempt against it. Clicks are server-stamped
   * (`createdTimestamp`), so this puts both sides of every comparison on one clock — host
   * clock skew can no longer misfile a fair click as a false start. An ack sent in the tiny
   * pre-refinement window may disagree with the final classification; the results post is
   * authoritative.
   */
  refineGo(serverAt: number | null | undefined): void {
    if (serverAt === null || serverAt === undefined) return;
    this.goAt = serverAt;
    for (let i = 0; i < this.attempts.length; i += 1) {
      const attempt = this.attempts[i];
      const at = attempt.attemptAt.getTime();
      const status = this.classify(at);
      this.attempts[i] =
        status === 'valid'
          ? {
              teamId: attempt.teamId,
              status,
              reactionMs: at - serverAt,
              attemptAt: attempt.attemptAt,
            }
          : { teamId: attempt.teamId, status, attemptAt: attempt.attemptAt };
    }
  }

  getAttempts(): ReactionAttempt[] {
    return [...this.attempts];
  }

  clickerFor(teamId: string): string | undefined {
    return this.clickers.get(teamId);
  }
}

/** The public results post: podium with times and bonuses, also-rans, false starts, no-shows. */
export function formatRoundResults(
  result: ReactionGameResult,
  attempts: ReactionAttempt[],
  teams: RoundTeam[],
  clickerFor: (teamId: string) => string | undefined,
): string {
  const nameOf = (teamId: string): string => teams.find((t) => t.teamId === teamId)?.name ?? teamId;
  const by = (teamId: string): string => {
    const clicker = clickerFor(teamId);
    return clicker ? ` — clicked by ${clicker}` : '';
  };

  const lines = ['🏓 **Reaction round — results**'];
  for (const award of result.ranking) {
    const medal = award.rank === 1 ? '🥇' : award.rank === 2 ? '🥈' : `${award.rank}.`;
    const bonus =
      award.bonusBalls > 0
        ? ` → **+${award.bonusBalls} ball${award.bonusBalls === 1 ? '' : 's'}**`
        : '';
    lines.push(
      `${medal} ${nameOf(award.teamId)} — ${award.reactionMs} ms${bonus}${by(award.teamId)}`,
    );
  }
  const falseStarts = attempts.filter((a) => a.status === 'early');
  if (falseStarts.length > 0) {
    lines.push(
      `🚨 False starts (attempt burned): ${falseStarts
        .map((a) => `${nameOf(a.teamId)}${by(a.teamId)}`)
        .join(', ')}`,
    );
  }
  const lateClicks = attempts.filter((a) => a.status === 'invalid');
  if (lateClicks.length > 0) {
    lines.push(
      `⌛ Too late (window closed): ${lateClicks
        .map((a) => `${nameOf(a.teamId)}${by(a.teamId)}`)
        .join(', ')}`,
    );
  }
  const attempted = new Set(attempts.map((a) => a.teamId));
  const noShows = teams.filter((t) => !attempted.has(t.teamId));
  if (noShows.length > 0) {
    lines.push(`😴 Never clicked: ${noShows.map((t) => t.name).join(', ')}`);
  }
  if (result.ranking.length === 0) {
    // No claim about the bag here: a scoreless re-run after a scoring round still clears the
    // earlier awards — the fresh preview below is the authoritative record either way.
    lines.push('Nobody scored this round.');
  }
  lines.push(
    'The current bag is in the fresh odds preview below. `/canon draftorder begin` seals it.',
  );
  return lines.join('\n');
}

/**
 * Score the round and publish the fairness-critical post pair: results, then a fresh odds
 * preview of the updated bag — both public, both strictly before any commitment. If the
 * ceremony moved on mid-round (aborted, replaced, or begun), the round is discarded with a
 * public note and no bonuses are applied. Split from {@link runReactionRound} so ordering is
 * testable with a fake {@link CeremonyIo}.
 */
export async function finishReactionRound(
  session: CeremonySession,
  io: CeremonyIo,
  attempts: ReactionAttempt[],
  clickerFor: (teamId: string) => string | undefined,
): Promise<ReactionGameResult | undefined> {
  if (getCeremony(session.guildId) !== session || session.state !== 'GAME_OPEN') {
    await io.post({
      kind: 'minigame',
      content:
        '🏓 The reaction round was discarded — the ceremony moved on before scoring. No bonus balls were applied.',
    });
    return undefined;
  }
  const result = scoreReactionGame(attempts);
  const previousBonuses = session.miniGameBonuses ?? {};
  applyMiniGameBonuses(session, result.bonusByTeam);
  const teams: RoundTeam[] = session.config.teams.map((team) => ({
    teamId: team.teamId,
    name: session.names.get(team.teamId) ?? team.teamId,
  }));
  try {
    await io.post({
      kind: 'minigame',
      content: formatRoundResults(result, attempts, teams, clickerFor),
    });
    await io.post(await buildPreviewPost(session));
  } catch (error) {
    // Never leave the bag mutated without full public disclosure: if either post failed,
    // restore the last publicly-previewed composition so `begin` can't seal an unexplained
    // bag. The stacking bookkeeping makes this an exact rollback; re-run the round to retry.
    applyMiniGameBonuses(session, previousBonuses);
    throw error;
  }
  return result;
}

/** Channel surface the round needs; a live discord.js text channel satisfies it structurally. */
export interface RoundChannel {
  send(payload: {
    content: string;
    components: ActionRowBuilder<ButtonBuilder>[];
  }): Promise<unknown>;
}

export interface ReactionRoundOptions {
  /** Click window after GO. */
  windowMs?: number;
  /** Injected for tests; defaults to a randomized 3–8 s arm delay. */
  armDelayMs?: () => number;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_WINDOW_MS = 15_000;

const armedContent = (windowMs: number): string =>
  [
    '🏓 **Bonus-ball reaction round** — hands ready…',
    'When this message flips to **GO**, click **your team’s** button. Fastest click earns **+2 balls**, second **+1**.',
    `First click per team counts, one click per person, and clicking before GO burns your team’s attempt. The window stays open ${Math.round(windowMs / 1000)}s after GO.`,
  ].join('\n');

const GO_CONTENT = '🟢 **GO!** Click your team — now!';

function ackContent(outcome: ClickOutcome, teamName: string): string {
  switch (outcome.kind) {
    case 'recorded':
      return outcome.status === 'valid'
        ? `⏱️ ${outcome.reactionMs} ms for **${teamName}** — locked in.`
        : outcome.status === 'early'
          ? `🚨 False start — **${teamName}**’s attempt is burned.`
          : `⌛ Too slow — the window had already closed on **${teamName}**’s click.`;
    case 'team-locked':
      return `**${teamName}** already has its click.`;
    case 'user-spent':
      return 'You already used your click this round.';
  }
}

/** Narrow a `send` result to a Message that supports a component collector and edits. */
function isRoundMessage(message: unknown): message is Message & {
  createMessageComponentCollector: Message['createMessageComponentCollector'];
  edit: Message['edit'];
} {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { createMessageComponentCollector?: unknown })
      .createMessageComponentCollector === 'function' &&
    typeof (message as { edit?: unknown }).edit === 'function'
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the full round against a live channel: armed post → GO flip → click window → freeze →
 * {@link finishReactionRound}. Resolves with the scored result, or undefined when the round
 * was discarded. Throws if the channel's message can't host a button collector.
 */
export async function runReactionRound(
  session: CeremonySession,
  channel: RoundChannel,
  io: CeremonyIo,
  options: ReactionRoundOptions = {},
): Promise<ReactionGameResult | undefined> {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const armDelayMs = options.armDelayMs ?? (() => 3000 + Math.floor(Math.random() * 5000));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  const teams: RoundTeam[] = session.config.teams.map((team) => ({
    teamId: team.teamId,
    name: session.names.get(team.teamId) ?? team.teamId,
  }));
  const idPrefix = `rr:${now().toString(36)}`;
  const recorder = new ReactionRecorder(windowMs);

  const armDelay = armDelayMs();
  const message = await channel.send({
    content: armedContent(windowMs),
    components: buildTeamButtonRows(teams, idPrefix),
  });
  if (!isRoundMessage(message)) {
    throw new Error('This channel does not support button collectors — cannot run the round.');
  }

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: armDelay + windowMs + 5000,
    filter: (i) => i.customId.startsWith(`${idPrefix}:`),
  });
  collector.on('collect', (button: ButtonInteraction) => {
    const teamId = button.customId.slice(idPrefix.length + 1);
    const teamName = teams.find((t) => t.teamId === teamId)?.name ?? teamId;
    const outcome = recorder.record(
      teamId,
      button.user.id,
      button.user.username,
      button.createdTimestamp,
    );
    void button
      .reply({ content: ackContent(outcome, teamName), flags: MessageFlags.Ephemeral })
      .catch((error) => console.error('[minigame] failed to ack a click:', error));
  });

  await sleep(armDelay);
  // Provisional GO from the local clock (so clicks landing mid-edit still classify), then
  // refined to the edit's Discord-server timestamp — the same clock that stamps the clicks.
  recorder.markGo(now());
  const goMessage = (await message.edit({
    content: GO_CONTENT,
    components: buildTeamButtonRows(teams, idPrefix, { go: true }),
  })) as { editedTimestamp?: number | null } | undefined;
  recorder.refineGo(goMessage?.editedTimestamp);

  await sleep(windowMs);
  collector.stop('window-closed');
  await message.edit({
    content: '⏱️ **Round over** — scoring…',
    components: buildTeamButtonRows(teams, idPrefix, { go: true, disabled: true }),
  });

  return finishReactionRound(session, io, recorder.getAttempts(), (teamId) =>
    recorder.clickerFor(teamId),
  );
}
