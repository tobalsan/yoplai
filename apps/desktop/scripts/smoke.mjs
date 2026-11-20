// Smoke test of the packaged runtime. Run it with the app binary as Node:
//   ELECTRON_RUN_AS_NODE=1 <Yoplai.app>/Contents/MacOS/Yoplai apps/desktop/scripts/smoke.mjs [<Resources dir>]
// It opens SQLite, runs a canvas SQL worker query, reads a scanned PDF with OCR, runs one codemode call,
// and prints the runtime versions. Exit code 0 means every check passed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const resources = process.argv[2] ?? path.resolve(path.dirname(process.execPath), "..", "Resources");
const gatewayDir = path.join(resources, "gateway");
const gatewayRequire = createRequire(path.join(gatewayDir, "package.json"));
const gatewayImport = (relative) => import(pathToFileURL(path.join(gatewayDir, relative)).href);

const failures = [];
async function check(name, run) {
  try {
    console.log(`PASS ${name}: ${await run()}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`);
  }
}

function atLeast(version, minimum) {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

await check("runtime", () => {
  const { electron, node, modules, v8 } = process.versions;
  console.log(`  electron=${electron} node=${node} moduleABI=${modules} v8=${v8} arch=${process.arch} platform=${process.platform}`);
  const engines = JSON.parse(fs.readFileSync(path.join(gatewayDir, "package.json"), "utf8")).engines?.node;
  const minimum = (engines ?? ">=22.19.0").replace(/^>=/, "");
  if (!atLeast(node, minimum)) throw new Error(`Node ${node} is older than engines ${engines}`);
  if (!electron) throw new Error("Not an Electron runtime");
  if (process.env.ELECTRON_RUN_AS_NODE !== "1") throw new Error("ELECTRON_RUN_AS_NODE is not 1");
  return `Node ${node} satisfies ${engines ?? ">=22.19.0"}`;
});

await check("sqlite", () => {
  const Database = gatewayRequire("better-sqlite3");
  const db = new Database(":memory:");
  db.exec("create table t(a integer); insert into t values (20), (22)");
  const sum = db.prepare("select sum(a) as s from t").get().s;
  db.close();
  if (sum !== 42) throw new Error(`Unexpected sum ${sum}`);
  return "in-memory query returned 42";
});

await check("canvas sql worker", async () => {
  const { runDashboardQuery } = await gatewayImport("dist/canvas/sql.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-smoke-"));
  try {
    const databasePath = path.join(root, "data.db");
    const Database = gatewayRequire("better-sqlite3");
    const db = new Database(databasePath);
    db.exec("create table items(name text); insert into items values ('alpha'), ('beta')");
    db.close();
    const rows = await runDashboardQuery(fs.realpathSync(root), fs.realpathSync(databasePath), "select name from items order by name", {});
    if (JSON.stringify(rows) !== JSON.stringify([{ name: "alpha" }, { name: "beta" }])) throw new Error(`Unexpected rows ${JSON.stringify(rows)}`);
    return "worker returned 2 rows";
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("pdf ocr", async () => {
  const { extractPdfBufferDetails } = await gatewayImport("dist/media/extract.js");
  const { text } = await extractPdfBufferDetails(fs.readFileSync(path.join(here, "fixtures", "scanned.pdf")));
  if (!/SCANNED/i.test(text)) throw new Error(`OCR text did not contain SCANNED: ${JSON.stringify(text)}`);
  return `OCR read ${JSON.stringify(text.trim())}`;
});

await check("codemode", async () => {
  const { CodemodeSandbox } = await import(pathToFileURL(path.join(gatewayDir, "node_modules", "@earendil-works", "pi-codemode", "dist", "index.js")).href);
  const sandbox = new CodemodeSandbox({ timeoutMs: 10_000 });
  try {
    const result = await sandbox.execute("text(String(6 * 7))");
    const serialized = JSON.stringify(result);
    if (!serialized.includes("42")) throw new Error(`Unexpected result ${serialized}`);
    return `result ${serialized.slice(0, 120)}`;
  } finally {
    await sandbox.dispose?.();
  }
});

if (failures.length > 0) {
  console.log(`\nSMOKE FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nSMOKE PASSED");
process.exit(0);
