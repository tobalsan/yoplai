# OKR dashboards

Templates: `okr-teams` (public), `okr-me` (private), `okr-reports` (manager). Data lives in its own `data/okr.db`, built from `templates/okr/data/migrations/001_okr.sql` and `templates/okr/data/okr_sample.sql` (named `okr_sample.sql`, not `sample.sql`, so copying it never clobbers the HR family's `data/sample.sql` when both are seeded into the same workspace), following the same copy-then-`sqlite3`-load steps as any other family (see the main `SKILL.md` "Start from a template" section).

## Data model and formulas

- `employees(email, name, team, manager_email, slack_user_id, updated_at)` — a person can be both a manager and someone's report. Every `okr_items.owner_email` must have a matching `employees` row (queries match email case-insensitively with `lower(...)`, but the row itself must exist or that person's items won't join into `okr_person_progress`/`okr_team_progress` at all).
- `okr_items(id, owner_email, period, objective, title, weight, completion, status, updated_at)` — one row per weighted item in a period (e.g. `2026-Q4`). `weight` is not required to sum to 100; the formula normalizes.
- `okr_snapshots(period, week, owner_email, contribution, updated_at)` — one row per person per weekly check-in Monday, for trend lines.
- **Person contribution** = `Σ(weight × completion) / Σ(weight)`, rounded to 1 decimal — see the `okr_person_progress` view.
- **Team KPI** = average of that team's member contributions, rounded to 1 decimal — see the `okr_team_progress` view.

## Visibility rule

- **Public page (`okr-teams`)**: team-level `%` only. Never select `okr_items.title`, `objective`, or any per-person row — only aggregates from `okr_team_progress` (and a per-team average of `okr_snapshots` for trend). The company average is headcount-weighted: average every qualifying team's members' contributions directly (`AVG` over `okr_person_progress`), never the average of team averages, so a large team isn't diluted to the same weight as a small one.
- **Minimum team size**: a team with fewer than 3 members with logged items would let its "average" reveal one or two individuals' scores. `okr-teams.html` filters `members >= 3` on every query (the team bar chart, the company average, and the trend line) — a smaller team simply doesn't appear publicly until it has 3+ contributors for that period. Keep sample/seed teams at 3 or more members if they should show up on the public page.
- **Private page (`okr-me`)**: a person's own weighted items, always scoped to `:viewer_email`. It only shows someone else's items (`:owner`) when that owner's `manager_email` matches the viewer — enforced in SQL with an `EXISTS` guard, not in JavaScript, so a forged URL parameter can't leak another report's items to a non-manager.
- **Manager page (`okr-reports`)**: only rows where `manager_email` matches the viewer; links out to each report's `okr-me.html?owner=...` (a manager IS an allowed `:owner` viewer per the guard above). Uses a `LEFT JOIN` from `employees` to `okr_person_progress` so a report with zero items for the period still shows up (with a blank contribution and 0 items) instead of silently disappearing.
- **Empty `:period`**: an empty-string URL parameter is not the same as a missing one. Every period filter uses `COALESCE(NULLIF(:period, ''), (SELECT max(period) FROM okr_items))` so a drill-down link built with an empty `period` value still falls back to the latest period instead of matching nothing.

**Database isolation**: any dashboard shared beyond the agent's confidential audience gets its own database under `data/` — never co-locate it with confidential tables like PTO or candidates, because every query on a page can read its whole db file, not just the tables it names in one query.

## Chat-driven updates

Updates happen by chat: the agent edits `okr_items` rows and their `updated_at`. Confirm weights with the person before changing them — adding a new item changes every other item's denominator (`Σweight`) for that person and period, shifting their contribution even if nothing else changed.

To DM someone their private link, the agent needs their Slack user id. Look it up once with `slack.list_users` (by display name), confirm the match with the person before storing it, then set `employees.slack_user_id`. Skip the DM (don't guess an id) for anyone whose `slack_user_id` is still `NULL`.

## Weekly check-in recipe

Schedule a weekly job with `scheduler.create_job` (Monday morning, agent's timezone). Use its `deliver` option — not a `slack.send_message` call — for the team-wide post, because `deliver` runs at the runtime level after the job resolves and posting yourself via `slack.send_message` would duplicate it. Have the job's `message` instruct the agent to reply with only the team rollup and the `okr-teams.html` link (never item titles), since whatever the agent replies is exactly what `deliver` posts:

```json
{
  "name": "OKR weekly check-in",
  "cron": "0 8 * * 1",
  "tz": "America/Los_Angeles",
  "message": "Run the OKR weekly check-in: snapshot this week's contributions into okr_snapshots, then reply with ONLY the team % rollup from okr_team_progress and the okr-teams.html dashboard link — no item titles, no per-person detail.",
  "deliver": [{ "target": "slack", "channel": "C0123456789" }]
}
```

On that trigger, the agent:

1. **Snapshots this week's contributions** from the live view into `okr_snapshots`:

   ```sql
   INSERT OR REPLACE INTO okr_snapshots (period, week, owner_email, contribution, updated_at)
   SELECT period, '2026-10-26', owner_email, contribution, '2026-10-26T09:00:00Z'
   FROM okr_person_progress
   WHERE period = '2026-Q4';
   ```

2. **Replies with the team `%`** (never item titles) from `okr_team_progress` plus `okr-teams.html`'s `dashboard_link`; the job's `deliver: [{ "target": "slack", "channel": "..." }]` posts that reply to the channel automatically — the agent does not also call `slack.send_message` for this, which would duplicate the post:

   ```sql
   SELECT team, contribution FROM okr_team_progress WHERE period = '2026-Q4' AND members >= 3;
   ```

3. **DMs each person** a link to their own `okr-me.html`, one at a time, with `slack.send_message` (a content DM, not a cron result report — the runtime `deliver` step above already handled the result report) addressed to their `employees.slack_user_id`. Never post individual item titles in a public or team channel.
