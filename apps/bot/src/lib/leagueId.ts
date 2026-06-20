import { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { BotContext } from '../config.js';

/**
 * Resolve the ESPN league id for a command invocation, in priority order:
 *   1. the explicit `leagueid` option (per-command override),
 *   2. the league configured for this guild,
 *   3. the `ESPN_LEAGUE_ID` env default.
 * Returns `undefined` when none is available — callers reply with guidance.
 *
 * Accepts autocomplete interactions too (the scout autocomplete resolves the
 * league before suggesting opponents).
 */
export async function resolveLeagueId(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction,
  context: BotContext,
): Promise<string | undefined> {
  const leagueOverride = interaction.options.getString('leagueid') ?? undefined;
  if (leagueOverride) return leagueOverride;
  const guildId = interaction.guildId;
  const guildConfig = guildId ? await context.leagueConfigRepo.getByGuildId(guildId) : undefined;
  return guildConfig?.leagueId ?? context.env.defaultLeagueId;
}
