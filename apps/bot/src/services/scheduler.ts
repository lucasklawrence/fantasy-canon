import { BotContext } from '../config.js';
import { BROADCAST_METRICS, renderBroadcast } from '../lib/broadcastRender.js';
import { postBroadcast } from '../lib/postBroadcast.js';

/**
 * In-process weekly scheduler for league broadcasts — the hobby-scale alternative to
 * hosting Airflow (see docs/decisions/0002-scheduling-airflow.md). Since the bot is
 * already an always-on process for slash commands, we just schedule the weekly post
 * here. Deliberately dependency-free (no node-cron): the next-run math is pure and
 * testable, and a self-rescheduling timer fires it.
 *
 * Opt-in via env: BROADCAST_CHANNEL_ID + BROADCAST_SEASON (+ league id). Without them,
 * scheduling stays off so dev/test runs don't post.
 */

// Tuesdays 16:00 UTC — the research cadence puts power rankings on Tuesday.
const BROADCAST_DAY_UTC = 2;
const BROADCAST_HOUR_UTC = 16;

/**
 * Milliseconds from `now` until the next weekly occurrence of the given UTC day-of-week
 * (0=Sun) and hour/minute. Always strictly in the future. Pure — no I/O.
 */
export function msUntilNextWeekly(now: Date, dayOfWeek: number, hour: number, minute = 0): number {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0),
  );
  const dayDiff = (dayOfWeek - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + dayDiff);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 7);
  }
  return next.getTime() - now.getTime();
}

/**
 * Start the weekly broadcast loop if configured. No-op (logs why) when the broadcast env
 * isn't set, so it's safe to call unconditionally at startup.
 */
export function startScheduledBroadcasts(context: BotContext): void {
  const channelId = process.env.BROADCAST_CHANNEL_ID;
  const season = Number(process.env.BROADCAST_SEASON);
  const leagueId = process.env.BROADCAST_LEAGUE_ID ?? context.env.defaultLeagueId;

  if (!channelId || !Number.isFinite(season) || !leagueId) {
    console.log(
      'Weekly broadcasts disabled — set BROADCAST_CHANNEL_ID, BROADCAST_SEASON, and a league id to enable.',
    );
    return;
  }

  const run = async (): Promise<void> => {
    for (const metric of BROADCAST_METRICS) {
      try {
        const rendered = await renderBroadcast(context, leagueId, season, metric);
        if (!rendered) {
          console.warn(`Weekly broadcast: no data to render ${metric} for season ${season}.`);
          continue;
        }
        await postBroadcast(context.env.discordToken, channelId, season, rendered);
        console.log(`Weekly broadcast posted ${metric} to channel ${channelId}.`);
      } catch (error) {
        console.error(`Weekly broadcast failed for ${metric}`, error);
      }
    }
  };

  const scheduleNext = (): void => {
    const ms = msUntilNextWeekly(new Date(), BROADCAST_DAY_UTC, BROADCAST_HOUR_UTC);
    console.log(`Next weekly broadcast in ~${Math.round(ms / 3_600_000)}h.`);
    setTimeout(() => {
      void run().finally(scheduleNext);
    }, ms);
  };

  scheduleNext();
}
