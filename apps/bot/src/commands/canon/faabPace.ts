import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { BotContext } from '../../config.js';
import { resolveLeagueId } from '../../lib/leagueId.js';
import { ensureSnapshot } from '../../lib/snapshots.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import {
  ensureTransactionsPayload,
  getTransactionTeamId,
  isWaiverSpend,
} from '../../lib/transactions.js';
import { getLeagueInfo } from '../../lib/leagueInfo.js';

interface FaabPaceRow {
  teamId: number;
  name: string;
  total: number;
  left: number;
  frontShare: number;
  weeks: number;
}

export async function handleFaabPaceSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const mode = interaction.options.getString('mode') ?? 'spent';
  const budgetOverride = interaction.options.getInteger('budget') ?? undefined;
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
    const mSettingsPayload = await ensureSnapshot(context, leagueId, season, 'mSettings');
    const nameMap = buildTeamNameMap(mTeamPayload);
    const mTxPayload = await ensureTransactionsPayload(context, leagueId, season);

    const inferredBudget = extractBudget(mSettingsPayload);
    const budget = budgetOverride ?? inferredBudget ?? 100;

    const perTeam = computeFaabPace(mTeamPayload, mTxPayload, budget, nameMap);
    if (perTeam.length === 0) {
      await interaction.editReply({
        content: 'No FAAB spend data found.',
      });
      return;
    }

    const sorted = perTeam.sort((a, b) => b.total - a.total);
    const lines = sorted.map((row, idx) => {
      const headline =
        mode === 'left'
          ? `${idx + 1}. ${row.name} — $${row.left.toFixed(2)} left (spent $${row.total.toFixed(
              2,
            )})`
          : `${idx + 1}. ${row.name} — $${row.total.toFixed(2)} spent (left $${row.left.toFixed(
              2,
            )})`;

      const paceLabel = classifyPace(row.frontShare);
      return `${headline} — pace: ${paceLabel}, weeks tracked: ${row.weeks}`;
    });

    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • FAAB pace (${mode})`, ...lines].join(
        '\n',
      ),
    });
  } catch (error) {
    console.error('Failed to compute FAAB pace', error);
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to compute FAAB pace: ${message}`,
    });
  }
}

function extractBudget(settingsPayload: unknown): number | undefined {
  if (!settingsPayload || typeof settingsPayload !== 'object') return undefined;
  const settings = (settingsPayload as { settings?: unknown }).settings;
  const acquisition =
    settings && typeof settings === 'object'
      ? (settings as { acquisitionSettings?: unknown }).acquisitionSettings
      : undefined;
  const budget =
    acquisition && typeof acquisition === 'object'
      ? (acquisition as { acquisitionBudget?: unknown }).acquisitionBudget
      : undefined;
  return typeof budget === 'number' && Number.isFinite(budget) ? budget : undefined;
}

function computeFaabPace(
  mTeamPayload: unknown,
  mTransactionsPayload: { transactions?: unknown[] } | undefined,
  budget: number,
  nameMap: Map<number, string>,
): FaabPaceRow[] {
  const totalsByTeam = new Map<number, number>();
  const weeksByTeam = new Map<number, Set<number>>();
  const spendByTeamWeek = new Map<number, Map<number, number>>();

  if (mTransactionsPayload && Array.isArray(mTransactionsPayload.transactions)) {
    for (const tx of mTransactionsPayload.transactions) {
      if (!tx || typeof tx !== 'object') continue;
      const t = tx as { bidAmount?: unknown; scoringPeriodId?: unknown };
      if (!isWaiverSpend(tx)) continue;
      const bid = typeof t.bidAmount === 'number' ? t.bidAmount : undefined;
      if (bid === undefined) continue;
      const week = typeof t.scoringPeriodId === 'number' ? t.scoringPeriodId : undefined;
      const teamId = getTransactionTeamId(tx);
      if (teamId === undefined) continue;
      totalsByTeam.set(teamId, (totalsByTeam.get(teamId) ?? 0) + bid);
      if (week !== undefined) {
        const set = weeksByTeam.get(teamId) ?? new Set<number>();
        set.add(week);
        weeksByTeam.set(teamId, set);
        const perWeek = spendByTeamWeek.get(teamId) ?? new Map<number, number>();
        perWeek.set(week, (perWeek.get(week) ?? 0) + bid);
        spendByTeamWeek.set(teamId, perWeek);
      }
    }
  }

  const rows: FaabPaceRow[] = [];
  for (const [teamId, total] of totalsByTeam.entries()) {
    const weekSet = weeksByTeam.get(teamId) ?? new Set<number>();
    const maxWeek = Math.max(0, ...weekSet.values());
    const frontBoundary = maxWeek > 0 ? Math.ceil(maxWeek / 2) : 0;
    const perWeekSpend = spendByTeamWeek.get(teamId) ?? new Map<number, number>();
    let frontSpend = 0;
    for (const [week, amount] of perWeekSpend.entries()) {
      if (week <= frontBoundary) {
        frontSpend += amount;
      }
    }
    const frontShare = total > 0 && maxWeek > 0 ? frontSpend / total : 0.5;
    rows.push({
      teamId,
      name: nameMap.get(teamId) ?? `Team ${teamId}`,
      total,
      left: Math.max(budget - total, 0),
      frontShare,
      weeks: maxWeek,
    });
  }

  return rows;
}

function classifyPace(frontShare: number): string {
  if (!Number.isFinite(frontShare)) return 'unknown';
  if (frontShare >= 0.6) return 'front-loaded';
  if (frontShare <= 0.4) return 'slow-burn';
  return 'balanced';
}
