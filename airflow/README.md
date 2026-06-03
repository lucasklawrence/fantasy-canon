# Airflow — Fantasy Research Pipeline

Orchestrates the `/fantasy-research` Claude Code skill on a weekly schedule, the
way a real data pipeline would. The DAG calls the `claude` CLI headlessly; the
skill runs the deep-research workflow and archives a cited report to `research/`.

## DAG
`dags/fantasy_research_dag.py` — `fantasy_research_weekly`
- **Schedule:** Tuesdays 09:00 UTC (`0 9 * * 2`) — tune for the season.
- **Tasks:** `run_fantasy_research` → `commit_report`.

## Worker prerequisites
1. **Claude CLI** installed and authenticated as a user with web-search access.
2. **Repo checkout** on the worker; set `FANTASY_CANON_DIR` to its path
   (default `/opt/fantasy-canon`).
3. **Network egress** for web search/fetch.

## Run it now (without Airflow) to test the headless path
```bash
cd /path/to/fantasy-canon
claude -p "/fantasy-research draft strategy" --permission-mode acceptEdits --output-format text
```
Then check `research/` for a new dated report and an updated `INDEX.md`.

## Trigger an ad-hoc topic
```bash
airflow dags trigger fantasy_research_weekly --conf '{"topic": "week 3 waiver wire"}'
```

## Permissions note
- `--permission-mode acceptEdits` lets the agent write the archive file
  unattended. Web search/fetch run under the same non-interactive grant.
- Only use `--dangerously-skip-permissions` inside a fully isolated/CI sandbox.

## Growing this into "real work"
- Add a `pull_latest` task (git pull) before the research task.
- Add a `notify` task (Slack/email) that posts the takeaway + archive link.
- Parameterize multiple weekly topics (waivers, start/sit, injuries) as a
  dynamic task mapping over a list.
- Fan the schedule up to multiple days/week during the season via separate
  DAGs or a `schedule` change.
