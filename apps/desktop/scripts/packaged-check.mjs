import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URLSearchParams } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function checkRuntime(mode, resources) {
  const gateway = path.join(resources, "gateway");
  const load = (file) => import(pathToFileURL(path.join(gateway, "dist", file)).href);
  if (mode === "ocr") {
    assert.deepEqual(await fs.readdir(process.env.TMPDIR), []);
    const { extractPdfBuffer } = await load("media/extract.js");
    assert.match(await extractPdfBuffer(await fs.readFile(path.join(fixtures, "scanned.pdf"))), /YOPLAI SCANNED/);
    console.log("PASS offline OCR");
    return;
  }

  const require = createRequire(path.join(gateway, "package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  try {
    assert.equal(db.prepare("select 42 as value").get().value, 42);
  } finally {
    db.close();
  }
  console.log("PASS SQLite");

  const { getBuiltInExtensionRegistrations } = await load("extensions/registry.js");
  const bundled = getBuiltInExtensionRegistrations();
  assert.equal(bundled.length, 16);
  for (const { id, load: loadExtension } of bundled) assert.equal((await loadExtension()).id, id);
  console.log(`PASS extensions: ${bundled.map(({ id }) => id).join(", ")}`);

  const { extractText } = await load("media/extract.js");
  for (const [ext, mime] of [
    ["pdf", "application/pdf"],
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ]) {
    const text = await extractText(path.join(fixtures, `text.${ext}`), mime);
    assert.ok(text?.includes(`DESKTOP ${ext.toUpperCase()}`), `${ext}: ${JSON.stringify(text)}`);
    console.log(`PASS text extraction: ${ext}`);
  }
}

async function request(base, route, expected, method = "GET", body) {
  const response = await globalThis.fetch(`${base}${route}`, { method, body, signal: globalThis.AbortSignal.timeout(20_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, expected, `${method} ${route}: ${bytes.toString()}`);
  return bytes;
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function checkPackages(app, reference) {
  const { createPackagedLaunchPlan } = await import("../dist/launch-plan.js");
  const { seedHome } = await import("../dist/packaged-env.js");
  const { pickPorts } = await import("../dist/ports.js");
  const id = "desktop-fixture";
  const bundle = execFileSync("tar", ["--format", "ustar", "--no-mac-metadata", "-czf", "-", "-C", path.join(fixtures, "catalog"), "manifest.json", "index.js"]);
  const manifest = JSON.parse(await fs.readFile(path.join(fixtures, "catalog/manifest.json"), "utf8"));
  let catalog;
  const server = createServer((req, res) => {
    if (req.url === "/catalog.json") res.setHeader("Content-Type", "application/json").end(JSON.stringify(catalog));
    else if (req.url === `/${id}.tgz`) res.end(bundle);
    else res.writeHead(404).end();
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-packaged-check-"));
  const seed = path.join(root, "seed");
  const home = path.join(root, "home");
  const userHome = path.join(root, "user");
  const tmp = path.join(root, "tmp");
  // Each packaged gateway reaches Docker through PATH; a stub keeps them off the real daemon.
  const stubBin = path.join(root, "bin");
  try {
    await fs.mkdir(stubBin);
    await fs.writeFile(path.join(stubBin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const source = `http://127.0.0.1:${server.address().port}`;
    catalog = { schemaVersion: 1, generatedAt: new Date().toISOString(), commit: "fixture", release: "v1.0.0", extensions: [
      { ...manifest, url: `${source}/${id}.tgz`, size: bundle.length, sha256: createHash("sha256").update(bundle).digest("hex") },
    ] };
    seedHome(seed);
    const configFile = path.join(seed, "yoplai.json");
    const config = JSON.parse(await fs.readFile(configFile, "utf8"));
    config.extensionCatalog = { url: `${source}/catalog.json` };
    config.extensions = { [id]: { enabled: true } };
    await fs.writeFile(configFile, JSON.stringify(config));

    const ports = await pickPorts();
    const base = `http://127.0.0.1:${ports.gatewayPort}`;
    // Browser requests go through the UI port, as the packaged window does.
    const uiBase = `http://127.0.0.1:${ports.uiPort}`;
    async function plan(appPath, resetHome) {
      if (resetHome) {
        await fs.rm(home, { recursive: true, force: true });
        await fs.cp(seed, home, { recursive: true });
      }
      for (const dir of [userHome, tmp]) {
        await fs.rm(dir, { recursive: true, force: true });
        await fs.mkdir(dir);
      }
      const resourcesPath = path.join(path.resolve(appPath), "Contents", "Resources");
      const { children: [child] } = createPackagedLaunchPlan(ports, {
        execPath: path.resolve(appPath, "Contents", "MacOS", "Yoplai"), resourcesPath, home,
        shellPath: `${stubBin}${path.delimiter}${process.env.PATH}`, parentEnv: { HOME: userHome, TMPDIR: tmp },
      });
      return { ...child, resourcesPath };
    }

    async function withGateway(appPath, resetHome, check) {
      const { command, args, cwd, env } = await plan(appPath, resetHome);
      const start = performance.now();
      const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const exit = new Promise((resolve) => child.once("exit", resolve));
      let output = "";
      let spawnError;
      child.on("error", (error) => { spawnError = error; });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
      try {
        while (performance.now() - start < 20_000) {
          if (spawnError) throw spawnError;
          if (child.exitCode !== null || child.signalCode !== null) throw new Error("The gateway stopped.");
          const ready = await globalThis.fetch(`${base}/health`, { signal: globalThis.AbortSignal.timeout(500) }).catch(() => null);
          if (ready?.ok) {
            const elapsed = performance.now() - start;
            await ready.arrayBuffer();
            if (check) {
              const ui = await globalThis.fetch(uiBase, { signal: globalThis.AbortSignal.timeout(500) }).catch(() => null);
              await ui?.arrayBuffer();
              if (!ui?.ok) {
                await setTimeout(20);
                continue;
              }
              await check(uiBase);
            }
            return elapsed;
          }
          await setTimeout(20);
        }
        throw new Error(check ? "The gateway and UI did not become ready." : "The gateway did not answer the health request.");
      } catch (error) {
        console.error(output);
        throw error;
      } finally {
        if (child.pid) {
          signalGroup(child.pid, "SIGTERM");
          const timer = new globalThis.AbortController();
          try {
            await Promise.race([exit, setTimeout(3_000, undefined, { signal: timer.signal }).then(() => {
              signalGroup(child.pid, "SIGKILL");
              return exit;
            })]);
          } finally {
            timer.abort();
          }
        }
      }
    }

    const { command, args, cwd, env, resourcesPath } = await plan(app, true);
    const cliHelp = execFileSync(command, [args[0], "--help"], { cwd, env, encoding: "utf8", timeout: 20_000 });
    assert.match(cliHelp, /Usage:/);
    console.log("PASS CLI help");
    const self = fileURLToPath(import.meta.url);
    execFileSync(command, [self, "runtime", resourcesPath], { cwd, env, stdio: "inherit", timeout: 20_000 });
    await fs.rm(tmp, { recursive: true });
    await fs.mkdir(tmp);
    execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", command, self, "ocr", resourcesPath], {
      cwd, env, stdio: "inherit", timeout: 30_000,
    });

    const collection = "/api/admin/extension-catalog";
    const route = `/api/${id}`;
    const page = `/x/${id}/form`;
    const answer = async (base) => {
      assert.equal((await request(base, route, 200)).toString(), "DESKTOP FIXTURE");
      assert.equal((await request(base, page, 200)).toString(), "<html>DESKTOP FIXTURE FORM</html>");
      const body = new URLSearchParams({ answer: "42" });
      assert.equal((await request(base, page, 200, "POST", body)).toString(), "answer=42");
    };
    await withGateway(app, true, async (base) => {
      for (const [name, file] of [["echarts", "echarts/dist/echarts.min.js"], ["marked", "marked/lib/marked.umd.js"], ["purify", "dompurify/dist/purify.min.js"]]) {
        const expected = await fs.readFile(path.join(resourcesPath, "gateway", "node_modules", file));
        const actual = await request(base, `/d-assets/v3/${name}.js`, 200);
        assert.ok(expected.length > 0 && actual.equals(expected), name);
      }
      console.log("PASS canvas asset bytes");
      await request(base, route, 404);
      await request(base, `${collection}/${id}/install`, 200, "POST");
      await answer(base);
      console.log("PASS catalog install");
    });
    await withGateway(app, false, async (base) => {
      await answer(base);
      console.log("PASS catalog restart");
      await request(base, `${collection}/${id}`, 200, "DELETE");
      await request(base, route, 404);
      await request(base, page, 404);
      console.log("PASS catalog removal");
    });

    if (reference) {
      const samples = { new: [], reference: [] };
      for (let i = 0; i < 3; i++) {
        samples.new.push(await withGateway(app, true));
        samples.reference.push(await withGateway(reference, true));
      }
      for (const [name, times] of Object.entries(samples)) {
        const sorted = times.toSorted((a, b) => a - b);
        console.log(`${name} ms: ${times.map((time) => time.toFixed(1)).join(", ")}. Median ${sorted[1].toFixed(1)}. Spread ${(sorted[2] - sorted[0]).toFixed(1)}.`);
      }
    }
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const [first, second] = process.argv.slice(2);
if (first === "runtime" || first === "ocr") await checkRuntime(first, second);
else {
  assert.ok(first, "Specify the app to check. A reference app for startup timings is optional.");
  await checkPackages(first, second);
}
