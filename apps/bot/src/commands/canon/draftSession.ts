/**
 * `/canon draft start|pick|best|status|grade|stop` — a live draft session. `start` opens a running
 * session for the channel (from the same research + market-ADP pool as `cheatsheet`); picks stream in
 * either manually (`pick`) or automatically from an ESPN draft room via the capture sink + userscript;
 * `best` re-runs the value-based-drafting engine over whoever's left; and `grade` scores your roster
 * with the reproducible value-vs-ADP grade engine. The heavy lifting is the pure core reducer
 * (`createDraftSession`/`applyPick`/`toDraftState`, `gradeSession`) — everything here is glue + display.
 */

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from 'discord.js';
import {
  applyPick,
  bestAvailable,
  createDraftSession,
  currentOverall,
  gradeSession,
  myUpcomingOveralls,
  toDraftState,
  type Candidate,
  type DraftSession,
  type GradedPick,
  type PickVerdict,
  type RosterGrade,
} from '@fantasy-canon/core';
import { renderGradeCard, type GradeCardOptions } from '@fantasy-canon/renderer';
import { loadRankings, ROSTER_SLOTS } from '../../lib/draftPool.js';
import { EspnSinkDraftSource } from '../../lib/draft/espnSinkSource.js';
import { runDraftPoller } from '../../lib/draft/poller.js';
import { createLiveBoard } from '../../lib/draft/liveBoard.js';
import {
  endDraft,
  getDraft,
  setDraft,
  type DraftSourceKind,
  type LiveDraft,
} from '../../lib/draft/sessionStore.js';

/** One live draft per channel. Structural so slash-command and component interactions share it. */
function draftKey(interaction: { channelId: string | null; user: { id: string } }): string {
  return interaction.channelId ?? `dm:${interaction.user.id}`;
}

/** Default localhost port for the ESPN capture sink; override with `FANTASY_DRAFT_SINK_PORT`. */
function sinkPort(): number {
  const override = Number(process.env.FANTASY_DRAFT_SINK_PORT);
  return Number.isInteger(override) && override > 0 ? override : 7331;
}

export async function handleDraftStartSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const teams = interaction.options.getInteger('teams') ?? 12;
  const slot = interaction.options.getInteger('pick', true);
  const rounds = interaction.options.getInteger('rounds') ?? undefined;
  const sourceKind = (interaction.options.getString('source') ?? 'manual') as DraftSourceKind;
  const key = draftKey(interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const { players, fades, adp } = await loadRankings();
    if (players.length === 0) {
      await interaction.editReply({
        content:
          'No draft board found. Add a research report with a "Draft board" table under `research/` ' +
          '(e.g. via `/fantasy-research`) and try again.',
      });
      return;
    }

    let session: DraftSession;
    try {
      session = createDraftSession({
        leagueSize: teams,
        myTeamId: slot,
        rosterSlots: ROSTER_SLOTS,
        rounds,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await interaction.editReply({ content: `Can't start a session: ${message}` });
      return;
    }

    // Replace any prior draft in this channel (frees its capture port/poller).
    await endDraft(key);

    const draft: LiveDraft = {
      session,
      pool: players,
      fades,
      adp,
      teams,
      slot,
      sourceKind,
      createdAt: Date.now(),
    };

    let howToFeed: string;
    if (sourceKind === 'espn') {
      const sink = new EspnSinkDraftSource();
      try {
        const bound = await sink.listen(sinkPort());
        draft.sink = sink;
        draft.poller = runDraftPoller(sink, {
          getSession: () => getDraft(key)?.session ?? draft.session,
          setSession: (next) => {
            const current = getDraft(key);
            if (current) current.session = next;
          },
          // Nudge the self-updating board (if one's been posted) whenever a captured pick lands.
          onPick: () => getDraft(key)?.liveBoard?.markDirty(),
          onError: (error) => console.warn('[draft poller] poll failed:', error),
        });
        howToFeed =
          `ESPN capture is live on \`http://127.0.0.1:${bound}\`. Enable the ` +
          '**espn-draft-capture** userscript in your browser and open your ESPN draft room — picks ' +
          'flow in automatically. `/canon draft best` shows the live board.';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        draft.sourceKind = 'manual';
        howToFeed =
          `⚠️ Couldn't start the ESPN capture endpoint (${message}). Running in **manual** mode — ` +
          'enter picks with `/canon draft pick <player>`.';
      }
    } else {
      howToFeed =
        'Enter picks with `/canon draft pick <player>` as they happen; `/canon draft best` shows ' +
        'the live board.';
    }

    setDraft(key, draft);
    await interaction.editReply({
      content: `🏈 Draft session started — ${teams}-team PPR, your slot ${slot}.\n${howToFeed}`,
      embeds: [renderBoard(draft)],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ content: `Failed to start draft session: ${message}` });
  }
}

export async function handleDraftPickSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const key = draftKey(interaction);
  const raw = interaction.options.getString('player', true);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const draft = getDraft(key);
  if (!draft) {
    await interaction.editReply({
      content: 'No active draft session here. Start one with `/canon draft start`.',
    });
    return;
  }

  const names = raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  let applied = 0;
  for (const name of names) {
    const before = draft.session;
    draft.session = applyPick(draft.session, {
      overall: currentOverall(draft.session),
      teamId: 0,
      playerName: name,
    });
    if (draft.session !== before) applied += 1;
  }

  const content =
    applied > 0
      ? `Recorded ${applied === 1 ? '1 pick' : `${applied} picks`}.`
      : 'Nothing new — those players were already off the board.';
  await interaction.editReply({ content, embeds: [renderBoard(draft)] });
  if (applied > 0) draft.liveBoard?.markDirty();
}

export async function handleDraftBestSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const key = draftKey(interaction);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const draft = getDraft(key);
  if (!draft) {
    await interaction.editReply({
      content: 'No active draft session here. Start one with `/canon draft start`.',
    });
    return;
  }
  await interaction.editReply({ embeds: [renderBoard(draft)] });
}

export async function handleDraftStatusSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const key = draftKey(interaction);
  const draft = getDraft(key);
  if (!draft) {
    await interaction.reply({
      content: 'No active draft session here. Start one with `/canon draft start`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = currentOverall(draft.session);
  const upcoming = myUpcomingOveralls(draft.session);
  const myNext = upcoming[0];
  const lines = [
    `**${draft.teams}-team PPR**, your slot **${draft.slot}** — ${draft.session.picks.length} picks in.`,
    myNext === now
      ? `You're on the clock (pick ${now}).`
      : myNext !== undefined
        ? `Pick ${now} is up; your next pick is **${myNext}** (in ${myNext - now}).`
        : `Pick ${now} is up; you have no picks left.`,
  ];
  if (draft.sourceKind === 'espn') {
    lines.push(
      draft.sink?.port
        ? `ESPN capture: \`http://127.0.0.1:${draft.sink.port}\` (${draft.sink.poll().picks.length} picks captured).`
        : 'ESPN capture: not running.',
    );
  } else {
    lines.push('Source: manual entry.');
  }

  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

export async function handleDraftGradeSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const key = draftKey(interaction);
  const draft = getDraft(key);
  if (!draft) {
    await interaction.reply({
      content: 'No active draft session here. Start one with `/canon draft start`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const grade = gradeSession(draft.session, draft.pool);
  if (grade.picks.length === 0) {
    await interaction.reply({
      content: 'No picks of yours recorded yet — grade once your draft has some picks in.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Rendering the PNG can exceed the 3s ACK deadline on a cold start, so defer first. Ephemeral —
  // a private preview the user can then explicitly "Post to channel" (ephemeral can't be converted).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await editGradeView(interaction, draft, grade, 'overview');
}

/**
 * The interactive-grade component seam: routes the view select-menu and the share button off the
 * ephemeral grade message. State isn't serialized into the customId — we re-fetch the draft for this
 * channel and re-grade deterministically, so the view always reflects the latest picks.
 */
export async function handleGradeViewSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const draft = getDraft(draftKey(interaction));
  if (!draft) {
    await interaction.update({
      content: 'This draft session has ended — start a new one with `/canon draft start`.',
      embeds: [],
      components: [],
      files: [],
    });
    return;
  }
  if (componentSessionMarker(interaction.customId) !== String(draft.createdAt)) {
    await interaction.update({
      content:
        'This grade is from an earlier draft — run `/canon draft grade` for the current one.',
      embeds: [],
      components: [],
      files: [],
    });
    return;
  }
  const grade = gradeSession(draft.session, draft.pool);
  const view = normalizeGradeView(interaction.values[0]);
  await interaction.deferUpdate();
  await editGradeView(interaction, draft, grade, view);
}

export async function handleGradeShare(interaction: ButtonInteraction): Promise<void> {
  const draft = getDraft(draftKey(interaction));
  if (!draft) {
    await interaction.reply({
      content: 'This draft session has ended — nothing to share.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (componentSessionMarker(interaction.customId) !== String(draft.createdAt)) {
    await interaction.reply({
      content:
        'This grade is from an earlier draft — run `/canon draft grade` for the current one.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    await interaction.reply({
      content: "I can't post in this channel — check my permissions.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const grade = gradeSession(draft.session, draft.pool);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  // Track the public post separately from the ephemeral confirmation: if the channel send succeeds
  // but the confirmation edit fails, we must NOT tell the user to retry (that would double-post).
  let posted = false;
  try {
    const png = await renderGradeCard(toGradeCardOptions(grade, gradeContext(draft)));
    const card = new AttachmentBuilder(png, { name: GRADE_CARD_FILE });
    await channel.send({
      embeds: [renderGradeShareEmbed(draft, grade, `attachment://${GRADE_CARD_FILE}`)],
      files: [card],
    });
    posted = true;
    await interaction.editReply({ content: 'Posted your draft grade to the channel ✅' });
  } catch (error) {
    if (posted) {
      // The grade is already in the channel; only the ephemeral ack failed. Nothing to retry.
      console.warn('[draft grade] shared to channel but failed to confirm to user:', error);
      return;
    }
    console.warn('[draft grade] share render failed:', error);
    await interaction.editReply({ content: "Couldn't build the grade card to share — try again." });
  }
}

/**
 * Render the card and edit the (already-deferred) reply to show a view. Re-renders the card on every
 * switch — identical bytes, but it keeps the `attachment://` reference valid without juggling
 * attachment retention across edits, and a view switch is a cheap user-paced click. Falls back to an
 * embed-only message (still self-sufficient) if the render fails.
 */
async function editGradeView(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction,
  draft: LiveDraft,
  grade: RosterGrade,
  view: GradeView,
): Promise<void> {
  const sessionId = String(draft.createdAt);
  try {
    const png = await renderGradeCard(toGradeCardOptions(grade, gradeContext(draft)));
    const card = new AttachmentBuilder(png, { name: GRADE_CARD_FILE });
    // `attachments: []` drops the previously-attached PNG; without it Discord retains prior
    // attachments across edits, so each view switch would stack another card up to the limit.
    await interaction.editReply({
      embeds: [renderGradeView(draft, grade, view, `attachment://${GRADE_CARD_FILE}`)],
      files: [card],
      attachments: [],
      components: buildGradeComponents(view, sessionId),
    });
  } catch (error) {
    console.warn('[draft grade] card render failed, sending embed only:', error);
    await interaction.editReply({
      embeds: [renderGradeView(draft, grade, view)],
      files: [],
      attachments: [],
      components: buildGradeComponents(view, sessionId),
    });
  }
}

export async function handleDraftStopSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const key = draftKey(interaction);
  const ended = await endDraft(key);
  await interaction.reply({
    content: ended ? 'Draft session ended.' : 'No active draft session here.',
    flags: MessageFlags.Ephemeral,
  });
}

// --- Live draft board (#149): a self-updating channel message that outlives interaction tokens. ---

/** customId prefixes for the live-board buttons; trailing `:<createdAt>` is the session marker. */
export const BOARD_REFRESH_ID = 'canon:board:refresh';
export const BOARD_GRADE_ID = 'canon:board:grade';

/** Refresh + Grade buttons that ride under the live board, tagged with the session marker. */
export function buildBoardComponents(sessionId: string): ActionRowBuilder<ButtonBuilder>[] {
  const refresh = new ButtonBuilder()
    .setCustomId(`${BOARD_REFRESH_ID}:${sessionId}`)
    .setLabel('Refresh')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary);
  const grade = new ButtonBuilder()
    .setCustomId(`${BOARD_GRADE_ID}:${sessionId}`)
    .setLabel('Grade my roster')
    .setEmoji('📊')
    .setStyle(ButtonStyle.Primary);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(refresh, grade)];
}

/** The editable payload for the live board message: the best-available embed + its buttons. */
function boardMessagePayload(draft: LiveDraft): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  return {
    embeds: [renderBoard(draft)],
    components: buildBoardComponents(String(draft.createdAt)),
  };
}

/**
 * `/canon draft board` — post the live best-available board as a normal channel message and wire it
 * to auto-update as picks land. Unlike `best`/`status` (bound to a slash interaction that dies at 15
 * min), this is a bot-token message the poller and `pick` handler edit for the whole draft.
 */
export async function handleDraftBoardSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const draft = getDraft(draftKey(interaction));
  if (!draft) {
    await interaction.reply({
      content: 'No active draft session here. Start one with `/canon draft start`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    await interaction.reply({
      content: "I can't post in this channel — check my permissions.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  // Retire any prior board for this draft — only the newest message should keep updating.
  draft.liveBoard?.stop();
  try {
    const message = await channel.send(boardMessagePayload(draft));
    draft.liveBoard = createLiveBoard({
      message,
      render: () => boardMessagePayload(draft),
      onError: (error) => console.warn('[draft board] edit failed:', error),
    });
    await interaction.editReply({
      content: `📋 Live draft board posted — it'll update itself as picks land.\n${message.url}`,
    });
  } catch (error) {
    console.warn('[draft board] failed to post board:', error);
    await interaction.editReply({
      content: "Couldn't post the live board — check my channel permissions and try again.",
    });
  }
}

/** Refresh button: re-render the board in place. Uses the button's own token (a one-shot click). */
export async function handleBoardRefresh(interaction: ButtonInteraction): Promise<void> {
  const draft = getDraft(draftKey(interaction));
  if (!draft || componentSessionMarker(interaction.customId) !== String(draft.createdAt)) {
    await interaction.reply({
      content:
        'This board is from an earlier draft — run `/canon draft board` for the current one.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.update(boardMessagePayload(draft));
}

/** Grade button: open the interactive grade for the current roster, ephemerally to the clicker. */
export async function handleBoardGrade(interaction: ButtonInteraction): Promise<void> {
  const draft = getDraft(draftKey(interaction));
  if (!draft || componentSessionMarker(interaction.customId) !== String(draft.createdAt)) {
    await interaction.reply({
      content:
        'This board is from an earlier draft — run `/canon draft board` for the current one.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const grade = gradeSession(draft.session, draft.pool);
  if (grade.picks.length === 0) {
    await interaction.reply({
      content: 'No picks of yours recorded yet — grade once your draft has some picks in.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await editGradeView(interaction, draft, grade, 'overview');
}

const TONE_EMOJI: Record<Candidate['recommend'], string> = {
  reach: '🟧',
  value: '🟩',
  wait: '⬜',
};

/** Build the live best-available board embed for the current session. */
function renderBoard(draft: LiveDraft): EmbedBuilder {
  const state = toDraftState(draft.session);
  const candidates = bestAvailable(draft.pool, state);
  const now = currentOverall(draft.session);
  const upcoming = myUpcomingOveralls(draft.session);
  const myNext = upcoming[0];

  const rows = candidates.slice(0, 12).map((c) => {
    const adp = c.adp !== undefined ? `adp ${Math.round(c.adp)}` : '';
    return `${TONE_EMOJI[c.recommend]} ${c.position.padEnd(2)} ${truncate(c.name, 20).padEnd(20)} ${adp}`;
  });
  const board = rows.length
    ? `\`\`\`\n${rows.join('\n')}\n\`\`\``
    : '_No players left on the board._';

  const clock =
    myNext === now
      ? `**You're on the clock** — pick ${now}.`
      : myNext !== undefined
        ? `Pick ${now} is up. Your next pick: **${myNext}** (in ${myNext - now}).`
        : `Pick ${now} is up.`;

  return new EmbedBuilder()
    .setTitle(`🎯 Best available — ${draft.session.picks.length} picks in`)
    .setDescription(`${clock}\n${board}`)
    .setFooter({ text: boardFooter(draft) });
}

function boardFooter(draft: LiveDraft): string {
  const bits = [`${draft.teams}-team PPR`, `slot ${draft.slot}`, '🟧 reach · 🟩 value · ⬜ wait'];
  if (draft.adp) bits.push(`ADP as of ${draft.adp.asOf}`);
  if (draft.sourceKind === 'espn' && draft.sink?.port) bits.push(`capture :${draft.sink.port}`);
  return bits.join(' • ');
}

/** Verdict → tone glyph for the per-pick grade table. Mirrors the board's reach/value tones. */
const VERDICT_EMOJI: Record<PickVerdict, string> = {
  steal: '💎',
  value: '🟩',
  fair: '⬜',
  reach: '🟧',
};

/** `+4` / `-8` / `0` — signed for humans (positive = beat ADP). */
function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** One-line headline: letter grade, mean value, penalized score, starters filled. */
export function gradeHeadline(grade: RosterGrade): string {
  return (
    `**${grade.grade}** · value ${signed(grade.valueScore)} · score ${signed(grade.score)} · ` +
    `starters ${grade.starters.filled}/${grade.starters.required}`
  );
}

/** Monospace per-pick table, in draft order: tone, overall, pos, name, ADP, value. */
export function gradePicksBlock(grade: RosterGrade): string {
  if (grade.picks.length === 0) return '_No picks yet._';
  const rows = grade.picks.map((p: GradedPick) => {
    const pos = (p.position ?? '?').padEnd(3);
    const name = truncate(p.playerName, 20).padEnd(20);
    const adp = (p.adp !== undefined ? `adp ${Math.round(p.adp)}` : '—').padEnd(8);
    const val = (p.value !== undefined ? signed(p.value) : '·').padStart(4);
    return `${VERDICT_EMOJI[p.verdict]} ${String(p.overall).padStart(3)} ${pos} ${name} ${adp} ${val}`;
  });
  return `\`\`\`\n${rows.join('\n')}\n\`\`\``;
}

/** Attachment filename for the rendered grade card; the embed's image URL must match this. */
const GRADE_CARD_FILE = 'draft-grade.png';

/** Preferred left-to-right order for per-position bars/rows; unknowns sort last, alphabetically. */
const POSITION_ORDER = ['RB', 'WR', 'TE', 'QB', 'K', 'DST', 'FLEX'];

function positionRank(pos: string): number {
  const i = POSITION_ORDER.indexOf(pos);
  return i === -1 ? POSITION_ORDER.length : i;
}

/** Session context the card footer/subtitle need — just enough to keep this decoupled from LiveDraft. */
export interface GradeCardContext {
  teams: number;
  slot: number;
  /** The market ADP "as of" date, when the board carried live ADP. */
  adpAsOf?: string;
}

/** Pull the card context out of a live draft. */
function gradeContext(draft: LiveDraft): GradeCardContext {
  return { teams: draft.teams, slot: draft.slot, adpAsOf: draft.adp?.asOf };
}

/** Map a RosterGrade + session context onto the renderer's plain card options (renderer stays core-free). */
export function toGradeCardOptions(grade: RosterGrade, ctx: GradeCardContext): GradeCardOptions {
  const byPosition = Object.entries(grade.byPosition)
    .map(([pos, b]) => ({ pos, count: b.count, avgValue: b.avgValue }))
    .sort((a, b) => positionRank(a.pos) - positionRank(b.pos) || a.pos.localeCompare(b.pos));

  const toRow = (p: GradedPick) => ({
    playerName: p.playerName,
    overall: p.overall,
    value: p.value,
    position: p.position,
  });

  const footerBits = [`${ctx.teams}-team PPR`, `slot ${ctx.slot}`];
  if (ctx.adpAsOf) footerBits.push(`ADP as of ${ctx.adpAsOf}`);
  footerBits.push('grade assumes a completed roster');

  return {
    title: 'Your draft grade',
    subtitle: `${ctx.teams}-team PPR • ${grade.picks.length} picks • slot ${ctx.slot}`,
    grade: grade.grade,
    score: grade.score,
    valueScore: grade.valueScore,
    starters: grade.starters,
    byPosition,
    steals: grade.steals.map(toRow),
    reaches: grade.reaches.map(toRow),
    footer: footerBits.join(' • '),
  };
}

/** The grade views a user can switch between via the select menu. */
const GRADE_VIEWS = ['overview', 'picks', 'byPosition', 'steals'] as const;
export type GradeView = (typeof GRADE_VIEWS)[number];

/** Select-menu metadata per view (label + one-liner shown in the dropdown). */
const GRADE_VIEW_OPTIONS: ReadonlyArray<{
  value: GradeView;
  label: string;
  description: string;
  emoji: string;
}> = [
  {
    value: 'overview',
    label: 'Overview',
    description: 'Grade, value, and starters at a glance',
    emoji: '📋',
  },
  { value: 'picks', label: 'Picks', description: 'Every pick with ADP and value', emoji: '🧾' },
  {
    value: 'byPosition',
    label: 'By position',
    description: 'Value gained per position',
    emoji: '📊',
  },
  {
    value: 'steals',
    label: 'Steals & reaches',
    description: 'Best values and biggest reaches',
    emoji: '💎',
  },
];

const GRADE_VIEW_TITLE: Record<GradeView, string> = {
  overview: '',
  picks: ' · Picks',
  byPosition: ' · By position',
  steals: ' · Steals & reaches',
};

/** Coerce a select-menu value (or anything) back to a known view, defaulting to overview. */
export function normalizeGradeView(value: string | undefined): GradeView {
  return (GRADE_VIEWS as readonly string[]).includes(value ?? '')
    ? (value as GradeView)
    : 'overview';
}

/**
 * customId prefixes for the interactive-grade components. The trailing `:<createdAt>` segment is a
 * session marker so a control left over from an earlier draft (e.g. after a fresh `/canon draft
 * start` in the same channel) is recognised and rejected rather than acting on the new session.
 */
export const GRADE_VIEW_ID = 'canon:grade:view';
export const GRADE_SHARE_ID = 'canon:grade:share';

/**
 * The session marker (`draft.createdAt`, stringified) baked into a `canon:<feature>:<action>:<id>`
 * component customId — the 4th colon segment. Handlers compare it to the current draft to reject a
 * control left over from an earlier session. Shared by the grade and board components.
 */
export function componentSessionMarker(customId: string): string {
  return customId.split(':')[3] ?? '';
}

/** The select + share-button rows that ride under the ephemeral grade, with `view` marked selected. */
export function buildGradeComponents(
  view: GradeView,
  sessionId: string,
): [ActionRowBuilder<StringSelectMenuBuilder>, ActionRowBuilder<ButtonBuilder>] {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${GRADE_VIEW_ID}:${sessionId}`)
    .setPlaceholder('Switch view')
    .addOptions(
      GRADE_VIEW_OPTIONS.map((o) => ({
        label: o.label,
        value: o.value,
        description: o.description,
        emoji: o.emoji,
        default: o.value === view,
      })),
    );
  const share = new ButtonBuilder()
    .setCustomId(`${GRADE_SHARE_ID}:${sessionId}`)
    .setLabel('Post to channel')
    .setEmoji('📢')
    .setStyle(ButtonStyle.Primary);
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    new ActionRowBuilder<ButtonBuilder>().addComponents(share),
  ];
}

/** Per-position value rows for the "By position" view, in RB→WR→TE→QB… order. */
function gradeByPositionBlock(grade: RosterGrade): string {
  const rows = Object.entries(grade.byPosition)
    .map(([pos, b]) => ({ pos, count: b.count, avgValue: b.avgValue }))
    .sort((a, b) => positionRank(a.pos) - positionRank(b.pos) || a.pos.localeCompare(b.pos))
    .map((b) => `${b.pos.padEnd(4)} ×${b.count}  ${signed(b.avgValue).padStart(5)}`);
  return rows.length ? `\`\`\`\n${rows.join('\n')}\n\`\`\`` : '_No graded positions yet._';
}

/** The Overview one-liner: how many picks graded, plus steal/reach/unfilled counts. */
function overviewSummary(grade: RosterGrade): string {
  const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
  const bits = [`${grade.gradedCount}/${grade.picks.length} picks graded`];
  if (grade.steals.length)
    bits.push(`💎 ${grade.steals.length} ${plural(grade.steals.length, 'steal', 'steals')}`);
  if (grade.reaches.length)
    bits.push(`🟧 ${grade.reaches.length} ${plural(grade.reaches.length, 'reach', 'reaches')}`);
  if (grade.starters.missing.length)
    bits.push(
      `⚠️ ${grade.starters.missing.length} unfilled ${plural(grade.starters.missing.length, 'starter', 'starters')}`,
    );
  return `${bits.join(' · ')}\n_Switch views with the menu, or Post to channel to share._`;
}

/** `💎 Name (+12)` list for the steals/reaches embed fields. */
function pickList(picks: GradedPick[], glyph: string): string {
  return picks.map((p) => `${glyph} ${p.playerName} (${signed(p.value ?? 0)})`).join('\n');
}

/**
 * Build the grade embed for a given view. All views share the card as the hero image (passed as an
 * `attachment://` or CDN url); the text section is what changes. `imageUrl` is omitted only on the
 * embed-only fallback when the card render failed.
 */
function renderGradeView(
  draft: LiveDraft,
  grade: RosterGrade,
  view: GradeView,
  imageUrl?: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`📋 Draft grade: ${grade.grade}${GRADE_VIEW_TITLE[view]}`)
    .setFooter({ text: gradeFooter(draft) });
  if (imageUrl) embed.setImage(imageUrl);

  switch (view) {
    case 'picks':
      embed.setDescription(`${gradeHeadline(grade)}\n${gradePicksBlock(grade)}`);
      break;
    case 'byPosition':
      embed.setDescription(`${gradeHeadline(grade)}\n${gradeByPositionBlock(grade)}`);
      break;
    case 'steals':
      embed.setDescription(gradeHeadline(grade));
      if (grade.steals.length)
        embed.addFields({ name: 'Steals', value: pickList(grade.steals, '💎'), inline: true });
      if (grade.reaches.length)
        embed.addFields({ name: 'Reaches', value: pickList(grade.reaches, '🟧'), inline: true });
      if (grade.starters.missing.length)
        embed.addFields({ name: 'Unfilled starters', value: grade.starters.missing.join(', ') });
      break;
    case 'overview':
    default:
      embed.setDescription(`${gradeHeadline(grade)}\n${overviewSummary(grade)}`);
      break;
  }
  return embed;
}

/** The public "Post to channel" artifact — card + headline + the full per-pick table, no components. */
function renderGradeShareEmbed(
  draft: LiveDraft,
  grade: RosterGrade,
  imageUrl: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`📋 Draft grade: ${grade.grade}`)
    .setDescription(`${gradeHeadline(grade)}\n${gradePicksBlock(grade)}`)
    .setImage(imageUrl)
    .setFooter({ text: gradeFooter(draft) });
}

function gradeFooter(draft: LiveDraft): string {
  const bits = [`${draft.teams}-team PPR`, `slot ${draft.slot}`];
  if (draft.adp) bits.push(`ADP as of ${draft.adp.asOf}`);
  bits.push('💎 steal · 🟩 value · ⬜ fair · 🟧 reach');
  bits.push('grade assumes a completed roster');
  return bits.join(' • ');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
