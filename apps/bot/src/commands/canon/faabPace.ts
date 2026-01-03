import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { BotContext } from "../../config.js";
import { buildTeamNameMap } from "../../lib/teamNames.js";
import {
  ensureTransactionsPayload,
  getTransactionTeamId,
  isWaiverSpend
} from "../../lib/transactions.js";

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
  context: BotContext
): Promise<void> {
  const season = interaction.options.getInteger("season", true);
  const mode = interaction.options.getString("mode") ?? "spent";
  const budgetOverride = interaction.options.getInteger("budget") ?? undefined;
  const leagueOverride = interaction.options.getString("leagueid") ?? undefined;
  const guildId = interaction.guildId;
  const guildConfig = guildId ? await context.leagueConfigRepo.getByGuildId(guildId) : undefined;
  const leagueId = leagueOverride ?? guildConfig?.leagueId ?? context.env.defaultLeagueId;

  if (!leagueId) {
    await interaction.reply({
      content: "League ID is required. Set it via /canon config set or ESPN_LEAGUE_ID.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, "mTeam");
    const mSettingsPayload = await ensureSnapshot(context, leagueId, season, "mSettings");
    const nameMap = buildTeamNameMap(mTeamPayload);
    const mTxPayload = await ensureTransactionsPayload(context, leagueId, season);

    const inferredBudget = extractBudget(mSettingsPayload);
    const budget = budgetOverride ?? inferredBudget ?? 100;

    const perTeam = computeFaabPace(mTeamPayload, mTxPayload, budget, nameMap);
    if (perTeam.length === 0) {
      await interaction.editReply({
        content: "No FAAB spend data found.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const sorted = perTeam.sort((a, b) => b.total - a.total);
    const lines = sorted.map((row, idx) => {
      const headline =
        mode === "left"
          ? `${idx + 1}. ${row.name} — $${row.left.toFixed(2)} left (spent $${row.total.toFixed(
              2
            )})`
          : `${idx + 1}. ${row.name} — $${row.total.toFixed(2)} spent (left $${row.left.toFixed(
              2
            )})`;

      const paceLabel = classifyPace(row.frontShare);
      return `${headline} — pace: ${paceLabel}, weeks tracked: ${row.weeks}`;
    });

    await interaction.editReply({
      content: [`League ${leagueId} • Season ${season} • FAAB pace (${mode})`, ...lines].join(
        "\n"
      ),
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.error("Failed to compute FAAB pace", error);
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to compute FAAB pace: ${message}`,
      flags: MessageFlags.Ephemeral
    });
  }
}

async function ensureSnapshot(
  context: BotContext,
  leagueId: string,
  season: number,
  view: string
): Promise<unknown> {
  const existing = await context.snapshotsRepo.listBySeason(leagueId, season);
  const match = existing.find((s) => s.view === view);
  if (match) return match.payload;
  const res = await context.espnClient.fetchLeague({ leagueId, season, view });
  await context.snapshotsRepo.save({
    leagueId,
    season,
    view,
    fetchedAt: new Date(),
    payload: res.payload
  });
  return res.payload;
}

function extractBudget(settingsPayload: unknown): number | undefined {
  if (!settingsPayload || typeof settingsPayload !== "object") return undefined;
  const settings = (settingsPayload as { settings?: unknown }).settings;
  const acquisition =
    settings && typeof settings === "object"
      ? (settings as { acquisitionSettings?: unknown }).acquisitionSettings
      : undefined;
  const budget =
    acquisition && typeof acquisition === "object"
      ? (acquisition as { acquisitionBudget?: unknown }).acquisitionBudget
      : undefined;
  return typeof budget === "number" && Number.isFinite(budget) ? budget : undefined;
}

function computeFaabPace(
  mTeamPayload: unknown,
  mTransactionsPayload: { transactions?: unknown[] } | undefined,
  budget: number,
  nameMap: Map<number, string>
): FaabPaceRow[] {
  const totalsByTeam = new Map<number, number>();
  const weeksByTeam = new Map<number, number>();

  if (mTransactionsPayload && Array.isArray(mTransactionsPayload.transactions)) {
    for (const tx of mTransactionsPayload.transactions) {
      if (!tx || typeof tx !== "object") continue;
      const t = tx as { bidAmount?: unknown; scoringPeriodId?: unknown };
      if (!isWaiverSpend(tx)) continue;
      const bid = typeof t.bidAmount === "number" ? t.bidAmount : undefined;
      if (bid === undefined) continue;
      const week = typeof t.scoringPeriodId === "number" ? t.scoringPeriodId : undefined;
      const teamId = getTransactionTeamId(tx);
      if (teamId === undefined) continue;
      totalsByTeam.set(teamId, (totalsByTeam.get(teamId) ?? 0) + bid);
      if (week !== undefined) {
        weeksByTeam.set(teamId, Math.max(weeksByTeam.get(teamId) ?? 0, week));
      }
    }
  }

  const rows: FaabPaceRow[] = [];
  for (const [teamId, total] of totalsByTeam.entries()) {
    const weeks = weeksByTeam.get(teamId) ?? 0;
    const frontWeeks = Math.max(1, Math.ceil(weeks / 2));
    const perWeek = weeks > 0 ? total / weeks : total;
    const frontSpend = perWeek * frontWeeks;
    const frontShare = total > 0 ? frontSpend / total : 0;
    rows.push({
      teamId,
      name: nameMap.get(teamId) ?? `Team ${teamId}`,
      total,
      left: Math.max(budget - total, 0),
      frontShare,
      weeks
    });
  }

  return rows;
}

function classifyPace(frontShare: number): string {
  if (!Number.isFinite(frontShare)) return "unknown";
  if (frontShare >= 0.6) return "front-loaded";
  if (frontShare <= 0.4) return "slow-burn";
  return "balanced";
}
