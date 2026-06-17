import { REST, Routes } from 'discord.js';
import { createBotContext } from './src/config.js';
import { isBroadcastMetric, renderBroadcast } from './src/lib/broadcastRender.js';

/**
 * One-shot broadcaster: render a weekly card and post it to a Discord channel, then exit.
 * Invoked by the scheduled Airflow DAGs (see ADR 0002) — and runnable by hand. Inputs come
 * from flags or env so a DAG can pass them as env vars:
 *
 *   tsx broadcast.ts --channel <id> --metric power-ranking|standings --season 2024 [--league <id>]
 *   BROADCAST_CHANNEL_ID / BROADCAST_METRIC / BROADCAST_SEASON / BROADCAST_LEAGUE_ID
 *
 * Posts via the REST API (no gateway connection needed for a fire-and-exit job). Requires
 * DISCORD_TOKEN (and DISCORD_APP_ID, via config) plus a channel the bot can post to.
 */

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const context = createBotContext();

  const channelId = flag('channel') ?? process.env.BROADCAST_CHANNEL_ID;
  const metric = flag('metric') ?? process.env.BROADCAST_METRIC;
  const seasonRaw = flag('season') ?? process.env.BROADCAST_SEASON;
  const leagueId = flag('league') ?? process.env.BROADCAST_LEAGUE_ID ?? context.env.defaultLeagueId;

  if (!channelId) fail('A channel id is required (--channel or BROADCAST_CHANNEL_ID).');
  if (!metric || !isBroadcastMetric(metric)) {
    fail(`--metric must be one of: power-ranking, standings (got "${metric ?? ''}").`);
  }
  const season = Number(seasonRaw);
  if (!Number.isFinite(season)) fail('A numeric --season (or BROADCAST_SEASON) is required.');
  if (!leagueId)
    fail('A league id is required (--league, BROADCAST_LEAGUE_ID, or ESPN_LEAGUE_ID).');

  console.log(
    `Broadcasting ${metric} for league ${leagueId} season ${season} → channel ${channelId}`,
  );

  const rendered = await renderBroadcast(context, leagueId, season, metric);
  if (!rendered) fail(`No data available to render "${metric}" for season ${season}.`);

  const rest = new REST({ version: '10' }).setToken(context.env.discordToken);
  await rest.post(Routes.channelMessages(channelId), {
    body: { content: `${rendered.label} • Season ${season}` },
    files: [{ name: rendered.filename, data: rendered.buffer }],
  });

  console.log(
    `Posted ${rendered.label} (${rendered.buffer.length} bytes) to channel ${channelId}.`,
  );
}

main().catch((error) => {
  console.error('Broadcast failed');
  console.error(error);
  process.exit(1);
});
