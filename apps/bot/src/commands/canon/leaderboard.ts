import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { buildFaabLeaderboard } from "@fantasy-canon/core";
import { BotContext } from "../../config.js";
import { buildTeamNameMap, formatTeamName } from "../../lib/teamNames.js";
import { ensureTransactionsPayload, getTransactionTeamId, isWaiverSpend } from "../../lib/transactions.js";

interface TeamWithFaab {
  teamId: number;
  name: string;
  amount: number;
  remaining?: number;
}

export async function handleLeaderboardSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const metric = interaction.options.getString("metric", true);
  const season = interaction.options.getInteger("season", true);
  const limit = interaction.options.getInteger("limit") ?? 12;
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

  if (metric !== "faab") {
    await interaction.reply({
      content: `Metric "${metric}" is not supported yet.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, "mTeam");
    const nameMap = buildTeamNameMap(mTeamPayload);
    const faabEntries = extractFaab(mTeamPayload);

    let entries: TeamWithFaab[] = faabEntries;
    if (entries.length === 0) {
      const mTxPayload = await ensureTransactionsPayload(context, leagueId, season);
      if (mTxPayload) {
        entries = extractFaabFromTransactions(mTxPayload, nameMap);
      }
    }

    if (entries.length === 0) {
      await interaction.editReply({
        content: "No FAAB data found.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const leaderboard = buildFaabLeaderboard({
      season,
      entries: entries.map((e) => ({ teamId: e.teamId, amount: e.amount })),
      limit
    });

    const lookup = new Map(entries.map((e) => [e.teamId, e]));
    const lines = leaderboard.map((entry, idx) => {
      const team = lookup.get(entry.teamId);
      const name = team?.name ?? nameMap.get(entry.teamId) ?? `Team ${entry.teamId}`;
      const remaining = team?.remaining;
      const leftText = typeof remaining === "number" ? ` (left $${remaining.toFixed(2)})` : "";
      return `${idx + 1}. ${name} — $${entry.amount.toFixed(2)}${leftText}`;
    });

    await interaction.editReply({
      content: [`League ${leagueId} • Season ${season} • Metric: FAAB`, ...lines].join("\n"),
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.error("Failed to build leaderboard", error);
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to build leaderboard: ${message}`,
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

function extractFaab(payload: unknown): TeamWithFaab[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const maybeTeams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(maybeTeams)) {
    return [];
  }

  const teams: TeamWithFaab[] = [];
  for (const team of maybeTeams) {
    if (!team || typeof team !== "object") continue;
    const t = team as {
      id?: unknown;
      location?: unknown;
      nickname?: unknown;
      name?: unknown;
      abbrev?: unknown;
      transactionCounter?: unknown;
    };
    const teamId = Number(t.id);
    if (!Number.isFinite(teamId)) continue;
    const name = formatTeamName(t, teamId);
    const tc =
      t.transactionCounter && typeof t.transactionCounter === "object"
        ? (t.transactionCounter as { acquisitionBudgetSpent?: unknown; matchupAcquisitionTotals?: unknown })
        : undefined;
    const amount =
      typeof tc?.acquisitionBudgetSpent === "number"
        ? tc.acquisitionBudgetSpent
        : sumTotals(tc?.matchupAcquisitionTotals);
    if (amount === undefined) continue;
    teams.push({ teamId, name, amount });
  }

  return teams;
}

function sumTotals(totals: unknown): number | undefined {
  if (!Array.isArray(totals)) return undefined;
  const numeric = totals.map((v) => (typeof v === "number" ? v : 0)).filter((v) => Number.isFinite(v));
  if (numeric.length === 0) return undefined;
  return numeric.reduce((acc, v) => acc + v, 0);
}

function extractFaabFromTransactions(
  payload: unknown,
  nameMap: Map<number, string>
): TeamWithFaab[] {
  if (!payload || typeof payload !== "object") return [];
  const maybeTxs = (payload as { transactions?: unknown }).transactions;
  if (!Array.isArray(maybeTxs)) return [];

  const totals = new Map<number, number>();

  for (const tx of maybeTxs) {
    if (!tx || typeof tx !== "object") continue;
    if (!isWaiverSpend(tx)) continue;
    const t = tx as { bidAmount?: unknown };
    const bid = typeof t.bidAmount === "number" ? t.bidAmount : undefined;
    if (bid === undefined) continue;
    const teamId = getTransactionTeamId(tx);
    if (teamId === undefined) continue;
    totals.set(teamId, (totals.get(teamId) ?? 0) + bid);
  }

  return Array.from(totals.entries()).map(([teamId, amount]) => ({
    teamId,
    name: nameMap.get(teamId) ?? `Team ${teamId}`,
    amount
  }));
}
