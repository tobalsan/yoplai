import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintDashboardHtml } from "./lint.js";

const SQL = `<script type="application/sql" data-name="items" data-db="data/app.db">select 1</script>`;
const page = (body: string, head = "") =>
  `<!doctype html>\n<html><head>${head}</head><body>\n${body}\n</body></html>`;
const module = (code: string) => `<script type="module">\n${code}\n</script>`;

describe("lintDashboardHtml", () => {
  it("accepts a clean module page", () => {
    const html = page(
      `${SQL}${module("const top = YOPLAI.data.items; DashboardKit.chart('#c', top);")}`,
      `<script src="/d-assets/v2/echarts.js"></script><script src="/d-assets/v2/kit.js"></script>`
    );
    expect(lintDashboardHtml(html)).toEqual([]);
  });

  it("ignores non-JS script types", () => {
    expect(
      lintDashboardHtml(
        page(`${SQL}<script type="application/json">{"a": 1,}</script>`)
      )
    ).toEqual([]);
  });

  it("reports classic top-level declarations that collide with browser globals", () => {
    const problems = lintDashboardHtml(
      page(`<script>\nconst top = 1;\n</script>`)
    );
    expect(problems).toEqual([
      expect.stringContaining("Identifier 'top' has already been declared"),
    ]);
    expect(problems[0]).toContain('<script type="module">');
  });

  it("reports duplicate declarations across classic scripts", () => {
    const problems = lintDashboardHtml(
      page(`<script>const a = 1;</script><script>const a = 2;</script>`)
    );
    expect(problems).toEqual([
      expect.stringContaining("Script 2: Identifier 'a' has already"),
    ]);
  });

  it("reports syntax errors with the page line", () => {
    const classic = lintDashboardHtml(page(`<script>\nfoo(\n</script>`));
    expect(classic).toEqual([expect.stringMatching(/line 5\).*syntax error/)]);
    const mod = lintDashboardHtml(page(module("const x = ;")));
    expect(mod).toEqual([expect.stringMatching(/line 4\).*syntax error/)]);
    const imports = lintDashboardHtml(page(module('import x from "y";')));
    expect(imports[0]).toContain("Imports and exports are not supported");
  });

  it("requires echarts.js before kit.js when charts are used", () => {
    const kitFirst = page(
      module("DashboardKit.chart('#c', {});"),
      [
        `<script src="/d-assets/v2/kit.js"></script>`,
        `<script src="/d-assets/v2/echarts.js"></script>`,
      ].join("")
    );
    expect(lintDashboardHtml(kitFirst)).toEqual([
      expect.stringContaining("before kit.js"),
    ]);
    const missing = page(
      module("DashboardKit.chart('#c', {});"),
      `<script src="/d-assets/v2/kit.js"></script>`
    );
    expect(lintDashboardHtml(missing)).toEqual([
      expect.stringContaining("echarts.js"),
    ]);
    const noCharts = page(
      module("DashboardKit.table('#t', {});"),
      `<script src="/d-assets/v2/kit.js"></script>`
    );
    expect(lintDashboardHtml(noCharts)).toEqual([]);
  });

  it("reports DashboardKit use without kit.js", () => {
    expect(
      lintDashboardHtml(page(module("DashboardKit.table('#t', {});")))
    ).toEqual([expect.stringContaining("kit.js")]);
  });

  it("reports outdated v1 assets", () => {
    const html = page(
      "",
      `<link rel="stylesheet" href="/d-assets/v1/kit.css" />`
    );
    expect(lintDashboardHtml(html)).toEqual([
      expect.stringContaining("/d-assets/v2/"),
    ]);
  });

  it("reports YOPLAI.data names without a matching query", () => {
    const html = page(
      `${SQL}${module(`YOPLAI.data.items; YOPLAI.data.foo; YOPLAI.data["bar"];`)}`
    );
    expect(lintDashboardHtml(html)).toEqual([
      expect.stringContaining("YOPLAI.data.foo"),
      expect.stringContaining("YOPLAI.data.bar"),
    ]);
  });

  it("reports inline handlers when the page uses module scripts", () => {
    const html = page(
      `<button onclick="go()">Go</button>\n${module("function go() {}")}`
    );
    expect(lintDashboardHtml(html)).toEqual([
      expect.stringMatching(/Line 3: inline onclick=/),
    ]);
    expect(
      lintDashboardHtml(
        page(
          `<button onclick="go()">Go</button><script>function go(){}</script>`
        )
      )
    ).toEqual([]);
  });

  it("never executes agent code", () => {
    delete (globalThis as { __ran?: number }).__ran;
    const started = Date.now();
    expect(
      lintDashboardHtml(
        page(`<script>globalThis.__ran = 1; while (true) {}</script>`)
      )
    ).toEqual([]);
    expect((globalThis as { __ran?: number }).__ran).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("accepts the shipped sample and every dashboard template", () => {
    const templates = new URL(
      "../skills/dashboard/templates/",
      import.meta.url
    );
    const files = fs
      .readdirSync(templates, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".html"))
      .map((file) => path.join(templates.pathname, file));
    files.push(new URL("./assets/sample.html", import.meta.url).pathname);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(lintDashboardHtml(fs.readFileSync(file, "utf8")), file).toEqual(
        []
      );
    }
  });
});
