import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const auditedTypeScript = new Set(["typebox@1.3.27", "ajv@8.20.0"]);
const sqliteBinaries = [
  "build/Debug/better_sqlite3.node",
  "build/Release/better_sqlite3.node",
  "prebuilds/darwin-arm64.node",
];
const sqliteBuildDirs = ["deps", "src", "build/Release/obj.target", "build/Release/obj"];
const otherPlatform = /^(?:(?:linux|linuxmusl|win32)(?:-(?:arm64|x64))?|darwin-x64)(?:\.node)?$/;
const typeScript = /\.(?:ts|mts|cts)$/;
const declaration = /\.d\.(?:ts|mts|cts)$/;

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else yield { entry, file };
  }
}

function scanLinks(stage) {
  const root = fs.realpathSync(stage);
  const modules = path.join(root, "node_modules");
  if (!fs.lstatSync(modules).isDirectory()) throw new Error("Expected a node_modules directory.");
  const targets = new Set();
  for (const { entry, file } of walk(modules)) {
    if (!entry.isSymbolicLink()) continue;
    let target;
    try {
      target = fs.realpathSync(file);
    } catch (cause) {
      throw new Error(`Cannot resolve the link: ${file}`, { cause });
    }
    if (!inside(root, target)) throw new Error(`The link points outside the gateway: ${file}`);
    targets.add(target);
  }
  return targets;
}

function protectedFile(parts) {
  return parts.at(-1) === "package.json" || parts.some((name) =>
    /^licenses$/i.test(name) || /^(?:license|licence|notice|copying)/i.test(name),
  );
}

function documentFile(parts) {
  return parts.some((name) => /^(?:docs?|readme|changelog|history|contributing|security|code_of_conduct|keys)$/i.test(name))
    || /\.(?:md|markdown|mdx|txt|rst|adoc|pdf|rtf|html?)$/i.test(parts.at(-1));
}

function shouldPrune(phase, pkg, parts, file) {
  const name = parts.at(-1);
  const relative = parts.join("/");
  if (protectedFile(parts)) return false;
  if (phase === "before-rebuild") {
    return (pkg.name === "better-sqlite3" || pkg.name === "@earendil-works/pi-tui")
      && ["prebuilds", "native"].includes(parts[0])
      && parts.slice(1).some((part) => otherPlatform.test(part))
      && !documentFile(parts);
  }
  if (name.endsWith(".map")) return true;
  if (pkg.name.startsWith("@yoplai/") || pkg.name.startsWith("@earendil-works/")) return false;
  if (documentFile(parts)) return false;
  if (pkg.name === "echarts") return relative !== "dist/echarts.min.js" && !typeScript.test(name);
  if (pkg.name === "better-sqlite3" && !sqliteBinaries.includes(relative)) {
    if (sqliteBuildDirs.some((dir) => relative.startsWith(`${dir}/`))) return true;
    if (/\.(?:a|o|mk)$/.test(name) || name === "Makefile" || name === "binding.gyp") return true;
  }
  if (!auditedTypeScript.has(`${pkg.name}@${pkg.version}`)) return false;
  if (declaration.test(name)) return true;
  if (!typeScript.test(name)) return false;
  const base = file.replace(typeScript, "");
  return [".js", ".mjs", ".cjs"].some((ext) => fs.statSync(base + ext, { throwIfNoEntry: false })?.isFile());
}

export function pruneGateway(stage, phase) {
  if (phase !== "before-rebuild" && phase !== "after-rebuild") throw new Error(`Unknown prune phase: ${phase}`);
  const targets = scanLinks(stage);
  const modules = path.join(fs.realpathSync(stage), "node_modules");
  const packages = new Map();
  for (const { entry, file } of walk(modules)) {
    if (!entry.isFile() || targets.has(file)) continue;
    // A manifest inside a package does not change the package name.
    const parts = file.split(path.sep);
    const start = parts.lastIndexOf("node_modules") + 1;
    const end = start + (parts[start].startsWith("@") ? 2 : 1);
    if (parts.length <= end) continue;
    const root = parts.slice(0, end).join(path.sep);
    if (!packages.has(root)) {
      const manifest = path.join(root, "package.json");
      packages.set(root, fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : null);
    }
    const pkg = packages.get(root);
    if (typeof pkg?.name === "string" && shouldPrune(phase, pkg, parts.slice(end), file)) fs.unlinkSync(file);
  }
}

const requiredAssets = [
  "dompurify/dist/purify.min.js",
  "marked/lib/marked.umd.js",
  "echarts/dist/echarts.min.js",
  "echarts/licenses/LICENSE-d3",
  "@tesseract.js-data/eng/4.0.0/eng.traineddata.gz",
  "@tesseract.js-data/fra/4.0.0/fra.traineddata.gz",
  "mupdf/dist/mupdf-wasm.js",
  "mupdf/dist/mupdf-wasm.wasm",
];

function requireFile(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size === 0) throw new Error(`The required file is missing or empty: ${file}`);
}

export function checkGateway(stage) {
  scanLinks(stage);
  const modules = path.join(stage, "node_modules");
  const sqlite = path.join(modules, "better-sqlite3");
  const binary = sqliteBinaries.find((file) => fs.existsSync(path.join(sqlite, file)));
  if (!binary) throw new Error(`No SQLite binary in ${sqlite}.`);
  requireFile(path.join(sqlite, binary));
  for (const asset of requiredAssets) requireFile(path.join(modules, asset));

  const gatewayRequire = createRequire(path.resolve(stage, "package.json"));
  const tesseractRequire = createRequire(gatewayRequire.resolve("tesseract.js"));
  const core = path.dirname(tesseractRequire.resolve("tesseract.js-core/package.json"));
  if (!inside(fs.realpathSync(stage), fs.realpathSync(core))) throw new Error(`The OCR core is outside the gateway: ${core}`);
  for (const simd of ["", "-simd", "-relaxedsimd"]) {
    for (const lstm of ["", "-lstm"]) {
      for (const ext of ["js", "wasm", "wasm.js"]) requireFile(path.join(core, `tesseract-core${simd}${lstm}.${ext}`));
    }
  }
}

export function reportGatewaySize(stage) {
  const root = path.join(stage, "node_modules");
  const files = [];
  let bytes = 0;
  for (const { entry, file } of walk(root)) {
    if (!entry.isFile()) continue;
    const size = fs.statSync(file).size;
    bytes += size;
    files.push({ size, file: path.relative(root, file) });
  }
  console.log(`Gateway node_modules: ${bytes} bytes in ${files.length} files.`);
  files.sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
  for (const { size, file } of files.slice(0, 30)) console.log(`  ${size}\t${file}`);
}
