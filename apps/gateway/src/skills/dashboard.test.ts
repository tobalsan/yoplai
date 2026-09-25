import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "@yoplai/shared";
import {
  executeDashboardQueries,
  parseDashboardQueries,
} from "../canvas/sql.js";

const execFileAsync = promisify(execFile);
const templates = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "dashboard",
  "templates"
);

describe("dashboard starter templates", () => {
  let workspace: string | undefined;

  afterEach(async () => {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  it("runs every HR template query with representative bindings", async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-hr-"));
    await fs.mkdir(path.join(workspace, "data"));
    const db = new Database(path.join(workspace, "data", "hr.db"));
    db.exec(
      await fs.readFile(
        path.join(templates, "hr/data/migrations/001_hr.sql"),
        "utf8"
      )
    );
    db.exec(
      await fs.readFile(path.join(templates, "hr/data/sample.sql"), "utf8")
    );
    expectMutableTablesHaveUpdatedAt(db);
    db.close();

    await expectTemplatesToQuery("hr", {
      viewer_email: "henry@example.com",
      id: "cand-1",
    });
  });

  it("runs every OKR template query with representative bindings", async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-okr-"));
    await fs.mkdir(path.join(workspace, "data"));
    const db = new Database(path.join(workspace, "data", "okr.db"));
    db.exec(
      await fs.readFile(
        path.join(templates, "okr/data/migrations/001_okr.sql"),
        "utf8"
      )
    );
    db.exec(
      await fs.readFile(path.join(templates, "okr/data/okr_sample.sql"), "utf8")
    );
    expectMutableTablesHaveUpdatedAt(db);

    const reportWithItems = (
      db
        .prepare(
          `SELECT email FROM employees e WHERE lower(e.manager_email) = lower(?)
           AND EXISTS (SELECT 1 FROM okr_items i WHERE i.owner_email = e.email) LIMIT 1`
        )
        .get("henry@example.com") as { email: string } | undefined
    )?.email;
    expect(reportWithItems).toBeTruthy();
    const reportWithNoItems = (
      db
        .prepare(
          `SELECT email FROM employees e WHERE lower(e.manager_email) = lower(?)
           AND NOT EXISTS (SELECT 1 FROM okr_items i WHERE i.owner_email = e.email) LIMIT 1`
        )
        .get("henry@example.com") as { email: string } | undefined
    )?.email;
    expect(reportWithNoItems).toBeTruthy();

    // Hard-coded from the seeded sample (see okr_sample.sql): recompute these
    // by hand whenever the sample's weights/completions change.
    const globalOperations = db
      .prepare(
        "SELECT members, contribution FROM okr_team_progress WHERE period = ? AND team = ?"
      )
      .get("2026-Q4", "Global Operations") as
      | { members: number; contribution: number }
      | undefined;
    expect(globalOperations).toEqual({ members: 5, contribution: 61.5 });
    const growth = db
      .prepare(
        "SELECT members, contribution FROM okr_team_progress WHERE period = ? AND team = ?"
      )
      .get("2026-Q4", "Growth") as
      | { members: number; contribution: number }
      | undefined;
    expect(growth).toEqual({ members: 4, contribution: 61.9 });
    const companyAverage = db
      .prepare(
        `SELECT ROUND(AVG(p.contribution), 1) AS avg_contribution, COUNT(*) AS headcount
         FROM okr_person_progress p WHERE p.period = ?`
      )
      .get("2026-Q4") as { avg_contribution: number; headcount: number };
    expect(companyAverage).toEqual({ avg_contribution: 61.7, headcount: 9 });

    const reportName = (
      db
        .prepare("SELECT name FROM employees WHERE email = ?")
        .get(reportWithItems!) as { name: string } | undefined
    )?.name;
    db.close();

    await expectTemplatesToQuery("okr", {
      viewer_email: "henry@example.com",
      period: "2026-Q4",
      owner: reportWithItems!,
    });

    const teamsHtml = await fs.readFile(
      path.join(templates, "okr", "dashboards", "okr-teams.html"),
      "utf8"
    );
    for (const query of parseDashboardQueries(teamsHtml)) {
      expect(query.sql, query.name).not.toMatch(/\btitle\b/i);
    }
    const teamsResult = await executeDashboardQueries(
      { id: "template-test", name: "Template", workspace } as AgentConfig,
      teamsHtml,
      { viewer_email: "henry@example.com", period: "2026-Q4" }
    );
    const teamsRows = Object.values(teamsResult.data).flat() as Array<
      Record<string, unknown>
    >;
    expect(teamsRows.length).toBeGreaterThan(0);
    for (const row of teamsRows) {
      for (const value of Object.values(row)) {
        expect(String(value)).not.toMatch(/@example\.com/);
      }
    }

    const meHtml = await fs.readFile(
      path.join(templates, "okr", "dashboards", "okr-me.html"),
      "utf8"
    );
    // Not henry's report: guard denies :owner and falls back to henry's own items.
    const nonManagedResult = await executeDashboardQueries(
      { id: "template-test", name: "Template", workspace } as AgentConfig,
      meHtml,
      {
        viewer_email: "henry@example.com",
        period: "2026-Q4",
        owner: "grace@example.com",
      }
    );
    const nonManagedItems = nonManagedResult.data.items as Array<{
      objective: string;
    }>;
    expect(nonManagedItems.length).toBeGreaterThan(0);
    expect(
      nonManagedItems.every((row) =>
        ["Reliable vendor operations", "Develop the ops team"].includes(
          row.objective
        )
      )
    ).toBe(true);

    // A report trying to view their manager's items: guard denies and falls
    // back to the viewer's own items instead of leaking the manager's.
    const reportAsViewerResult = await executeDashboardQueries(
      { id: "template-test", name: "Template", workspace } as AgentConfig,
      meHtml,
      {
        viewer_email: reportWithItems!,
        period: "2026-Q4",
        owner: "henry@example.com",
      }
    );
    const reportAsViewerSummary = reportAsViewerResult.data.summary as Array<{
      name: string;
    }>;
    expect(reportAsViewerSummary[0]?.name).toBe(reportName);

    const managedResult = await executeDashboardQueries(
      { id: "template-test", name: "Template", workspace } as AgentConfig,
      meHtml,
      {
        viewer_email: "henry@example.com",
        period: "2026-Q4",
        owner: reportWithItems!,
      }
    );
    const managedSummary = managedResult.data.summary as Array<{
      name: string;
    }>;
    expect(managedSummary[0]?.name).toBe(reportName);

    const reportsHtml = await fs.readFile(
      path.join(templates, "okr", "dashboards", "okr-reports.html"),
      "utf8"
    );
    const reportsResult = await executeDashboardQueries(
      { id: "template-test", name: "Template", workspace } as AgentConfig,
      reportsHtml,
      { viewer_email: "henry@example.com", period: "2026-Q4" }
    );
    const reportsRows = reportsResult.data.reports as Array<{
      owner_email: string;
      items: number;
      period: string;
    }>;
    expect(reportsRows.length).toBeGreaterThan(0);
    // Every row (including the report with zero items) resolves a non-empty
    // period, so a drill-down link built from it never carries `period=`.
    for (const row of reportsRows) {
      expect(row.period).toBeTruthy();
    }
    const noItemsRow = reportsRows.find(
      (row) => row.owner_email === reportWithNoItems
    );
    expect(noItemsRow?.items).toBe(0);
  });

  it("falls back to the latest period and excludes small teams from the public OKR rollup", async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-okr2-"));
    await fs.mkdir(path.join(workspace, "data"));
    const dbPath = path.join(workspace, "data", "okr.db");
    const db = new Database(dbPath);
    db.exec(
      await fs.readFile(
        path.join(templates, "okr/data/migrations/001_okr.sql"),
        "utf8"
      )
    );
    db.exec(
      await fs.readFile(path.join(templates, "okr/data/okr_sample.sql"), "utf8")
    );
    // A 2-person team: too small to show on the public rollup without
    // revealing an individual's score.
    db.exec(`
      INSERT INTO employees VALUES
        ('tiny-a@example.com','Tiny A','Tiny Team',NULL,NULL,'2026-09-20T09:00:00Z'),
        ('tiny-b@example.com','Tiny B','Tiny Team',NULL,NULL,'2026-09-20T09:00:00Z');
      INSERT INTO okr_items VALUES
        ('okr-tiny-a-1','tiny-a@example.com','2026-Q4','Solo objective','Ship the thing',100,90,'on_track','2026-09-20T09:00:00Z'),
        ('okr-tiny-b-1','tiny-b@example.com','2026-Q4','Solo objective','Ship the other thing',100,50,'at_risk','2026-09-20T09:00:00Z');
    `);
    const tinyTeamMembers = db
      .prepare(
        "SELECT members FROM okr_team_progress WHERE period = ? AND team = ?"
      )
      .get("2026-Q4", "Tiny Team") as { members: number } | undefined;
    expect(tinyTeamMembers?.members).toBe(2);
    db.close();

    // No `period` binding at all: every page must still resolve to the
    // latest period and return rows.
    const reportWithItems = "amina@example.com";
    await expectTemplatesToQuery("okr", {
      viewer_email: "henry@example.com",
      owner: reportWithItems,
    });

    const teamsHtml = await fs.readFile(
      path.join(templates, "okr", "dashboards", "okr-teams.html"),
      "utf8"
    );
    const teamsResult = await executeDashboardQueries(
      { id: "template-test", name: "Template", workspace } as AgentConfig,
      teamsHtml,
      { viewer_email: "henry@example.com" }
    );
    const teams = teamsResult.data.teams as Array<{ team: string }>;
    expect(teams.map((row) => row.team).sort()).toEqual([
      "Global Operations",
      "Growth",
    ]);
    const company = teamsResult.data.company as Array<{
      headcount: number;
    }>;
    // The tiny team's 2 members are excluded from the company average too.
    expect(company[0]?.headcount).toBe(9);
  });

  it("rebuilds the CS sample from wiki and runs clients to QBR queries", async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-cs-"));
    await fs.mkdir(path.join(workspace, "data"));
    const script = path.join(templates, "cs/scripts/wiki-to-cs-db.mjs");
    await execFileAsync(process.execPath, [
      script,
      path.join(templates, "cs/wiki/clients.md"),
      path.join(workspace, "data", "cs.db"),
      path.join(templates, "cs/data/migrations/001_cs.sql"),
    ]);
    const db = new Database(path.join(workspace, "data", "cs.db"), {
      readonly: true,
    });
    expect(db.prepare("SELECT count(*) AS count FROM clients").get()).toEqual({
      count: 2,
    });
    expectMutableTablesHaveUpdatedAt(db);
    db.close();

    await expectTemplatesToQuery("cs", {
      viewer_email: "henry@example.com",
      id: "acme",
      quarter: "2026-Q3",
    });
    for (const file of ["client.html", "qbr.html"]) {
      const html = await fs.readFile(
        path.join(templates, "cs", "dashboards", file),
        "utf8"
      );
      const result = await executeDashboardQueries(
        { id: "template-test", name: "Template", workspace } as AgentConfig,
        html,
        {
          viewer_email: "amina@example.com",
          id: "acme",
          quarter: "2026-Q3",
        }
      );
      expect(result.errors, file).toEqual([]);
      expect(
        Object.values(result.data).every((rows) => rows.length === 0)
      ).toBe(true);
    }
  });

  async function expectTemplatesToQuery(
    family: "hr" | "cs" | "okr",
    bindings: Record<string, string>
  ): Promise<void> {
    const directory = path.join(templates, family, "dashboards");
    const files = (await fs.readdir(directory)).filter((file) =>
      file.endsWith(".html")
    );
    const expectedCounts = { hr: 4, cs: 3, okr: 3 };
    expect(files).toHaveLength(expectedCounts[family]);
    for (const file of files) {
      const html = await fs.readFile(path.join(directory, file), "utf8");
      expect(html).not.toMatch(/(?:src|href)=["']https?:/);
      expect(parseDashboardQueries(html).length).toBeGreaterThan(0);
      const result = await executeDashboardQueries(
        { id: "template-test", name: "Template", workspace } as AgentConfig,
        html,
        bindings
      );
      expect(result.errors, file).toEqual([]);
      expect(
        Object.values(result.data).some((rows) => rows.length > 0),
        file
      ).toBe(true);
      expect(() =>
        executeTemplateScripts(html, result.data, bindings)
      ).not.toThrow();
    }
  }
});

function executeTemplateScripts(
  html: string,
  data: Record<string, unknown[]>,
  params: Record<string, string>
): void {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const noOp = () => undefined;
  Object.assign(dom.window, {
    YOPLAI: {
      data,
      viewer: { email: params.viewer_email, name: "Template Viewer" },
      params,
      link: (slug: string) => `/d/template-${slug}`,
    },
    DashboardKit: {
      kpi: noOp,
      table: noOp,
      list: noOp,
      tabs: noOp,
      filters: noOp,
      md: noOp,
      chart: noOp,
    },
  });
  for (const script of dom.window.document.querySelectorAll("script")) {
    if (!script.src && script.type !== "application/sql") {
      dom.window.eval(script.textContent ?? "");
    }
  }
  dom.window.close();
}

function expectMutableTablesHaveUpdatedAt(db: Database.Database): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{
      name: string;
    }>;
    expect(
      columns.map((column) => column.name),
      name
    ).toContain("updated_at");
  }
}
