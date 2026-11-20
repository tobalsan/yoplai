import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GatewayConfigSchema, getOAuthProvider } from "@yoplai/shared";
import { getConfigPath, loadConfig, setLoadedConfig, CONFIG_DIR } from "../config/index.js";
import { startGatewayHotReload } from "../config/hot-reload.js";
import { listSettingsChanges } from "../audit/store.js";
import { app } from "../server/index.js";
import { buildInnerApi } from "../server/api.core.js";
import { getCurrentInnerApi, getExtensionRuntime, loadExtensions, setExtensionActivator, stopCurrentExtensions } from "./registry.js";
import { reloadAfterExtensionWrite } from "./reload.js";
import { fixtureRelease, packFixture } from "./release-bundle.fixture.js";

const base = "http://127.0.0.1:19143";
const root = path.join(CONFIG_DIR, "extensions");
const mode = process.argv[2];
const config = GatewayConfigSchema.parse({ version: 3, agents: [{ id: "fixture", name: "Fixture", workspace: CONFIG_DIR, ...(mode === "selection" ? { extensions: { retained: { enabled: true }, dependent: { enabled: true } } } : {}), model: { provider: "openai", model: "fixture" } }], extensionsPath: root,
  extensions: { sample: { enabled: true } }, extensionCatalog: { url: `${base}/catalog.json` } });
setLoadedConfig(config);
const initial = await loadExtensions(config);
const hooks: string[] = [];
const oauthAtStart: (string | undefined)[] = [];
const configAtStart: (boolean | undefined)[] = [];
const log = console.log;
console.log = (...args) => {
  if (/^\w+ (start|stop)$/.test(String(args[0]))) hooks.push(args.join(" "));
  else log(...args);
};
setExtensionActivator(async (extension) => {
  if (extension.id === "sample") {
    oauthAtStart.push(getOAuthProvider("sampleProvider")?.tokenUrl);
    configAtStart.push(loadConfig().extensionCatalog?.enabled);
  }
  if (["sample", "mcp", "retained", "inactive", "dependent", "mail", "drive"].includes(extension.id)) {
    await extension.start({} as Parameters<typeof extension.start>[0]);
  }
}, buildInnerApi, buildInnerApi(initial));

let fixture = fixtureRelease(base, "1.0.0", { failStop: mode === "stop", oauthTokenUrl: "https://example.test/v1" });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
let dropEntry = false;
let catalogEntries: (typeof fixture.entry)[] | undefined;
let pauseBundle: Promise<void> | undefined;
let downloaded: (() => void) | undefined;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === "/catalog.json") return Response.json({ ...fixture.catalog, extensions: dropEntry ? [] : catalogEntries ?? fixture.catalog.extensions });
  downloaded?.();
  await pauseBundle;
  return new Response(new Uint8Array(fixture.bundle));
};
const collection = "/api/admin/extension-catalog";
const call = async (method: string, url: string, status: number, headers?: HeadersInit) => {
  const response = await app.request(url, { method, headers });
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text;
};
const install = (status = 200, id = "sample") => call("POST", `${collection}/${id}/install`, status);
const remove = (status = 200, id = "sample") => call("DELETE", `${collection}/${id}`, status);
const refresh = () => call("POST", `${collection}/refresh`, 200);
const answer = (status = 200) => call("GET", "/api/sample", status);
const toolAnswer = async () => {
  const agent = config.agents[0];
  const tool = await getExtensionRuntime().getTool(agent, "sample_version", config);
  assert.ok(tool);
  return tool.execute({}, { agent, config });
};
const readRecord = () => fs.readFile(path.join(root, "sample", ".install.json"), "utf8");

await call("POST", `${collection}/sample/install`, 403, { Origin: "http://127.0.0.1:3999" });
await call("GET", collection, 200);
await call("GET", "/api/capabilities", 200);
await answer(404);
await install();
assert.equal(await answer(), "1.0.0");
assert.equal(await call("GET", "/x/sample/info", 200), "1.0.0");
assert.equal(await toolAnswer(), "1.0.0");
const firstRecord = await readRecord();
const firstSha256 = fixture.entry.sha256;
const target = path.join(root, "sample");
const snapshot = async (folder: string) => Object.fromEntries(await Promise.all(
  (await fs.readdir(folder)).map(async (name) => [name, await fs.readFile(path.join(folder, name), "utf8")])
));
const firstFiles = await snapshot(target);
const audit = (action: string, before: string | null, after: string | null) => {
  const { entries } = listSettingsChanges({ action });
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.actorUserId, "local");
  assert.equal(entry.action, action);
  assert.equal(entry.targetType, "extension");
  assert.equal(entry.targetId, "sample");
  assert.deepEqual(entry.changes, [{ field: "sha256", before, after }]);
};

switch (mode) {
  case "success": {
    fixture = fixtureRelease(base, "2.0.0", { oauthTokenUrl: "https://example.test/v2" });
    await refresh();
    const release = gate();
    const reached = gate();
    pauseBundle = release.promise;
    downloaded = reached.resolve;
    const pending = install();
    await reached.promise;
    await install(409);
    release.resolve();
    await pending;
    assert.equal(await answer(), "2.0.0");
    assert.equal(await call("GET", "/x/sample/info", 200), "2.0.0");
    assert.equal(await toolAnswer(), "2.0.0");
    assert.deepEqual(oauthAtStart, ["https://example.test/v1", "https://example.test/v2"]);
    assert.deepEqual(hooks, ["sample start 1.0.0 1.0.0", "sample stop 1.0.0", "sample start 2.0.0 2.0.0"]);
    audit("extension.install", null, firstSha256);
    audit("extension.update", firstSha256, fixture.entry.sha256);
    dropEntry = true;
    await refresh();
    await remove();
    audit("extension.remove", fixture.entry.sha256, null);
    await answer(404);
    assert.equal(getOAuthProvider("sampleProvider"), undefined);
    await assert.rejects(readRecord, { code: "ENOENT" });
    await stopCurrentExtensions();
    assert.equal(hooks.filter((entry) => entry === "sample stop 2.0.0").length, 1);
    break;
  }
  case "start":
  case "stop":
  case "config":
  case "reload": {
    fixture = fixtureRelease(base, "2.0.0", { failStart: mode === "start", failConfig: mode === "config", failReload: mode === "reload", oauthTokenUrl: "https://example.test/v2" });
    await refresh();
    assert.match(await install(409), mode === "start" ? /Start rejected/ : mode === "stop" ? /Stop rejected/ : mode === "reload" ? /Reload rejected/ : /Config rejected/);
    assert.equal(await answer(), "1.0.0");
    assert.equal(await call("GET", "/x/sample/info", 200), "1.0.0");
    assert.equal(await toolAnswer(), "1.0.0");
    assert.equal(getOAuthProvider("sampleProvider")?.tokenUrl, "https://example.test/v1");
    assert.equal(await readRecord(), firstRecord);
    assert.equal(await fs.readFile(path.join(root, "sample", "LICENSE"), "utf8"), "1.0.0");
    assert.deepEqual(hooks, ["sample start 1.0.0 1.0.0", ...(mode === "config" ? [] : [
      "sample stop 1.0.0", ...(["start", "reload"].includes(mode) ? ["sample start 2.0.0 2.0.0", "sample stop 2.0.0"] : []), "sample start 1.0.0 1.0.0",
    ])]);
    break;
  }
  case "restore": {
    fixture = fixtureRelease(base, "2.0.0", { failStart: true, oauthTokenUrl: "https://example.test/v2" });
    await refresh();
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (String(from).startsWith(path.join(root, ".trash") + path.sep) && to === target) throw new Error("Backup rename failed.");
      return rename(from, to);
    };
    try {
      const error = JSON.parse(await install(409)).error;
      assert.match(error, /Backup rename failed/);
      assert.match(error, /Start rejected/);
    } finally {
      fs.rename = rename;
    }
    await answer(404);
    await call("GET", "/x/sample/info", 404);
    assert.equal(getOAuthProvider("sampleProvider"), undefined);
    assert.ok(!getExtensionRuntime().isEnabled("sample"));
    assert.deepEqual(hooks, ["sample start 1.0.0 1.0.0", "sample stop 1.0.0", "sample start 2.0.0 2.0.0", "sample stop 2.0.0"]);
    const backups = await fs.readdir(path.join(root, ".trash"));
    assert.equal(backups.length, 1);
    assert.deepEqual(await snapshot(path.join(root, ".trash", backups[0])), firstFiles);
    break;
  }
  case "write-race":
  case "watch-race": {
    const disk = { version: 3, agents: [], extensionsPath: root, extensions: config.extensions, extensionCatalog: config.extensionCatalog };
    await fs.writeFile(getConfigPath(), JSON.stringify(disk));
    const watched = gate();
    const timer = mode === "watch-race" ? startGatewayHotReload(config, { intervalMs: 5, onReload: watched.resolve }) : undefined;
    try {
      fixture = fixtureRelease(base, "2.0.0");
      await refresh();
      const release = gate();
      const reached = gate();
      pauseBundle = release.promise;
      downloaded = reached.resolve;
      const pending = install();
      await reached.promise;
      await fs.writeFile(getConfigPath(), JSON.stringify({ ...disk, extensionCatalog: { ...disk.extensionCatalog, enabled: true } }));
      const changeTime = new Date(Date.now() + 2000);
      await fs.utimes(getConfigPath(), changeTime, changeTime);
      const reload = timer ? watched.promise : reloadAfterExtensionWrite();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(loadConfig().extensionCatalog?.enabled, config.extensionCatalog?.enabled);
      release.resolve();
      await pending;
      await reload;
      assert.equal(await answer(), "2.0.0");
      assert.deepEqual(configAtStart, [config.extensionCatalog?.enabled, config.extensionCatalog?.enabled]);
      assert.equal(loadConfig().extensionCatalog?.enabled, true);
    } finally {
      clearInterval(timer);
    }
    break;
  }
  case "ownership": {
    for (const id of ["canvas", "slack"]) await install(409, id);
    catalogEntries = [{ ...fixture.entry, id: "future", minYoplai: "999.0.0" }, ...fixture.catalog.extensions];
    await refresh();
    assert.match(await install(409, "future"), /needs Yoplai/);
    for (const id of ["manual", "invalid", "linked"]) {
      const folder = path.join(root, id);
      if (id === "linked") await fs.symlink(target, folder, "dir");
      else {
        await fs.mkdir(folder);
        if (id === "invalid") await fs.writeFile(path.join(folder, ".install.json"), "{}");
      }
      catalogEntries.push({ ...fixture.entry, id });
      await refresh();
      assert.match(await install(409, id), /Managed by hand/);
      assert.match(await remove(409, id), /Managed by hand/);
    }
    const manual = path.join(root, "duplicate");
    await fs.mkdir(manual);
    await fs.copyFile(path.join(target, "index.js"), path.join(manual, "index.js"));
    await fs.copyFile(path.join(target, "package.json"), path.join(manual, "package.json"));
    const manualFiles = await snapshot(manual);
    assert.match(await install(409), /Another folder/);
    assert.match(await remove(409), /Another folder/);
    assert.deepEqual(await snapshot(manual), manualFiles);
    assert.deepEqual(await snapshot(target), firstFiles);
    assert.equal(await answer(), "1.0.0");
    assert.deepEqual(hooks, ["sample start 1.0.0 1.0.0"]);
    break;
  }
  case "rename": {
    fixture = fixtureRelease(base, "2.0.0");
    await refresh();
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (String(from).startsWith(path.join(root, ".staging") + path.sep) && to === target) throw new Error("Staging rename failed.");
      return rename(from, to);
    };
    try { assert.match(await install(409), /Staging rename failed/); }
    finally { fs.rename = rename; }
    assert.deepEqual(await snapshot(target), firstFiles);
    assert.equal(await answer(), "1.0.0");
    assert.deepEqual(hooks, ["sample start 1.0.0 1.0.0"]);
    break;
  }
  case "bundles": {
    const next = fixtureRelease(base, "2.0.0");
    const { bundle, entry } = next;
    const archive = (files: Record<string, string>, types?: Record<string, string>) => packFixture({
      "index.js": "export default {};", "manifest.json": JSON.stringify({ id: "sample", version: "2.0.0" }), ...files,
    }, types);
    const cases: { bundle: Buffer; overrides: Partial<typeof entry>; error: RegExp }[] = [
      { bundle, overrides: { sha256: "0".repeat(64) }, error: /digest/ },
      { bundle, overrides: { size: bundle.length + 1 }, error: /size does not match/ },
      { bundle, overrides: { size: bundle.length - 1 }, error: /exceeds the size limit/ },
      ...[archive({ LICENSE: "" }, { LICENSE: "2" }), archive({ "/outside": "" }), archive({ "..": "" })]
        .map((bundle) => ({ bundle, error: /not allowed/, overrides: {} })),
      { bundle: archive({ "manifest.json": '{"id":"other","version":"2.0.0"}' }), error: /manifest ID/, overrides: {} },
      { bundle: archive({ "manifest.json": '{"id":"inactive","version":"2.0.0"}' }), overrides: { id: "inactive" }, error: /Invalid extension/ },
    ];
    for (const item of cases) {
      fixture = { ...next, bundle: item.bundle };
      const id = item.overrides.id ?? entry.id;
      catalogEntries = [{ ...entry, size: item.bundle.length, sha256: createHash("sha256").update(item.bundle).digest("hex"), ...item.overrides }];
      await refresh();
      assert.match(await install(409, id), item.error);
      assert.deepEqual(await snapshot(target), firstFiles);
      await assert.rejects(fs.stat(path.join(root, "inactive")), { code: "ENOENT" });
      assert.equal(await answer(), "1.0.0");
    }
    assert.deepEqual(hooks, ["sample start 1.0.0 1.0.0"]);
    break;
  }
  case "selection": {
    for (const id of ["mcp", "retained", "inactive", "dependent"]) {
      fixture = fixtureRelease(base, "1.0.0", { id, dependencies: id === "dependent" ? ["sample"] : [] });
      await refresh();
      await install(200, id);
    }
    assert.ok(hooks.includes("mcp start 1.0.0 1.0.0"));
    assert.ok(hooks.includes("retained start 1.0.0 1.0.0"));
    assert.ok(!hooks.some((entry) => entry.startsWith("inactive ")));
    assert.match(await remove(409), /dependent needs this extension/);
    assert.deepEqual(await snapshot(target), firstFiles);
    fixture = fixtureRelease(base, "2.0.0", { id: "mcp" });
    await refresh();
    await install(200, "mcp");
    const inner = getCurrentInnerApi();
    assert.ok(inner);
    const response = await inner.fetch(new Request(`${base}/mcp/servers`), { multiUserAuthContext: { user: { id: "requester" } } });
    assert.deepEqual(await response.json(), { version: "2.0.0", requester: "requester" });
    await stopCurrentExtensions();
    assert.equal(hooks.filter((entry) => entry === "mcp stop 2.0.0").length, 1);
    break;
  }
  case "owners": {
    setLoadedConfig({ ...config, extensions: { ...config.extensions, mail: { enabled: true }, drive: { enabled: true } } });
    for (const id of ["mail", "drive"]) {
      fixture = fixtureRelease(base, "1.0.0", { id, providerId: "google", oauthTokenUrl: "https://example.test/google" });
      await refresh();
      await install(200, id);
    }
    const provider = getOAuthProvider("google");
    assert.equal(provider?.tokenUrl, "https://example.test/google");
    const drive = path.join(root, "drive");
    const files = await snapshot(drive);
    const hooksBefore = hooks.slice();
    fixture = fixtureRelease(base, "2.0.0", { id: "drive", providerId: "google", oauthTokenUrl: "https://example.test/conflict" });
    await refresh();
    assert.match(await install(409, "drive"), /OAuth provider google conflicts/);
    assert.deepEqual(await snapshot(drive), files);
    assert.deepEqual(hooks, hooksBefore);
    assert.deepEqual(getOAuthProvider("google"), provider);
    await remove(200, "mail");
    assert.deepEqual(getOAuthProvider("google"), provider);
    assert.ok(getExtensionRuntime().isEnabled("drive"));
    break;
  }
  default: throw new Error("Unknown test case.");
}
