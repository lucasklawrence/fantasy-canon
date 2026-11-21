"""What changed since the last look, phrased for a Discord post.

`news_changes` compares two briefings of the same week. `lineup_alerts` turns fantasy lineup
issues into alerts. Every alert has a `key` so the same news is posted only once.
"""

import json
import os
import urllib.request
from pathlib import Path

from .briefing import favorite

LINE_MOVE = 0.04  # no-vig probability move between looks that's worth a ping
WORSE = {"Questionable": 1, "Doubtful": 2, "Out": 3, "Injured Reserve": 3, "Suspension": 3}


def _starters(team: dict) -> dict:
    return {i["name"]: i for i in team["injuries"] if i["starter"]}


def news_changes(prev: dict | None, cur: dict) -> list[dict]:
    if not prev or prev.get("week") != cur["week"]:
        return []
    before = {g["id"]: g for g in prev["games"]}
    out = []
    for g in cur["games"]:
        p = before.get(g["id"])
        if p is None or g["status"] != "pre":
            continue
        label = f"{g['away']['abbr']} @ {g['home']['abbr']}"
        fav = favorite(g["market"])
        for side in ("away", "home"):
            old = _starters(p[side])
            for name, i in _starters(g[side]).items():
                was = old.get(name, {}).get("status")
                if WORSE.get(i["status"], 0) > WORSE.get(was, 0):
                    against = side == fav
                    out.append(
                        {
                            "key": f"{cur['week']}:{g['id']}:{name}:{i['status']}",
                            "game": label,
                            "sev": "high"
                            if i["unit"] in ("QB", "OL") or i["status"] != "Questionable"
                            else "med",
                            "text": f"{g[side]['abbr']} {i['pos']} {name}: {was or 'not listed'} → **{i['status']}**"
                            + (" (hurts the favorite)" if against else ""),
                        }
                    )
        if g["market"] is not None and p["market"] is not None:
            move = g["market"] - p["market"]
            flipped = favorite(p["market"]) != fav
            if abs(move) >= LINE_MOVE or flipped:
                toward = "home" if move > 0 else "away"
                pct = round(max(g["market"], 1 - g["market"]) * 100)
                out.append(
                    {
                        "key": f"{cur['week']}:{g['id']}:line:{round(g['market'] * 50)}",
                        "game": label,
                        "sev": "high" if flipped else "med",
                        "text": (
                            f"**Favorite flipped** to {g[fav]['abbr']}"
                            if flipped
                            else f"Line moved {abs(move) * 100:.0f} pts toward {g[toward]['abbr']}"
                        )
                        + f", now {g[fav]['abbr']} {pct}%",
                    }
                )
    return out


def lineup_alerts(teams: list[dict]) -> list[dict]:
    out = []
    for t in teams:
        for i in t["issues"]:
            out.append(
                {
                    "key": f"lineup:{t['league_id']}:{t['week']}:{i['text']}",
                    "game": t["team"],
                    "sev": i["sev"],
                    "text": i["text"],
                }
            )
    return out


def format_post(title: str, alerts: list[dict]) -> str:
    by_game: dict[str, list[dict]] = {}
    for a in sorted(alerts, key=lambda a: a["sev"] != "high"):
        by_game.setdefault(a["game"], []).append(a)
    lines = [f"**{title}**"]
    for game, items in by_game.items():
        lines.append(f"__{game}__")
        lines += [f"{'🔴' if a['sev'] == 'high' else '🟡'} {a['text']}" for a in items]
    return "\n".join(lines)


def format_checkin(teams: list[dict]) -> str:
    lines = []
    for t in teams:
        lines.append(f"**{t['team']}** · {t['league']}")
        seed = f", seed {t['seed']} of {t['size']}" if t.get("seed") else ""
        spots = f" (top {t['playoff_spots']} make it)" if t.get("playoff_spots") else ""
        lines.append(f"{t['record']}{seed}{spots} · {t['pf']} PF (#{t['pf_rank']}) · {t['pa']} PA")
        if t.get("last"):
            r = t["last"]
            lines.append(f"Last week: {'W' if r['won'] else 'L'} {r['score']}–{r['opp_score']} vs {r['opp']}")
        if t.get("matchup"):
            m = t["matchup"]
            odds = f", ESPN gives you {m['win_prob']:.0f}%" if m.get("win_prob") is not None else ""
            lines.append(
                f"Week {t['week']}: vs {m['opp']} ({m['opp_record']}), projected {m['proj']}–{m['opp_proj']}{odds}"
            )
        if t.get("gaps"):
            lines.append("Where usage disagrees with ESPN:")
            lines += [f"↕️ {g['text']}" for g in t["gaps"][:4]]
        rec = t.get("projection_record")
        if rec:
            better = "usage" if rec["usage"] < rec["espn"] else "ESPN"
            lines.append(
                f"Projection record ({rec['n']} player-games): ESPN misses by {rec['espn']}, usage by {rec['usage']} ({better} ahead)"
            )
        if t.get("faab"):
            me = next((f for f in t["faab"] if f["me"]), None)
            top = ", ".join(f"{f['team']} ${f['left']}" for f in t["faab"][:3] if not f["me"])
            lines.append(f"FAAB: you ${me['left'] if me else '?'} · most left: {top}")
        lines += [f"{'🔴' if i['sev'] == 'high' else '🟡'} {i['text']}" for i in t["issues"]] or [
            "✅ Lineup looks set"
        ]
        lines.append("")
    return "\n".join(lines).strip()


# ---------- delivery + dedupe ----------


def chunks(text: str, limit: int = 1900) -> list[str]:
    """Split on line breaks so each Discord message stays under its 2000-character cap."""
    out, cur = [], ""
    for line in text.split("\n"):
        while len(line) > limit:
            out.append(line[:limit])
            line = line[limit:]
        if len(cur) + len(line) + 1 > limit:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n{line}" if cur else line
    if cur:
        out.append(cur)
    return out


def post_discord(text: str, env=os.environ) -> int:
    """Post through the bot (DISCORD_TOKEN) to PICKEM_DISCORD_CHANNEL. Returns messages sent."""
    token, channel = env.get("DISCORD_TOKEN"), env.get("PICKEM_DISCORD_CHANNEL")
    if not token or not channel:
        raise SystemExit("Set DISCORD_TOKEN and PICKEM_DISCORD_CHANNEL to post, or use --dry-run")
    sent = 0
    for part in chunks(text):
        req = urllib.request.Request(
            f"https://discord.com/api/v10/channels/{channel}/messages",
            data=json.dumps({"content": part, "allowed_mentions": {"parse": []}}).encode(),
            headers={
                "Authorization": f"Bot {token}",
                "Content-Type": "application/json",
                "User-Agent": "DiscordBot (https://github.com/lucasklawrence/fantasy-canon, 0.1)",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30):
            sent += 1
    return sent


def load_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"sent": [], "last": None}


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state["sent"] = state["sent"][-2000:]
    path.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")


def unsent(alerts: list[dict], state: dict) -> list[dict]:
    seen = set(state["sent"])
    fresh = []
    for a in alerts:
        if a["key"] not in seen:
            seen.add(a["key"])
            fresh.append(a)
    return fresh
