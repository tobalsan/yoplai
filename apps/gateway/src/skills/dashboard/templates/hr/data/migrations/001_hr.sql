PRAGMA foreign_keys = ON;
CREATE TABLE employees (email TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL, manager_email TEXT, updated_at TEXT NOT NULL);
CREATE TABLE pto (id TEXT PRIMARY KEY, employee_email TEXT NOT NULL REFERENCES employees(email), start_date TEXT NOT NULL, end_date TEXT NOT NULL, days REAL NOT NULL, status TEXT NOT NULL, type TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE candidates (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, stage TEXT NOT NULL, source TEXT NOT NULL, owner_email TEXT NOT NULL, score INTEGER, next_step TEXT, updated_at TEXT NOT NULL);
CREATE INDEX pto_employee_idx ON pto(employee_email);
CREATE INDEX candidates_stage_idx ON candidates(stage);
