import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkGateway, pruneGateway } from "./prune-gateway.mjs";

let stage: string;
let modules: string;

beforeEach(() => {
  stage = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-prune-"));
  modules = path.join(stage, "node_modules");
  fs.mkdirSync(modules);
});
afterEach(() => fs.rmSync(stage, { recursive: true, force: true }));

function write(file: string, data = "fixture") {
  const full = path.join(modules, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
}

function link(file: string, target: string) {
  const full = path.join(modules, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.symlinkSync(target, full);
}

function pkg(dir: string, name = dir, version = "1.0.0") {
  write(`${dir}/package.json`, JSON.stringify({ name, version }));
}

function exists(file: string) {
  return fs.existsSync(path.join(modules, file));
}

function prune() {
  pruneGateway(stage, "after-rebuild");
}

it("keeps scoped hoists, sibling peers, ancestor dependencies, shims, and metadata", () => {
  const consumer = ".pnpm/consumer@1.0.0/node_modules/consumer";
  const peer = ".pnpm/peer@1.0.0/node_modules/peer";
  const helper = ".pnpm/@scope+helper@1.0.0/node_modules/@scope/helper";
  for (const [dir, name] of [[consumer, "consumer"], [peer, "peer"], [helper, "@scope/helper"]]) pkg(dir, name);
  write(`${consumer}/index.js`, 'module.exports = require("peer") + require("@scope/helper");');
  write(`${peer}/index.js`, "module.exports = 40;");
  write(`${helper}/index.js`, "module.exports = 2;");
  write(`${helper}/index.js.map`);
  write(".bin/consumer");
  write(".pnpm/lock.yaml");
  link("consumer", consumer);
  link(".pnpm/consumer@1.0.0/node_modules/peer", `../../peer@1.0.0/node_modules/peer`);
  link(".pnpm/node_modules/@scope/helper", "../../@scope+helper@1.0.0/node_modules/@scope/helper");

  prune();
  expect(createRequire(path.join(stage, "package.json"))("consumer")).toBe(42);
  expect(exists(`${helper}/index.js.map`)).toBe(false);
  expect(exists(".bin/consumer")).toBe(true);
  expect(exists(".pnpm/lock.yaml")).toBe(true);
});

it("removes other-platform native files before the rebuild and keeps arm64 files", () => {
  pkg("better-sqlite3", "better-sqlite3", "13.2.0");
  pkg("pi-tui-alias", "@earendil-works/pi-tui");
  const remove = ["linux-arm64", "linuxmusl-x64", "win32-arm64", "darwin-x64"].map((id) => `better-sqlite3/prebuilds/${id}.node`);
  remove.push("pi-tui-alias/native/darwin/prebuilds/darwin-x64/addon.node", "pi-tui-alias/native/linux/prebuilds/linux-arm64/addon.node");
  const keep = ["better-sqlite3/prebuilds/darwin-arm64.node", "better-sqlite3/binding.gyp", "better-sqlite3/src/main.cpp", "pi-tui-alias/native/linux/LICENSE", "pi-tui-alias/native/linux/README.md", "pi-tui-alias/native/darwin/prebuilds/darwin-arm64/addon.node"];
  for (const file of [...remove, ...keep]) write(file);
  pruneGateway(stage, "before-rebuild");
  for (const file of remove) expect(exists(file), file).toBe(false);
  for (const file of keep) expect(exists(file), file).toBe(true);
});

it("keeps SQLite loader files and removes build files only after the rebuild", () => {
  pkg("better-sqlite3", "better-sqlite3", "13.2.0");
  const remove = ["src/main.cpp", "deps/sqlite.c", "build/Release/obj.target/intermediate", "build/Release/obj/intermediate", "build/file.a", "build/file.o", "build/file.mk", "build/Makefile", "binding.gyp"];
  const keep = ["lib/binding.js", "build/Release/better_sqlite3.node", "build/Debug/better_sqlite3.node", "prebuilds/darwin-arm64.node", "deps/licenses/sqlite.txt", "src/NOTICE"];
  for (const file of [...remove, ...keep]) write(`better-sqlite3/${file}`);
  prune();
  for (const file of remove) expect(exists(`better-sqlite3/${file}`), file).toBe(false);
  for (const file of keep) expect(exists(`better-sqlite3/${file}`), file).toBe(true);
});

it("keeps documents, licenses, manifests, and TypeScript outside the audited versions", () => {
  pkg("isarray", "isarray", "1.0.0");
  pkg("typebox", "typebox", "1.3.27");
  pkg("typebox-new", "typebox", "1.3.28");
  pkg("ajv", "ajv", "8.20.0");
  pkg("local-alias", "@yoplai/extension-sample");
  pkg("pi-alias", "@earendil-works/pi-coding-agent");
  const keep = [
    "isarray/README.md", "typebox/README.md", "typebox/LICENSE.map", "typebox/licenses/sample.map",
    "typebox/no-sibling.ts", "typebox/index.mjs", "typebox-new/index.d.mts", "ajv/refs/schema.json",
    "local-alias/manifest.json", "local-alias/skills/SKILL.md", "pi-alias/examples/test.js", "pi-alias/README.md",
    "pi-alias/dist/utils/changelog.js", "pi-alias/dist/test.d.ts",
  ];
  const remove = ["typebox/index.mts", "typebox/index.d.mts", "ajv/index.d.cts", "ajv/index.d.ts", "local-alias/index.js.map", "pi-alias/index.js.map"];
  for (const file of [...keep, ...remove]) write(file);
  prune();
  for (const file of keep) expect(exists(file), file).toBe(true);
  for (const file of remove) expect(exists(file), file).toBe(false);
});

it("keeps the ECharts asset, manifests, license files, documents, and TypeScript", () => {
  pkg("echarts");
  const keep = ["package.json", "dist/package.json", "licenses/LICENSE-d3", "NOTICE", "dist/echarts.min.js", "README.md", "docs/walkthrough", "index.d.ts", "index.ts"];
  const remove = ["index.js", "dist/echarts.js", "dist/echarts.min.js.map"];
  for (const file of [...keep.slice(1), ...remove]) write(`echarts/${file}`);
  prune();
  for (const file of keep) expect(exists(`echarts/${file}`), file).toBe(true);
  for (const file of remove) expect(exists(`echarts/${file}`), file).toBe(false);
});

const assets = [
  "dompurify/dist/purify.min.js", "marked/lib/marked.umd.js", "echarts/dist/echarts.min.js", "echarts/licenses/LICENSE-d3",
  "@tesseract.js-data/eng/4.0.0/eng.traineddata.gz", "@tesseract.js-data/fra/4.0.0/fra.traineddata.gz",
  "mupdf/dist/mupdf-wasm.js", "mupdf/dist/mupdf-wasm.wasm",
];
const core = ".pnpm/tesseract.js@1.0.0/node_modules/tesseract.js-core";
const cores = ["", "-simd", "-relaxedsimd"].flatMap((simd) => ["", "-lstm"].flatMap((lstm) =>
  ["js", "wasm", "wasm.js"].map((ext) => `${core}/tesseract-core${simd}${lstm}.${ext}`),
));
const binaries = ["build/Debug/better_sqlite3.node", "build/Release/better_sqlite3.node", "prebuilds/darwin-arm64.node"].map((file) => `better-sqlite3/${file}`);

describe("gateway guards", () => {
  beforeEach(() => {
    const tess = ".pnpm/tesseract.js@1.0.0/node_modules/tesseract.js";
    pkg(tess, "tesseract.js");
    write(`${tess}/index.js`);
    link("tesseract.js", tess);
    pkg(core, "tesseract.js-core");
    for (const file of [...assets, ...cores]) write(file);
  });

  it.each(binaries)("accepts %s", (binary) => {
    write(binary);
    expect(() => checkGateway(stage)).not.toThrow();
  });

  it("checks Debug before Release and Release before the prebuild", () => {
    for (const binary of binaries) write(binary);
    write(binaries[0], "");
    expect(() => checkGateway(stage)).toThrow(binaries[0]);
    fs.unlinkSync(path.join(modules, binaries[0]));
    write(binaries[1], "");
    expect(() => checkGateway(stage)).toThrow(binaries[1]);
  });

  it("requires a SQLite binary", () => {
    expect(() => checkGateway(stage)).toThrow(/No SQLite binary/);
  });

  it.each([...assets, ...cores])("requires nonempty %s", (file) => {
    write(binaries[2]);
    fs.unlinkSync(path.join(modules, file));
    expect(() => checkGateway(stage)).toThrow(file);
    write(file, "");
    expect(() => checkGateway(stage)).toThrow(file);
  });

  it("rejects a broken link before any file removal", () => {
    pkg("sample");
    write("sample/index.js.map");
    link("sample/broken", "missing");
    expect(() => checkGateway(stage)).toThrow(/Cannot resolve the link/);
    expect(prune).toThrow(/Cannot resolve the link/);
    expect(exists("sample/index.js.map")).toBe(true);
  });

  it("rejects a link outside the gateway", () => {
    link("outside", os.tmpdir());
    expect(() => checkGateway(stage)).toThrow(/outside the gateway/);
  });
});
