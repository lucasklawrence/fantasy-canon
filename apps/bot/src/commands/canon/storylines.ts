import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { computeExpectedWins, computeLuckIndex } from '@fantasy-canon/core';
import { BotContext } from '../../config.js';
import { buildTeamNameMap } from '../../lib/teamNames.js';
import { getLeagueInfo } from '../../lib/leagueInfo.js';
import { extractTeams, TeamInfo } from '../../lib/teamStats.js';
import { ensureSnapshot } from '../../lib/snapshots.js';
import { classifyArchetype } from '../../lib/archetype.js';
import { resolveLeagueId } from '../../lib/leagueId.js';
import { extractWeeklyScores } from '../../lib/weeklyScores.js';

export async function handleLuckSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);
    if (teams.length === 0) {
      await interaction.editReply({ content: 'No teams found.' });
      return;
    }

    const mScoreboard = await ensureSnapshot(context, leagueId, season, 'mScoreboard');
    const scores = extractWeeklyScores(mScoreboard);
    if (scores.length === 0) {
      await interaction.editReply({
        content: 'No weekly scores found for this season (mScoreboard returned no matchups).',
      });
      return;
    }

    // Expected wins = average head-to-head wins across many randomized schedules
    // (Monte Carlo). Luck = actual record wins − expected wins: a big positive
    // gap means the schedule handed you wins; negative means it cost you.
    const expected = new Map(computeExpectedWins(scores).map((r) => [r.teamId, r.expectedWins]));
    const entries = teams.map((t) => {
      const expectedWins = expected.get(t.id) ?? 0;
      return { ...t, expectedWins, luckIndex: computeLuckIndex({ wins: t.wins, expectedWins }) };
    });

    const luckiest = [...entries].sort((a, b) => b.luckIndex - a.luckIndex).slice(0, 3);
    const unluckiest = [...entries].sort((a, b) => a.luckIndex - b.luckIndex).slice(0, 3);

    const fmt = (e: (typeof entries)[number], idx: number) => {
      const sign = e.luckIndex >= 0 ? '+' : '';
      return `${idx + 1}. ${nameMap.get(e.id) ?? `Team ${e.id}`} — luck ${sign}${e.luckIndex.toFixed(
        1,
      )} (${e.wins} wins vs ${e.expectedWins.toFixed(1)} expected)`;
    };

    const lines = ['Luckiest:', ...luckiest.map(fmt), 'Unluckiest:', ...unluckiest.map(fmt)];

    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • Luck`, ...lines].join('\n'),
    });
  } catch (error) {
    await handleError(interaction, error, 'luck');
  }
}

export async function handleDraftProphecySubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);
    if (teams.length === 0) {
      await interaction.editReply({ content: 'No teams found.' });
      return;
    }

    const finishRank = rankBy(teams, (t) => t.finishRank ?? t.wins, 'asc');

    const deltas = teams
      .map((t) => {
        const projected = typeof t.projectedRank === 'number' ? t.projectedRank : undefined;
        if (projected === undefined) return undefined;
        const finalRank = finishRank.get(t.id) ?? teams.length;
        const delta = projected - finalRank; // positive means over-performed vs draft expectations
        return { ...t, projected, finalRank, delta };
      })
      .filter(Boolean) as Array<{
      id: number;
      projected: number;
      finalRank: number;
      delta: number;
    }>;

    if (deltas.length === 0) {
      await interaction.editReply({
        content: 'Draft projection data not available.',
      });
      return;
    }

    const steals = [...deltas].sort((a, b) => b.delta - a.delta).slice(0, 3);
    const busts = [...deltas].sort((a, b) => a.delta - b.delta).slice(0, 3);

    const lines: string[] = [];
    lines.push('Steals (beat the prophecy):');
    lines.push(
      ...steals.map(
        (e, idx) =>
          `${idx + 1}. ${nameMap.get(e.id) ?? `Team ${e.id}`} — Δ${e.delta.toFixed(
            1,
          )} (proj ${e.projected}, finish ${e.finalRank})`,
      ),
    );
    lines.push('Busts (fell short):');
    lines.push(
      ...busts.map(
        (e, idx) =>
          `${idx + 1}. ${nameMap.get(e.id) ?? `Team ${e.id}`} — Δ${e.delta.toFixed(
            1,
          )} (proj ${e.projected}, finish ${e.finalRank})`,
      ),
    );

    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • Draft Prophecy`, ...lines].join('\n'),
    });
  } catch (error) {
    await handleError(interaction, error, 'draft-prophecy');
  }
}

export async function handleStreaksSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);

    const longestWin = maxBy(teams, (t) => (t.streakType === 'WIN' ? t.streakLength : 0));
    const longestLoss = maxBy(teams, (t) => (t.streakType === 'LOSS' ? t.streakLength : 0));
    const current = [...teams]
      .filter((t) => t.streakLength > 0)
      .sort((a, b) => b.streakLength - a.streakLength)
      .slice(0, 3);

    const lines: string[] = [];
    if (longestWin) {
      lines.push(
        `Longest win streak: ${nameMap.get(longestWin.id) ?? `Team ${longestWin.id}`} — ${
          longestWin.streakLength
        }`,
      );
    }
    if (longestLoss) {
      lines.push(
        `Longest losing streak: ${nameMap.get(longestLoss.id) ?? `Team ${longestLoss.id}`} — ${
          longestLoss.streakLength
        }`,
      );
    }
    lines.push('Current streak leaders:');
    lines.push(
      ...current.map(
        (t, idx) =>
          `${idx + 1}. ${nameMap.get(t.id) ?? `Team ${t.id}`} — ${t.streakType ?? 'UNK'} ${
            t.streakLength
          }`,
      ),
    );

    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • Streaks`, ...lines].join('\n'),
    });
  } catch (error) {
    await handleError(interaction, error, 'streaks');
  }
}

export async function handleManagerArchetypesSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);

    const lines = teams.map((t) => {
      const { label, detail } = classifyArchetype(t, teams);
      return `${nameMap.get(t.id) ?? `Team ${t.id}`} — ${label} (${detail})`;
    });

    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • Manager archetypes`, ...lines].join(
        '\n',
      ),
    });
  } catch (error) {
    await handleError(interaction, error, 'manager-archetypes');
  }
}

export async function handleTradeBlockSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
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
    lines.push('Most on the block:');
    lines.push(
      ...mostOnBlock.map(
        (e, idx) =>
          `${idx + 1}. ${nameMap.get(e.id) ?? `Team ${e.id}`} — ${e.onBlock} listed on the block`,
      ),
    );
    lines.push('Most untouchables:');
    lines.push(
      ...mostUntouchable.map(
        (e, idx) =>
          `${idx + 1}. ${nameMap.get(e.id) ?? `Team ${e.id}`} — ${e.untouchable} untouchable`,
      ),
    );

    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • Trade block`, ...lines].join('\n'),
    });
  } catch (error) {
    await handleError(interaction, error, 'tradeblock');
  }
}

export async function handleHomeAwaySubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const leagueInfo = await getLeagueInfo(context, leagueId, season);
    const leagueLabel = leagueInfo.name ?? leagueId;
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
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
        `Home merchant: ${nameMap.get(homeMerchant.id) ?? `Team ${homeMerchant.id}`} — home ${(
          homeMerchant.homeWinPct * 100
        ).toFixed(1)}%, away ${(homeMerchant.awayWinPct * 100).toFixed(1)}%`,
      );
    }
    if (roadWarrior) {
      lines.push(
        `Road warrior: ${nameMap.get(roadWarrior.id) ?? `Team ${roadWarrior.id}`} — home ${(
          roadWarrior.homeWinPct * 100
        ).toFixed(1)}%, away ${(roadWarrior.awayWinPct * 100).toFixed(1)}%`,
      );
    }

    await interaction.editReply({
      content: [`League ${leagueLabel} • Season ${season} • Home/Away`, ...lines].join('\n'),
    });
  } catch (error) {
    await handleError(interaction, error, 'homeaway');
  }
}

export async function handleChampSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const season = interaction.options.getInteger('season', true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
    const nameMap = buildTeamNameMap(mTeamPayload);
    const teams = extractTeams(mTeamPayload);
    if (teams.length === 0) {
      await interaction.editReply({ content: 'No teams found.' });
      return;
    }

    const finishRank = rankBy(teams, (t) => t.finishRank ?? t.wins, 'asc');
    const champ = teams.find((t) => finishRank.get(t.id) === 1) ?? teams[0];
    const champName = nameMap.get(champ.id) ?? `Team ${champ.id}`;
    const draft = champ.projectedRank ? `draft proj ${champ.projectedRank}` : 'draft proj n/a';
    const points = champ.pointsFor !== undefined ? `points ${champ.pointsFor.toFixed(1)}` : '';
    const record = `${champ.wins}-${champ.losses}${champ.ties ? `-${champ.ties}` : ''}`;
    const faab =
      champ.acquisitionBudgetSpent !== undefined
        ? `FAAB spent $${champ.acquisitionBudgetSpent.toFixed(0)}`
        : '';

    const lines = [
      `${champName} is the champion of ${season}.`,
      `Record ${record}${points ? `, ${points}` : ''}.`,
      `${draft}${faab ? `, ${faab}` : ''}.`,
    ];

    await context.canonEventsRepo.add({
      leagueId,
      season,
      type: 'champion',
      message: `${champName} won ${season} (${record})`,
    });

    await interaction.editReply({
      content: lines.join('\n'),
    });
  } catch (error) {
    await handleError(interaction, error, 'champ');
  }
}

export async function handleChampsSubcommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const seasonsText = interaction.options.getString('seasons', true);
  const leagueId = await resolveLeagueId(interaction, context);
  if (!leagueId) {
    await missingLeagueReply(interaction);
    return;
  }

  const seasons = parseSeasonList(seasonsText);
  if (seasons.length === 0) {
    await interaction.reply({
      content: 'Provide seasons as comma list or range (e.g., 2022-2025 or 2024,2025).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const results: string[] = [];
  for (const season of seasons) {
    try {
      const mTeamPayload = await ensureSnapshot(context, leagueId, season, 'mTeam');
      const nameMap = buildTeamNameMap(mTeamPayload);
      const teams = extractTeams(mTeamPayload);
      if (teams.length === 0) {
        results.push(`${season}: no teams found`);
        continue;
      }
      const finishRank = rankBy(teams, (t) => t.finishRank ?? t.wins, 'asc');
      const champ = teams.find((t) => finishRank.get(t.id) === 1) ?? teams[0];
      const champName = nameMap.get(champ.id) ?? `Team ${champ.id}`;
      const record = `${champ.wins}-${champ.losses}${champ.ties ? `-${champ.ties}` : ''}`;
      results.push(`${season}: ${champName} (${record})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(`${season}: error ${message}`);
    }
  }

  await interaction.editReply({
    content: [`League ${leagueId} • Champs`, ...results].join('\n'),
  });
}

// Helpers

async function missingLeagueReply(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: 'League ID is required. Set it via /canon config set or ESPN_LEAGUE_ID.',
    flags: MessageFlags.Ephemeral,
  });
}

function rankBy(
  teams: TeamInfo[],
  getter: (t: TeamInfo) => number | undefined,
  direction: 'asc' | 'desc',
): Map<number, number> {
  const scored = teams.map((t) => ({ id: t.id, value: getter(t) ?? 0 }));
  scored.sort((a, b) => (direction === 'asc' ? a.value - b.value : b.value - a.value));
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

function winPct(wins: number, losses: number): number {
  const total = wins + losses;
  if (total === 0) return 0;
  return wins / total;
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

async function handleError(
  interaction: ChatInputCommandInteraction,
  error: unknown,
  label: string,
): Promise<void> {
  console.error(`Failed to compute ${label}`, error);
  const message = error instanceof Error ? error.message : String(error);
  await interaction.editReply({
    content: `Failed to compute ${label}: ${message}`,
  });
}
