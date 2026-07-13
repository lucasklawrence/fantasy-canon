import { AttachmentBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import {
  bestAvailable,
  draftOrder,
  normalizeName,
  type Candidate,
  type DraftPick,
  type DraftState,
  type FadeEntry,
  type PlayerTier,
  type Position,
} from '@fantasy-canon/core';
import { renderCheatSheetCard, type CheatTone } from '@fantasy-canon/renderer';
import {
  loadRankings,
  ROSTER_SLOTS,
  ROSTER_SIZE,
  type AdpProvenance,
} from '../../lib/draftPool.js';

const POSITION_BANDS: Position[] = ['RB', 'WR', 'TE', 'QB'];

/**
 * `/canon draft cheatsheet` — a live best-available draft board built from our archived fantasy
 * research (see `research/*.md`). Enter who's already been drafted and (optionally) your slot, and
 * the card re-ranks the remaining pool by value over replacement, tagging each name reach / value /
 * wait. Pure research → engine → card; no ESPN/DB needed, so it works before the season opens.
 */
export async function handleDraftCheatsheetSubcommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const teams = interaction.options.getInteger('teams') ?? 12;
  const slot = interaction.options.getInteger('pick') ?? undefined;
  const draftedRaw = interaction.options.getString('drafted') ?? '';

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const { players, fades, latestDate, adp } = await loadRankings();
    if (players.length === 0) {
      await interaction.editReply({
        content:
          'No draft board found. Add a research report with a "Draft board" table under `research/` ' +
          '(e.g. via `/fantasy-research`) and try again.',
      });
      return;
    }

    const draftedNames = parseDraftedList(draftedRaw);
    const picks: DraftPick[] = draftedNames.map((name, idx) => ({
      overall: idx + 1,
      teamId: 0,
      playerName: name,
    }));
    const currentOverall = picks.length + 1;

    const state: DraftState = {
      leagueSize: teams,
      rosterSlots: ROSTER_SLOTS,
      scoring: 'ppr',
      myTeamId: slot ?? 1,
      picks,
      myUpcomingOveralls:
        slot !== undefined
          ? draftOrder(slot, teams, ROSTER_SIZE).filter((o) => o >= currentOverall)
          : [],
    };

    const candidates = bestAvailable(players, state);
    const poolByName = new Map(players.map((p) => [normalizeName(p.name), p]));

    const tiers = buildBands(candidates, poolByName, currentOverall);
    const cardFades = buildFades(fades, draftedNames);

    const buffer = await renderCheatSheetCard({
      title: 'Draft Cheat Sheet — Best Available',
      subtitle: subtitle(teams, slot, picks.length, latestDate, adp),
      tiers,
      fades: cardFades,
    });

    const attachment = new AttachmentBuilder(buffer, { name: 'draft-cheatsheet.png' });
    await interaction.editReply({
      content: cardContent(teams, slot, picks.length),
      files: [attachment],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({ content: `Failed to build cheat sheet: ${message}` });
  }
}

/** Split a free-text "drafted" field on commas / semicolons / newlines. */
function parseDraftedList(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const TONE_LABEL: Record<CheatTone, string> = {
  reach: 'REACH',
  value: 'VALUE',
  wait: 'wait',
  fade: 'FADE',
  neutral: '',
};

/**
 * Group ranked candidates into card bands: a headline "best available" band, then one band per
 * position. Position bands exclude anyone already shown up top so the board doesn't repeat itself.
 */
function buildBands(
  candidates: Candidate[],
  poolByName: Map<string, PlayerTier>,
  currentOverall: number,
): Array<{ label: string; players: ReturnType<typeof toRow>[] }> {
  const bands: Array<{ label: string; players: ReturnType<typeof toRow>[] }> = [];

  const headline = candidates.slice(0, 8);
  const headlineNames = new Set(headline.map((c) => normalizeName(c.name)));
  if (headline.length) {
    bands.push({
      label: `🎯 Best available (pick ${currentOverall})`,
      players: headline.map((c) => toRow(c, poolByName, true)),
    });
  }

  for (const pos of POSITION_BANDS) {
    const rows = candidates
      .filter((c) => c.position === pos && !headlineNames.has(normalizeName(c.name)))
      .slice(0, 6)
      .map((c) => toRow(c, poolByName, false));
    if (rows.length) bands.push({ label: pos, players: rows });
  }

  return bands;
}

function toRow(
  c: Candidate,
  poolByName: Map<string, PlayerTier>,
  headline: boolean,
): {
  name: string;
  pos: string;
  adp?: number;
  note?: string;
  tone: CheatTone;
} {
  const poolNote = poolByName.get(normalizeName(c.name))?.note;
  // Lead with the reach/value/wait call in the headline band; position bands lean on the note.
  const tag = headline ? TONE_LABEL[c.recommend] : '';
  const note = [tag, poolNote].filter(Boolean).join(' · ') || undefined;
  // VOR is intentionally omitted: on a partial research board its cross-position scale is noisy.
  // ADP + the reach/value/wait tone are the trustworthy signals to surface.
  return { name: c.name, pos: c.position, adp: c.adp, note, tone: c.recommend };
}

/** Fades still worth showing — drop any that have already been drafted. */
function buildFades(
  fades: FadeEntry[],
  draftedNames: string[],
): Array<{ name: string; pos: string; reason: string }> {
  const drafted = new Set(draftedNames.map(normalizeName));
  return fades
    .filter((f) => !drafted.has(normalizeName(f.name)))
    .map((f) => ({ name: f.name, pos: f.position, reason: f.reason }));
}

function subtitle(
  teams: number,
  slot: number | undefined,
  draftedCount: number,
  latestDate: string,
  adp: AdpProvenance | undefined,
): string {
  const parts = [`${teams}-team PPR`];
  if (slot !== undefined) parts.push(`slot ${slot}`);
  parts.push(draftedCount === 0 ? 'pre-draft' : `${draftedCount} picks in`);
  parts.push('🟧 reach · 🟩 value · ⬜ wait');
  // Prefer the live-ADP provenance (freshest, drives the ranking); fall back to the research date.
  if (adp) parts.push(`ADP as of ${adp.asOf} · ${adp.sampleSize.toLocaleString('en-US')} mocks`);
  else if (latestDate) parts.push(`research as of ${latestDate}`);
  return parts.join(' • ');
}

function cardContent(teams: number, slot: number | undefined, draftedCount: number): string {
  const bits = [`${teams}-team PPR draft cheat sheet`];
  if (slot !== undefined) bits.push(`your slot: ${slot}`);
  bits.push(draftedCount === 0 ? 'board is pre-draft' : `${draftedCount} players off the board`);
  return bits.join(' • ');
}
