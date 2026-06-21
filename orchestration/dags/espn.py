"""ESPN fantasy-football read API client (Python side of the ingest pipeline).

Mirrors ``packages/espn-client`` (TS): same unofficial read host, headers, optional
``scoringPeriodId``, and private-league cookies. The URL builder is pure (no network) so
it unit-tests in isolation; ``requests`` is imported lazily inside ``fetch_view`` to keep
the module import-light.
"""

from __future__ import annotations

from typing import Any, Optional

BASE_URL = "https://lm-api-reads.fantasy.espn.com"

_HEADERS = {
    "User-Agent": "fantasy-canon/0.1",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Fantasy-Platform": "kona-PROD",
    "X-Fantasy-Source": "kona",
}


def build_view_url(
    league_id: str,
    season: int,
    view: str,
    scoring_period: Optional[int] = None,
    base_url: str = BASE_URL,
) -> str:
    """Build the read-API URL for one view (optionally scoped to a scoring period)."""
    url = f"{base_url}/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league_id}?view={view}"
    if scoring_period is not None:
        url += f"&scoringPeriodId={scoring_period}"
    return url


def _cookies(espn_s2: Optional[str], swid: Optional[str]) -> Optional[dict]:
    jar = {}
    if espn_s2:
        jar["espn_s2"] = espn_s2
    if swid:
        jar["SWID"] = swid
    return jar or None


def fetch_view(
    league_id: str,
    season: int,
    view: str,
    *,
    scoring_period: Optional[int] = None,
    espn_s2: Optional[str] = None,
    swid: Optional[str] = None,
    timeout: int = 30,
    base_url: str = BASE_URL,
) -> Any:
    """Fetch one ESPN view as parsed JSON. Raises for non-2xx. Cookies only for private leagues."""
    import requests  # lazy: keeps build_view_url testable without the dependency

    url = build_view_url(league_id, season, view, scoring_period, base_url)
    resp = requests.get(url, headers=_HEADERS, cookies=_cookies(espn_s2, swid), timeout=timeout)
    resp.raise_for_status()
    return resp.json()
