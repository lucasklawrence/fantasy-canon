/**
 * `/canon draft start|pick|best|status|grade|stop` — a live draft session. `start` opens a running
 * session for the channel (from the same research + market-ADP pool as `cheatsheet`); picks stream in
 * either manually (`pick`) or automatically from an ESPN draft room via the capture sink + userscript;
 * `best` re-runs the value-based-drafting engine over whoever's left; and `grade` scores your roster
 * with the reproducible value-vs-ADP grade engine. The heavy lifting is the pure core reducer
 * (`createDraftSession`/`applyPick`/`toDraftState`, `gradeSession`) — everything here is glue + display.
 */

import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
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
import { loadRankings, ROSTER_SLOTS } from '../../lib/draftPool.js';
import { EspnSinkDraftSource } from '../../lib/draft/espnSinkSource.js';
import { runDraftPoller } from '../../lib/draft/poller.js';
import {
  endDraft,
  getDraft,
  setDraft,
  type DraftSourceKind,
  type LiveDraft,
} from '../../lib/draft/sessionStore.js';

/** One live draft per channel. */
function draftKey(interaction: ChatInputCommandInteraction): string {
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

  await interaction.reply({ embeds: [renderGrade(draft, grade)], flags: MessageFlags.Ephemeral });
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

/** Build the roster-grade embed for a finished (or in-progress) session. */
function renderGrade(draft: LiveDraft, grade: RosterGrade): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`📋 Draft grade: ${grade.grade}`)
    .setDescription(`${gradeHeadline(grade)}\n${gradePicksBlock(grade)}`)
    .setFooter({ text: gradeFooter(draft) });

  if (grade.steals.length) {
    embed.addFields({
      name: 'Steals',
      value: grade.steals.map((p) => `💎 ${p.playerName} (${signed(p.value ?? 0)})`).join('\n'),
      inline: true,
    });
  }
  if (grade.reaches.length) {
    embed.addFields({
      name: 'Reaches',
      value: grade.reaches.map((p) => `🟧 ${p.playerName} (${signed(p.value ?? 0)})`).join('\n'),
      inline: true,
    });
  }
  if (grade.starters.missing.length) {
    embed.addFields({ name: 'Unfilled starters', value: grade.starters.missing.join(', ') });
  }
  return embed;
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
