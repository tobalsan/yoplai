import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { GatewayConfigSchema, getOAuthProvider } from "@yoplai/shared";
import { setLoadedConfig, CONFIG_DIR } from "../config/index.js";
import { app } from "../server/index.js";
import { buildInnerApi } from "../server/api.core.js";
import { getExtensionRuntime, loadExtensions, reloadExtensions, setExtensionActivator, stopCurrentExtensions } from "./registry.js";
import { fixtureRelease } from "./release-bundle.fixture.js";

const base = "http://127.0.0.1:19143";
const root = path.join(CONFIG_DIR, "extensions");
const config = GatewayConfigSchema.parse({ version: 3, agents: [{ id: "fixture", name: "Fixture", workspace: CONFIG_DIR, model: { provider: "openai", model: "fixture" } }], extensionsPath: root,
  extensions: { sample: { enabled: true } }, extensionCatalog: { url: `${base}/catalog.json` } });
setLoadedConfig(config);
const initial = await loadExtensions(config);
const hooks: string[] = [];
const oauthAtStart: (string | undefined)[] = [];
const log = console.log;
console.log = (...args) => {
  if (String(args[0]).startsWith("sample ")) hooks.push(args.join(" "));
  else log(...args);
};
setExtensionActivator(async (extension) => {
  if (extension.id === "sample") {
    oauthAtStart.push(getOAuthProvider("sampleProvider")?.tokenUrl);
    await extension.start({} as Parameters<typeof extension.start>[0]);
  }
}, buildInnerApi, buildInnerApi(initial));

let fixture = fixtureRelease(base, "1.0.0", { failStop: process.argv[2] === "stop", oauthTokenUrl: "https://example.test/v1" });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
let dropEntry = false;
let pauseBundle: Promise<void> | undefined;
let downloaded: (() => void) | undefined;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === "/catalog.json") return Response.json({ ...fixture.catalog, extensions: dropEntry ? [] : fixture.catalog.extensions });
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
const install = (status = 200) => call("POST", `${collection}/sample/install`, status);
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

switch (process.argv[2]) {
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
    let reloaded = false;
    const reload = reloadExtensions(config).then(() => { reloaded = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(reloaded, false);
    release.resolve();
    await pending;
    await reload;
    assert.equal(await answer(), "2.0.0");
    assert.equal(await call("GET", "/x/sample/info", 200), "2.0.0");
    assert.equal(await toolAnswer(), "2.0.0");
    assert.deepEqual(oauthAtStart, ["https://example.test/v1", "https://example.test/v2"]);
    assert.deepEqual(hooks, ["sample start 1.0.0 1.0.0", "sample stop 1.0.0", "sample start 2.0.0 2.0.0"]);
    dropEntry = true;
    await refresh();
    await call("DELETE", `${collection}/sample`, 200);
    await answer(404);
    assert.equal(getOAuthProvider("sampleProvider"), undefined);
    await assert.rejects(readRecord, { code: "ENOENT" });
    await stopCurrentExtensions();
    assert.equal(hooks.filter((entry) => entry === "sample stop 2.0.0").length, 1);
    break;
  }
  case "start":
  case "stop":
  case "config": {
    const mode = process.argv[2];
    fixture = fixtureRelease(base, "2.0.0", { failStart: mode === "start", failConfig: mode === "config", oauthTokenUrl: "https://example.test/v2" });
    await refresh();
    assert.match(await install(409), mode === "start" ? /Start rejected/ : mode === "stop" ? /Stop rejected/ : /Config rejected/);
    assert.equal(await answer(), "1.0.0");
    assert.equal(await call("GET", "/x/sample/info", 200), "1.0.0");
    assert.equal(await toolAnswer(), "1.0.0");
    assert.equal(getOAuthProvider("sampleProvider")?.tokenUrl, "https://example.test/v1");
    assert.equal(await readRecord(), firstRecord);
    assert.equal(await fs.readFile(path.join(root, "sample", "LICENSE"), "utf8"), "1.0.0");
    assert.deepEqual(hooks, ["sample start 1.0.0 1.0.0", ...(mode === "config" ? [] : [
      "sample stop 1.0.0", ...(mode === "start" ? ["sample start 2.0.0 2.0.0", "sample stop 2.0.0"] : []), "sample start 1.0.0 1.0.0",
    ])]);
    break;
  }
  default: throw new Error("Unknown test case.");
}
