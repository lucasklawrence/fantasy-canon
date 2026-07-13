import { createBotContext } from './src/config.js';
import { isThrowbackPostType, renderThrowback } from './src/lib/throwbackRender.js';
import { postBroadcast } from './src/lib/postBroadcast.js';

/**
 * One-shot throwback poster: render an "on this week in history" card and post it to a Discord
 * channel, then exit. Invoked by the scheduled `weekly_throwback` Airflow DAG (see ADR 0002) —
 * and runnable by hand. The DAG selects the post type + row; this recomputes and renders it.
 * Inputs come from flags or env so a DAG can pass them as env vars:
 *
 *   tsx throwback.ts --channel <id> --post-type rivalry|waiver_legend|luck|churn \
 *     --ref <string> --season 2024 [--league <id>]
 *   THROWBACK_CHANNEL_ID / THROWBACK_POST_TYPE / THROWBACK_REF / THROWBACK_SEASON /
 *   THROWBACK_LEAGUE_ID
 *
 * `--ref` formats (set by the DAG): rivalry "teamA:teamB", waiver_legend "week:teamId",
 * luck "teamId", churn "teamId". Posts via REST (no gateway). Requires DISCORD_TOKEN.
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

  const channelId = flag('channel') ?? process.env.THROWBACK_CHANNEL_ID;
  const postType = flag('post-type') ?? process.env.THROWBACK_POST_TYPE;
  const ref = flag('ref') ?? process.env.THROWBACK_REF;
  const seasonRaw = flag('season') ?? process.env.THROWBACK_SEASON;
  const leagueId = flag('league') ?? process.env.THROWBACK_LEAGUE_ID ?? context.env.defaultLeagueId;

  if (!channelId) fail('A channel id is required (--channel or THROWBACK_CHANNEL_ID).');
  if (!postType || !isThrowbackPostType(postType)) {
    fail(
      `--post-type must be one of: rivalry, waiver_legend, luck, churn (got "${postType ?? ''}").`,
    );
  }
  if (!ref) fail('A --ref is required (or THROWBACK_REF).');
  const season = Number(seasonRaw);
  if (!Number.isFinite(season)) fail('A numeric --season (or THROWBACK_SEASON) is required.');
  if (!leagueId)
    fail('A league id is required (--league, THROWBACK_LEAGUE_ID, or ESPN_LEAGUE_ID).');

  console.log(
    `Throwback ${postType} (ref ${ref}) for league ${leagueId} season ${season} → channel ${channelId}`,
  );

  const rendered = await renderThrowback(context, leagueId, season, postType, ref);
  if (!rendered) fail(`No data available to render throwback "${postType}" (ref ${ref}).`);

  await postBroadcast(context.env.discordToken, channelId, season, rendered);

  console.log(
    `Posted ${rendered.label} (${rendered.buffer.length} bytes) to channel ${channelId}.`,
  );
}

main().catch((error) => {
  console.error('Throwback failed');
  console.error(error);
  process.exit(1);
});
