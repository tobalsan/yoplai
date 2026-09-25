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
    family: "hr" | "cs",
    bindings: Record<string, string>
  ): Promise<void> {
    const directory = path.join(templates, family, "dashboards");
    const files = (await fs.readdir(directory)).filter((file) =>
      file.endsWith(".html")
    );
    expect(files).toHaveLength(family === "hr" ? 6 : 3);
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
