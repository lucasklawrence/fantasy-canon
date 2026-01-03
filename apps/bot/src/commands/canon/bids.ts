import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { BotContext } from "../../config.js";
import { buildTeamNameMap } from "../../lib/teamNames.js";
import { ensureTransactionsPayload, getTransactionTeamId, isWaiverSpend } from "../../lib/transactions.js";
import { getLeagueInfo } from "../../lib/leagueInfo.js";

interface PlayerBid {
  playerId: number;
  playerLabel: string;
  bids: Array<{ teamId?: number; teamName: string; bid: number; date?: Date }>;
}

export async function handleBidsSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const season = interaction.options.getInteger("season", true);
  const mode = interaction.options.getString("mode") ?? "close";
  const threshold = interaction.options.getInteger("threshold") ?? (mode === "lopsided" ? 3 : 5);
  const limit = interaction.options.getInteger("limit") ?? 5;
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
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const mTeamPayload: unknown = await ensureSnapshot(context, leagueId, season, "mTeam");
    const mRosterPayload: unknown = await ensureSnapshot(context, leagueId, season, "mRoster");
    const teamNames = buildTeamNameMap(mTeamPayload);
    const playerNames = buildPlayerNameMap(mRosterPayload);
    const mTxPayload =
      (await ensureTransactionsPayload(context, leagueId, season)) as
        | { transactions?: unknown[] }
        | undefined;
    if (!mTxPayload) {
      await interaction.editReply({
        content: "Transactions payload not available for this league/season.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const playerBids = groupBidsByPlayer(mTxPayload, teamNames, playerNames);

    const filtered =
      mode === "lopsided"
        ? findLopsided(playerBids, threshold, limit)
        : findClose(playerBids, threshold, limit);

    if (filtered.length === 0) {
      await interaction.editReply({
        content: `No ${mode} bids found.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const lines = filtered.map((pb) => {
      const sorted = [...pb.bids].sort((a, b) => b.bid - a.bid);
      const top = sorted[0];
      const low = sorted[sorted.length - 1];
      const spread = top.bid - low.bid;
      const ratio = low.bid > 0 ? top.bid / low.bid : Infinity;
      const descriptor =
        mode === "lopsided"
          ? `spread $${spread.toFixed(2)} (x${ratio.toFixed(2)})`
          : `spread $${spread.toFixed(2)}`;
      const bidStrings = sorted
        .map((b) => `${b.teamName}: $${b.bid}${b.date ? ` @ ${b.date.toISOString().split("T")[0]}` : ""}`)
        .join(" | ");
      return `${pb.playerLabel} — ${descriptor} — ${bidStrings}`;
    });

    const leagueLabel = leagueInfo.name ?? leagueId;
    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • ${mode} bids`, ...lines].join("\n"),
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.error("Failed to compute bids spread", error);
    const message = error instanceof Error ? error.message : String(error);
    await interaction.editReply({
      content: `Failed to compute bids: ${message}`,
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

function groupBidsByPlayer(
  payload: unknown,
  nameMap: Map<number, string>,
  playerMap: Map<number, string>
): PlayerBid[] {
  if (!payload || typeof payload !== "object") return [];
  const maybeTxs = (payload as { transactions?: unknown }).transactions;
  if (!Array.isArray(maybeTxs)) return [];

  const map = new Map<number, PlayerBid>();

  for (const tx of maybeTxs) {
    if (!tx || typeof tx !== "object") continue;
    const t = tx as {
      bidAmount?: unknown;
      items?: unknown;
      actions?: unknown;
      executionDate?: unknown;
      proposedDate?: unknown;
    };
    if (!isWaiverSpend(tx)) continue;
    const bid = typeof t.bidAmount === "number" ? t.bidAmount : undefined;
    if (bid === undefined) continue;
    const dateMs =
      (typeof t.executionDate === "number" ? t.executionDate : undefined) ??
      (typeof t.proposedDate === "number" ? t.proposedDate : undefined);
    const date = dateMs ? new Date(dateMs) : undefined;

    const playerId = extractPlayerId(t.items);
    if (playerId === undefined) continue;

    const teamId = getTransactionTeamId(tx);
    const teamName = teamId ? nameMap.get(teamId) ?? `Team ${teamId}` : "Unknown team";

    const existing = map.get(playerId);
    const entry: PlayerBid = existing ?? {
      playerId,
      playerLabel: buildPlayerLabel(t.items, playerId, playerMap),
      bids: []
    };
    entry.bids.push({ teamId, teamName, bid, date });
    map.set(playerId, entry);
  }

  return Array.from(map.values()).filter((pb) => pb.bids.length >= 2);
}

function extractPlayerId(items: unknown): number | undefined {
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const i = item as { playerId?: unknown; targetId?: unknown };
    const playerId =
      Number.isFinite(Number(i.playerId)) ? Number(i.playerId) : Number.isFinite(Number(i.targetId)) ? Number(i.targetId) : undefined;
    if (playerId !== undefined) return playerId;
  }
  return undefined;
}

function buildPlayerLabel(items: unknown, fallbackId: number, playerMap: Map<number, string>): string {
  const fromMap = playerMap.get(fallbackId);
  if (fromMap) return fromMap;
  if (!Array.isArray(items)) return `Player ${fallbackId}`;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const i = item as {
      playerId?: unknown;
      targetId?: unknown;
      player?: unknown;
      playerPoolEntry?: unknown;
      fullName?: unknown;
    };
    const directPlayer =
      i.player && typeof i.player === "object"
        ? (i.player as { fullName?: unknown; defaultPositionId?: unknown })
        : undefined;
    const poolPlayer =
      i.playerPoolEntry && typeof i.playerPoolEntry === "object"
        ? ((i.playerPoolEntry as { player?: unknown }).player as
            | { fullName?: unknown; defaultPositionId?: unknown }
            | undefined)
        : undefined;
    const nameField =
      (directPlayer && typeof directPlayer.fullName === "string" ? directPlayer.fullName : undefined) ??
      (poolPlayer && typeof poolPlayer.fullName === "string" ? poolPlayer.fullName : undefined) ??
      (typeof i.fullName === "string" ? i.fullName : undefined);
    const pos =
      (directPlayer && typeof directPlayer.defaultPositionId === "number"
        ? directPlayer.defaultPositionId
        : poolPlayer && typeof poolPlayer.defaultPositionId === "number"
          ? poolPlayer.defaultPositionId
          : undefined) ?? undefined;
    const position = pos !== undefined ? ` (pos ${pos})` : "";
    if (typeof nameField === "string") return `${nameField}${position}`;
  }
  return `Player ${fallbackId}`;
}

function buildPlayerNameMap(rosterPayload: unknown): Map<number, string> {
  const map = new Map<number, string>();
  if (!rosterPayload || typeof rosterPayload !== "object") return map;
  const teams = (rosterPayload as { teams?: unknown }).teams;
  if (!Array.isArray(teams)) return map;
  for (const team of teams) {
    if (!team || typeof team !== "object") continue;
    const entries = (team as { roster?: unknown }).roster;
    const entriesArr = entries && typeof entries === "object" ? (entries as { entries?: unknown }).entries : undefined;
    if (!Array.isArray(entriesArr)) continue;
    for (const entry of entriesArr) {
      if (!entry || typeof entry !== "object") continue;
      const pe = (entry as { playerPoolEntry?: unknown }).playerPoolEntry;
      const player =
        pe && typeof pe === "object" && (pe as { player?: unknown }).player && typeof (pe as { player?: unknown }).player === "object"
          ? ((pe as { player: { id?: unknown; fullName?: unknown } }).player as { id?: unknown; fullName?: unknown })
          : undefined;
      const id = Number(player?.id);
      const name = typeof player?.fullName === "string" ? player.fullName : undefined;
      if (Number.isFinite(id) && name) {
        map.set(id, name);
      }
    }
  }
  return map;
}

function findClose(playerBids: PlayerBid[], spreadThreshold: number, limit: number): PlayerBid[] {
  const close = playerBids
    .map((pb) => {
      const bids = [...pb.bids].sort((a, b) => b.bid - a.bid);
      const spread = bids[0].bid - bids[bids.length - 1].bid;
      return { pb, spread };
    })
    .filter((entry) => entry.spread <= spreadThreshold)
    .sort((a, b) => a.spread - b.spread)
    .slice(0, limit)
    .map((entry) => entry.pb);
  return close;
}

function findLopsided(playerBids: PlayerBid[], ratioThreshold: number, limit: number): PlayerBid[] {
  const lopsided = playerBids
    .map((pb) => {
      const bids = [...pb.bids].sort((a, b) => b.bid - a.bid);
      const ratio = bids[bids.length - 1].bid > 0 ? bids[0].bid / bids[bids.length - 1].bid : Infinity;
      return { pb, ratio };
    })
    .filter((entry) => entry.ratio >= ratioThreshold)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, limit)
    .map((entry) => entry.pb);
  return lopsided;
}
