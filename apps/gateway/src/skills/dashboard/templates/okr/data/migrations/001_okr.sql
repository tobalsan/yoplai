PRAGMA foreign_keys = ON;
CREATE TABLE employees (email TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL, manager_email TEXT, slack_user_id TEXT, updated_at TEXT NOT NULL);
CREATE TABLE okr_items (id TEXT PRIMARY KEY, owner_email TEXT NOT NULL REFERENCES employees(email), period TEXT NOT NULL, objective TEXT, title TEXT NOT NULL, weight REAL NOT NULL CHECK(weight > 0), completion REAL NOT NULL CHECK(completion BETWEEN 0 AND 100), status TEXT NOT NULL CHECK(status IN ('on_track','at_risk','off_track','done')), updated_at TEXT NOT NULL);
CREATE TABLE okr_snapshots (period TEXT NOT NULL, week TEXT NOT NULL, owner_email TEXT NOT NULL REFERENCES employees(email), contribution REAL NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(period, week, owner_email));
CREATE INDEX okr_items_owner_idx ON okr_items(owner_email);
CREATE INDEX okr_items_period_idx ON okr_items(period);
CREATE INDEX okr_snapshots_owner_idx ON okr_snapshots(owner_email);
CREATE INDEX okr_snapshots_period_idx ON okr_snapshots(period);

-- Per-person weighted contribution for a period: sum(weight*completion)/sum(weight).
CREATE VIEW okr_person_progress AS
SELECT
  i.period AS period,
  i.owner_email AS owner_email,
  e.name AS name,
  e.team AS team,
  e.manager_email AS manager_email,
  ROUND(SUM(i.weight * i.completion) / SUM(i.weight), 1) AS contribution,
  COUNT(*) AS items
FROM okr_items i
JOIN employees e ON e.email = i.owner_email
GROUP BY i.period, i.owner_email;

-- Team KPI: average of member contributions for a period.
CREATE VIEW okr_team_progress AS
SELECT
  p.period AS period,
  p.team AS team,
  COUNT(DISTINCT p.owner_email) AS members,
  ROUND(AVG(p.contribution), 1) AS contribution
FROM okr_person_progress p
GROUP BY p.period, p.team;
