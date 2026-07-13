import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { BotContext } from '../../config.js';
import { resolveLeagueId } from '../../lib/leagueId.js';
import { ensureSnapshot } from '../../lib/snapshots.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import { ensureTransactionsPayload, getTransactionTeamId } from '../../lib/transactions.js';
import { replyWithPagination } from '../../lib/paginate.js';

interface ParsedTransaction {
  teamId?: number;
  teamName: string;
  type: string;
  bid?: number;
  week?: number;
  executedAt?: Date;
}

export async function handleTransactionsSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const limit = interaction.options.getInteger('limit') ?? 10;
  const leagueId = await resolveLeagueId(interaction, context);

  if (!leagueId) {
    await interaction.reply({
      content: 'League ID is required. Set it via /canon config set or ESPN_LEAGUE_ID.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
    const nameMap = buildTeamNameMap(mTeamPayload);
    const mTxPayload: { transactions?: unknown[] } | undefined = await ensureTransactionsPayload(
      context,
      leagueId,
      season,
    );
    if (!mTxPayload) {
      await interaction.editReply({
        content: 'Transactions payload not available for this league/season.',
      });
      return;
    }

    const parsed = extractTransactions(mTxPayload, nameMap).slice(0, limit);

    if (parsed.length === 0) {
      await interaction.editReply({
        content: 'No transactions found.',
      });
      return;
    }

    const lines = parsed.map((tx) => {
      const when = tx.executedAt ? tx.executedAt.toISOString().split('T')[0] : 'unknown date';
      const bid = tx.bid !== undefined ? `$${tx.bid}` : '';
      const week = tx.week ? `Week ${tx.week}` : '';
      const parts = [when, tx.teamName, tx.type, week, bid].filter(Boolean);
      return parts.join(' • ');
    });

    await replyWithPagination(interaction, {
      header: `League ${leagueId} • Season ${season} • Latest ${parsed.length}`,
      rows: lines,
    });
  } catch (error) {
    console.error('Failed to list transactions', error);
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to list transactions: ${message}`,
    });
  }
}

function extractTransactions(payload: unknown, nameMap: Map<number, string>): ParsedTransaction[] {
  if (!payload || typeof payload !== 'object') return [];
  const maybeTxs = (payload as { transactions?: unknown }).transactions;
  if (!Array.isArray(maybeTxs)) return [];

  const parsed: ParsedTransaction[] = [];
  for (const tx of maybeTxs) {
    if (!tx || typeof tx !== 'object') continue;
    const t = tx as {
      actions?: unknown;
      executionDate?: unknown;
      proposedDate?: unknown;
      scoringPeriodId?: unknown;
      type?: unknown;
      transactionType?: unknown;
      bidAmount?: unknown;
    };

    const teamId = getTransactionTeamId(tx);
    const teamName = teamId ? (nameMap.get(teamId) ?? `Team ${teamId}`) : 'Unknown team';
    const dateMs =
      (typeof t.executionDate === 'number' ? t.executionDate : undefined) ??
      (typeof t.proposedDate === 'number' ? t.proposedDate : undefined);
    const executedAt = dateMs ? new Date(dateMs) : undefined;
    const type =
      typeof t.type === 'string'
        ? t.type
        : typeof t.transactionType === 'string'
          ? t.transactionType
          : 'transaction';
    const bid = typeof t.bidAmount === 'number' ? t.bidAmount : undefined;
    const week = typeof t.scoringPeriodId === 'number' ? t.scoringPeriodId : undefined;

    parsed.push({ teamId, teamName, type, bid, week, executedAt });
  }

  return parsed.sort((a, b) => {
    const at = a.executedAt?.getTime() ?? 0;
    const bt = b.executedAt?.getTime() ?? 0;
    return bt - at;
  });
}
