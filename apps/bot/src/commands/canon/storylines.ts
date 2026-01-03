import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { BotContext } from "../../config.js";
import { buildTeamNameMap } from "../../lib/teamNames.js";
import { getLeagueInfo } from "../../lib/leagueInfo.js";

type TeamLike = {
  id?: unknown;
  name?: unknown;
  abbrev?: unknown;
  location?: unknown;
  nickname?: unknown;
  record?: unknown;
  transactionCounter?: unknown;
  tradeBlock?: unknown;
  draftDayProjectedRank?: unknown;
  rankFinal?: unknown;
  rankCalculatedFinal?: unknown;
  playoffSeed?: unknown;
};

export async function handleLuckSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const season = interaction.options.getInteger("season", true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, "mTeam");
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);
    if (teams.length === 0) {
      await interaction.editReply({ content: "No teams found.", flags: MessageFlags.Ephemeral });
      return;
    }

    const pointsRank = rankBy(teams, (t) => t.pointsFor, "desc");
    const winRank = rankBy(teams, (t) => t.wins, "desc");

    const entries = teams.map((t) => {
      const pr = pointsRank.get(t.id) ?? teams.length;
      const wr = winRank.get(t.id) ?? teams.length;
      const luckIndex = pr - wr; // positive => luckier (wins outpace points rank)
      return { ...t, luckIndex, pointsRank: pr, winRank: wr };
    });

    const luckiest = [...entries].sort((a, b) => b.luckIndex - a.luckIndex).slice(0, 3);
    const unluckiest = [...entries].sort((a, b) => a.luckIndex - b.luckIndex).slice(0, 3);

    const lines: string[] = [];
    lines.push("Luckiest:");
    lines.push(
      ...luckiest.map(
        (e, idx) =>
          `${idx + 1}. ${nameMap.get(e.id) ?? `Team ${e.id}`} — luck +${e.luckIndex.toFixed(
            2
          )} (points rank ${e.pointsRank}, win rank ${e.winRank})`
      )
    );
    lines.push("Unluckiest:");
    lines.push(
      ...unluckiest.map(
        (e, idx) =>
          `${idx + 1}. ${nameMap.get(e.id) ?? `Team ${e.id}`} — luck ${e.luckIndex.toFixed(
            2
          )} (points rank ${e.pointsRank}, win rank ${e.winRank})`
      )
    );

    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • Luck`, ...lines].join("\n"),
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    await handleError(interaction, error, "luck");
  }
}

export async function handleDraftProphecySubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const season = interaction.options.getInteger("season", true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, "mTeam");
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);
    if (teams.length === 0) {
      await interaction.editReply({ content: "No teams found.", flags: MessageFlags.Ephemeral });
      return;
    }

    const finishRank = rankBy(teams, (t) => t.finishRank ?? t.wins, "asc");

    const deltas = teams
      .map((t) => {
        const projected = typeof t.projectedRank === "number" ? t.projectedRank : undefined;
        if (projected === undefined) return undefined;
        const finalRank = finishRank.get(t.id) ?? teams.length;
        const delta = projected - finalRank; // positive means over-performed vs draft expectations
        return { ...t, projected, finalRank, delta };
      })
      .filter(Boolean) as Array<{ id: number; projected: number; finalRank: number; delta: number }>;

    if (deltas.length === 0) {
      await interaction.editReply({
        content: "Draft projection data not available.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const steals = [...deltas].sort((a, b) => b.delta - a.delta).slice(0, 3);
    const busts = [...deltas].sort((a, b) => a.delta - b.delta).slice(0, 3);

    const lines: string[] = [];
    lines.push("Steals (beat the prophecy):");
    lines.push(
      ...steals.map(
        (e, idx) =>
          `${idx + 1}. ${nameMap.get(e.id) ?? `Team ${e.id}`} — Δ${e.delta.toFixed(
            1
          )} (proj ${e.projected}, finish ${e.finalRank})`
      )
    );
    lines.push("Busts (fell short):");
    lines.push(
      ...busts.map(
        (e, idx) =>
          `${idx + 1}. ${nameMap.get(e.id) ?? `Team ${e.id}`} — Δ${e.delta.toFixed(
            1
          )} (proj ${e.projected}, finish ${e.finalRank})`
      )
    );

    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • Draft Prophecy`, ...lines].join("\n"),
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    await handleError(interaction, error, "draft-prophecy");
  }
}

export async function handleStreaksSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const season = interaction.options.getInteger("season", true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, "mTeam");
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);

    const longestWin = maxBy(teams, (t) => (t.streakType === "WIN" ? t.streakLength : 0));
    const longestLoss = maxBy(teams, (t) => (t.streakType === "LOSS" ? t.streakLength : 0));
    const current = [...teams]
      .filter((t) => t.streakLength > 0)
      .sort((a, b) => b.streakLength - a.streakLength)
      .slice(0, 3);

    const lines: string[] = [];
    if (longestWin) {
      lines.push(
        `Longest win streak: ${nameMap.get(longestWin.id) ?? `Team ${longestWin.id}`} — ${
          longestWin.streakLength
        }`
      );
    }
    if (longestLoss) {
      lines.push(
        `Longest losing streak: ${nameMap.get(longestLoss.id) ?? `Team ${longestLoss.id}`} — ${
          longestLoss.streakLength
        }`
      );
    }
    lines.push("Current streak leaders:");
    lines.push(
      ...current.map(
        (t, idx) =>
          `${idx + 1}. ${nameMap.get(t.id) ?? `Team ${t.id}`} — ${t.streakType ?? "UNK"} ${
            t.streakLength
          }`
      )
    );

    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • Streaks`, ...lines].join("\n"),
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    await handleError(interaction, error, "streaks");
  }
}

export async function handleManagerArchetypesSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const season = interaction.options.getInteger("season", true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, "mTeam");
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);

    const avg = (field: keyof TeamInfo): number => {
      const vals = teams.map((t) => t[field] ?? 0);
      const total = vals.reduce((acc, v) => acc + v, 0);
      return teams.length ? total / teams.length : 0;
    };
    const avgAdds = avg("acquisitions");
    const avgMoves = avg("moves");
    const avgIr = avg("movesToIr");
    const avgTotal = avg("totalMoves");

    const archetypes = teams.map((t) => {
      const ratios = [
        { key: "Wire Addict", score: ratio(t.acquisitions, avgAdds) },
        { key: "Lineup Tinkerer", score: ratio(t.moves, avgMoves) },
        { key: "IR Surgeon", score: ratio(t.movesToIr, avgIr) }
      ];
      const best = ratios.sort((a, b) => b.score - a.score)[0];
      const minimalist = ratio(t.totalMoves, avgTotal) < 0.5;
      const label = minimalist ? "Minimalist" : best.key;
      const detail =
        label === "Minimalist"
          ? `total ${t.totalMoves}`
          : label === "Wire Addict"
            ? `adds ${t.acquisitions}`
            : label === "Lineup Tinkerer"
              ? `moveToActive ${t.moves}`
              : `moveToIR ${t.movesToIr}`;
      return { id: t.id, label, detail };
    });

    const lines = archetypes.map(
      (a) => `${nameMap.get(a.id) ?? `Team ${a.id}`} — ${a.label} (${a.detail})`
    );

    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • Manager archetypes`, ...lines].join(
        "\n"
      ),
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    await handleError(interaction, error, "manager-archetypes");
  }
}

export async function handleTradeBlockSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const season = interaction.options.getInteger("season", true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, "mTeam");
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);

    const entries = teams.map((t) => {
      const onBlock = t.tradeBlockOn;
      const untouchable = t.tradeBlockUntouchable;
      return { id: t.id, onBlock, untouchable };
    });

    const mostOnBlock = [...entries].sort((a, b) => b.onBlock - a.onBlock).slice(0, 3);
    const mostUntouchable = [...entries].sort((a, b) => b.untouchable - a.untouchable).slice(0, 3);

    const lines: string[] = [];
    lines.push("Most on the block:");
    lines.push(
      ...mostOnBlock.map(
        (e, idx) =>
          `${idx + 1}. ${nameMap.get(e.id) ?? `Team ${e.id}`} — ${e.onBlock} listed on the block`
      )
    );
    lines.push("Most untouchables:");
    lines.push(
      ...mostUntouchable.map(
        (e, idx) =>
          `${idx + 1}. ${nameMap.get(e.id) ?? `Team ${e.id}`} — ${e.untouchable} untouchable`
      )
    );

    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • Trade block`, ...lines].join("\n"),
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    await handleError(interaction, error, "tradeblock");
  }
}

export async function handleHomeAwaySubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const season = interaction.options.getInteger("season", true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, "mTeam");
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);

    const splits = teams.map((t) => {
      const homeWinPct = winPct(t.homeWins, t.homeLosses);
      const awayWinPct = winPct(t.awayWins, t.awayLosses);
      const delta = homeWinPct - awayWinPct;
      return { id: t.id, homeWinPct, awayWinPct, delta };
    });

    const homeMerchant = maxBy(splits, (s) => s.delta);
    const roadWarrior = maxBy(splits, (s) => -s.delta);

    const lines: string[] = [];
    if (homeMerchant) {
      lines.push(
        `Home merchant: ${nameMap.get(homeMerchant.id) ?? `Team ${homeMerchant.id}`} — home ${
          (homeMerchant.homeWinPct * 100).toFixed(1)
        }%, away ${(homeMerchant.awayWinPct * 100).toFixed(1)}%`
      );
    }
    if (roadWarrior) {
      lines.push(
        `Road warrior: ${nameMap.get(roadWarrior.id) ?? `Team ${roadWarrior.id}`} — home ${
          (roadWarrior.homeWinPct * 100).toFixed(1)
        }%, away ${(roadWarrior.awayWinPct * 100).toFixed(1)}%`
      );
    }

    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • Home/Away`, ...lines].join("\n"),
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    await handleError(interaction, error, "homeaway");
  }
}

export async function handleChampSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const season = interaction.options.getInteger("season", true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, "mTeam");
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);
    if (teams.length === 0) {
      await interaction.editReply({ content: "No teams found.", flags: MessageFlags.Ephemeral });
      return;
    }

    const finishRank = rankBy(teams, (t) => t.finishRank ?? t.wins, "asc");
    const champ = teams.find((t) => finishRank.get(t.id) === 1) ?? teams[0];
    const champName = nameMap.get(champ.id) ?? `Team ${champ.id}`;
    const draft = champ.projectedRank ? `draft proj ${champ.projectedRank}` : "draft proj n/a";
    const points = champ.pointsFor !== undefined ? `points ${champ.pointsFor.toFixed(1)}` : "";
    const record = `${champ.wins}-${champ.losses}${champ.ties ? `-${champ.ties}` : ""}`;
    const faab =
      champ.acquisitionBudgetSpent !== undefined
        ? `FAAB spent $${champ.acquisitionBudgetSpent.toFixed(0)}`
        : "";

    const lines = [
      `${champName} is the champion of ${season}.`,
      `Record ${record}${points ? `, ${points}` : ""}.`,
      `${draft}${faab ? `, ${faab}` : ""}.`
    ];

    await interaction.editReply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    await handleError(interaction, error, "champ");
  }
}

export async function handleChampsSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<void> {
  const seasonsText = interaction.options.getString("seasons", true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }

  const seasons = parseSeasonList(seasonsText);
  if (seasons.length === 0) {
    await interaction.reply({
      content: "Provide seasons as comma list or range (e.g., 2022-2025 or 2024,2025).",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const results: string[] = [];
  for (const season of seasons) {
    try {
      const mTeamPayload = await ensureSnapshot(context, leagueId, season, "mTeam");
      const nameMap = buildTeamNameMap(mTeamPayload);
      const teams = extractTeams(mTeamPayload);
      if (teams.length === 0) {
        results.push(`${season}: no teams found`);
        continue;
      }
      const finishRank = rankBy(teams, (t) => t.finishRank ?? t.wins, "asc");
      const champ = teams.find((t) => finishRank.get(t.id) === 1) ?? teams[0];
      const champName = nameMap.get(champ.id) ?? `Team ${champ.id}`;
      const record = `${champ.wins}-${champ.losses}${champ.ties ? `-${champ.ties}` : ""}`;
      results.push(`${season}: ${champName} (${record})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(`${season}: error ${message}`);
    }
  }

  await interaction.editReply({
    content: [`League ${leagueId} ’'?ƒ?§ Champs`, ...results].join("\n"),
    flags: MessageFlags.Ephemeral
  });
}

// Helpers

async function resolveLeagueId(
  interaction: ChatInputCommandInteraction,
  context: BotContext
): Promise<string | undefined> {
  const leagueOverride = interaction.options.getString("leagueid") ?? undefined;
  const guildId = interaction.guildId;
  const guildConfig = guildId ? await context.leagueConfigRepo.getByGuildId(guildId) : undefined;
  return leagueOverride ?? guildConfig?.leagueId ?? context.env.defaultLeagueId;
}

async function missingLeagueReply(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: "League ID is required. Set it via /canon config set or ESPN_LEAGUE_ID.",
    flags: MessageFlags.Ephemeral
  });
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

interface TeamInfo {
  id: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  streakType?: string;
  streakLength: number;
  acquisitions: number;
  moves: number;
  movesToIr: number;
  totalMoves: number;
  tradeBlockOn: number;
  tradeBlockUntouchable: number;
  projectedRank?: number;
  finishRank?: number;
  homeWins: number;
  homeLosses: number;
  awayWins: number;
  awayLosses: number;
  acquisitionBudgetSpent?: number;
}

function extractTeams(payload: unknown): TeamInfo[] {
  if (!payload || typeof payload !== "object") return [];
  const maybeTeams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(maybeTeams)) return [];
  const teams: TeamInfo[] = [];
  for (const team of maybeTeams) {
    if (!team || typeof team !== "object") continue;
    const t = team as TeamLike;
    const id = Number(t.id);
    if (!Number.isFinite(id)) continue;
    const record =
      t.record && typeof t.record === "object" ? (t.record as { overall?: unknown; home?: unknown; away?: unknown }) : {};
    const overall = record && typeof record === "object" ? (record as { overall?: unknown }).overall : undefined;
    const home = record && typeof record === "object" ? (record as { home?: unknown }).home : undefined;
    const away = record && typeof record === "object" ? (record as { away?: unknown }).away : undefined;
    const tc =
      t.transactionCounter && typeof t.transactionCounter === "object"
        ? (t.transactionCounter as {
            acquisitionBudgetSpent?: unknown;
            acquisitions?: unknown;
            drops?: unknown;
            moveToActive?: unknown;
            moveToIR?: unknown;
            trades?: unknown;
          })
        : undefined;
    const tradeBlock =
      t.tradeBlock && typeof t.tradeBlock === "object"
        ? (t.tradeBlock as { players?: unknown[] })
        : undefined;
    const players = Array.isArray(tradeBlock?.players) ? tradeBlock?.players : [];
    const onBlock = players.filter(
      (p) => p && typeof p === "object" && (p as { status?: unknown }).status === "ON_THE_BLOCK"
    ).length;
    const untouchable = players.filter(
      (p) => p && typeof p === "object" && (p as { status?: unknown }).status === "UNTOUCHABLE"
    ).length;

    teams.push({
      id,
      wins: Number((overall as { wins?: unknown })?.wins) || 0,
      losses: Number((overall as { losses?: unknown })?.losses) || 0,
      ties: Number((overall as { ties?: unknown })?.ties) || 0,
      pointsFor: Number((overall as { pointsFor?: unknown })?.pointsFor) || 0,
      pointsAgainst: Number((overall as { pointsAgainst?: unknown })?.pointsAgainst) || 0,
      streakType:
        typeof (overall as { streakType?: unknown })?.streakType === "string"
          ? ((overall as { streakType?: unknown }).streakType as string)
          : undefined,
      streakLength: Number((overall as { streakLength?: unknown })?.streakLength) || 0,
      acquisitions: Number(tc?.acquisitions) || 0,
      moves: Number(tc?.moveToActive) || 0,
      movesToIr: Number(tc?.moveToIR) || 0,
      totalMoves:
        (Number(tc?.acquisitions) || 0) +
        (Number(tc?.drops) || 0) +
        (Number(tc?.moveToActive) || 0) +
        (Number(tc?.moveToIR) || 0) +
        (Number(tc?.trades) || 0),
      tradeBlockOn: onBlock,
      tradeBlockUntouchable: untouchable,
      projectedRank: Number(t.draftDayProjectedRank),
      finishRank:
        Number(t.rankFinal) ||
        Number(t.rankCalculatedFinal) ||
        Number(t.playoffSeed) ||
        undefined,
      homeWins: Number((home as { wins?: unknown })?.wins) || 0,
      homeLosses: Number((home as { losses?: unknown })?.losses) || 0,
      awayWins: Number((away as { wins?: unknown })?.wins) || 0,
      awayLosses: Number((away as { losses?: unknown })?.losses) || 0,
      acquisitionBudgetSpent:
        typeof tc?.acquisitionBudgetSpent === "number" ? tc.acquisitionBudgetSpent : undefined
    });
  }
  return teams;
}

function rankBy(
  teams: TeamInfo[],
  getter: (t: TeamInfo) => number | undefined,
  direction: "asc" | "desc"
): Map<number, number> {
  const scored = teams.map((t) => ({ id: t.id, value: getter(t) ?? 0 }));
  scored.sort((a, b) => (direction === "asc" ? a.value - b.value : b.value - a.value));
  const ranks = new Map<number, number>();
  scored.forEach((entry, idx) => ranks.set(entry.id, idx + 1));
  return ranks;
}

function maxBy<T>(items: T[], getter: (t: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const item of items) {
    const score = getter(item);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

function ratio(value: number, baseline: number): number {
  if (!Number.isFinite(baseline) || baseline === 0) {
    return Number.isFinite(value) ? value : 0;
  }
  return value / baseline;
}

function winPct(wins: number, losses: number): number {
  const total = wins + losses;
  if (total === 0) return 0;
  return wins / total;
}

function parseSeasonList(text: string): number[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(",").map((p) => p.trim());
  const seasons: number[] = [];
  for (const part of parts) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map((p) => Number.parseInt(p.trim(), 10));
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

async function handleError(
  interaction: ChatInputCommandInteraction,
  error: unknown,
  label: string
): Promise<void> {
  console.error(`Failed to compute ${label}`, error);
  const message = error instanceof Error ? error.message : String(error);
  await interaction.editReply({
    content: `Failed to compute ${label}: ${message}`,
    flags: MessageFlags.Ephemeral
  });
}
