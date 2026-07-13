import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { BotContext } from '../../config.js';
import { resolveLeagueId } from '../../lib/leagueId.js';
import { getLeagueInfo } from '../../lib/leagueInfo.js';
import { replyWithPagination } from '../../lib/paginate.js';

export async function handleTimelineSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const seasons = interaction.options.getString('seasons') ?? '';
  const limit = interaction.options.getInteger('limit') ?? 10;
  const offset = interaction.options.getInteger('offset') ?? 0;
  const leagueId = await resolveLeagueId(interaction, context);

  if (!leagueId) {
    await interaction.reply({
      content: 'League ID is required. Set it via /canon config set or ESPN_LEAGUE_ID.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const seasonFilter = parseSeasonList(seasons);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const seasonForName = seasonFilter[0] ?? new Date().getFullYear();
    const leagueInfo = await getLeagueInfo(context, leagueId, seasonForName);
    const events = await context.canonEventsRepo.list({
      leagueId,
      season: seasonFilter.length === 1 ? seasonFilter[0] : undefined,
      limit,
      offset,
    });

    if (events.length === 0) {
      await interaction.editReply({
        content: 'No canon events found. Run champ/luck commands to seed history.',
      });
      return;
    }

    const lines = events.map((e) => {
      const ts = e.createdAt.toISOString().split('T')[0];
      return `${ts} • ${e.season} • ${e.type} • ${e.message}`;
    });

    await replyWithPagination(interaction, {
      header: `League ${leagueInfo.name ?? leagueId} • Timeline`,
      rows: lines,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to load timeline: ${message}`,
    });
  }
}

function parseSeasonList(text: string): number[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(',').map((p) => p.trim());
  const seasons: number[] = [];
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map((p) => Number.parseInt(p.trim(), 10));
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const [lo, hi] = start <= end ? [start, end] : [end, start];
        for (let y = lo; y <= hi; y += 1) {
          seasons.push(y);
        }
      }
    } else {
      const yr = Number.parseInt(part, 10);
      if (Number.isFinite(yr)) seasons.push(yr);
    }
  }
  return Array.from(new Set(seasons)).sort((a, b) => a - b);
}
