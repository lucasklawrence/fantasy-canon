"""Network fetches: ESPN's public site API and nflverse release CSVs. Everything else is pure."""

import csv
import io
import json
import urllib.error
import urllib.request

SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "fantasy-canon-pickem/0.1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def scoreboard(season: int, week: int | None = None) -> dict:
    url = (
        f"{SITE}/scoreboard" if week is None else f"{SITE}/scoreboard?week={week}&seasontype=2&dates={season}"
    )
    return json.loads(_get(url))


def summary(event_id: str) -> dict:
    return json.loads(_get(f"{SITE}/summary?event={event_id}"))


def nflverse_csv(name: str, season: int) -> list[dict]:
    """`snap_counts` or `injuries`. Returns [] if the season's file isn't published yet."""
    try:
        text = _get(f"{NFLVERSE}/{name}/{name}_{season}.csv")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise
    return list(csv.DictReader(io.StringIO(text)))


def player_stats(season: int) -> list[dict]:
    """nflverse weekly player stats (targets, carries, shares, PPR points). [] before the season starts."""
    try:
        text = _get(f"{NFLVERSE}/stats_player/stats_player_week_{season}.csv")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise
    return list(csv.DictReader(io.StringIO(text)))
