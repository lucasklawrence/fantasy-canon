import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttachmentBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import {
  bestAvailable,
  mergeRankings,
  normalizeName,
  parseRankingsReport,
  type Candidate,
  type DraftPick,
  type DraftState,
  type FadeEntry,
  type PlayerTier,
  type Position,
} from '@fantasy-canon/core';
import { renderCheatSheetCard, type CheatTone } from '@fantasy-canon/renderer';

/** Starting lineup + bench for our standing 12-team league. Drives replacement baselines. */
const ROSTER_SLOTS: Record<string, number> = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  K: 1,
  DST: 1,
  BENCH: 6,
};
const ROSTER_SIZE = Object.values(ROSTER_SLOTS).reduce((a, b) => a + b, 0);
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
    const { players, fades, latestDate } = loadRankings();
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
          ? snakePicks(slot, teams, ROSTER_SIZE).filter((o) => o >= currentOverall)
          : [],
    };

    const candidates = bestAvailable(players, state);
    const poolByName = new Map(players.map((p) => [normalizeName(p.name), p]));

    const tiers = buildBands(candidates, poolByName, currentOverall);
    const cardFades = buildFades(fades, draftedNames);

    const buffer = await renderCheatSheetCard({
      title: 'Draft Cheat Sheet — Best Available',
      subtitle: subtitle(teams, slot, picks.length, latestDate),
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

interface LoadedRankings {
  players: PlayerTier[];
  fades: FadeEntry[];
  latestDate: string;
}

/** Read every research report that carries a draft board and merge them into one pool. */
function loadRankings(): LoadedRankings {
  const dir = resolveResearchDir();
  if (!dir) return { players: [], fades: [], latestDate: '' };

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'TEMPLATE.md' && f !== 'INDEX.md')
    .sort();

  const parsed = files.map((file) =>
    parseRankingsReport(readFileSync(path.join(dir, file), 'utf8'), file),
  );
  const withBoards = parsed.filter((p) => p.players.length > 0);
  const { players, fades } = mergeRankings(withBoards);
  const latestDate = withBoards
    .map((p) => p.meta.date)
    .filter(Boolean)
    .sort()
    .at(-1);

  return { players, fades, latestDate: latestDate ?? '' };
}

/** Locate the repo-root `research/` directory, tolerant of where the bot process was started. */
function resolveResearchDir(): string | undefined {
  const candidates: string[] = [];
  if (process.env.FANTASY_RESEARCH_DIR) candidates.push(process.env.FANTASY_RESEARCH_DIR);

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    candidates.push(path.join(dir, 'research'));
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(path.join(process.cwd(), 'research'));

  return candidates.find((c) => existsSync(c));
}

/** Split a free-text "drafted" field on commas / semicolons / newlines. */
function parseDraftedList(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Overall pick numbers for a manager at 1-based `slot` in a snake draft. */
function snakePicks(slot: number, teams: number, rounds: number): number[] {
  const picks: number[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const inRound = round % 2 === 1 ? slot : teams - slot + 1;
    picks.push((round - 1) * teams + inRound);
  }
  return picks;
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
): string {
  const parts = [`${teams}-team PPR`];
  if (slot !== undefined) parts.push(`slot ${slot}`);
  parts.push(draftedCount === 0 ? 'pre-draft' : `${draftedCount} picks in`);
  parts.push('🟧 reach · 🟩 value · ⬜ wait');
  if (latestDate) parts.push(`as of ${latestDate}`);
  return parts.join(' • ');
}

function cardContent(teams: number, slot: number | undefined, draftedCount: number): string {
  const bits = [`${teams}-team PPR draft cheat sheet`];
  if (slot !== undefined) bits.push(`your slot: ${slot}`);
  bits.push(draftedCount === 0 ? 'board is pre-draft' : `${draftedCount} players off the board`);
  return bits.join(' • ');
}
