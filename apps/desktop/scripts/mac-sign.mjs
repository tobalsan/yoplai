import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { developerIdRequirement } from "./mac-release.mjs";

const MACH_O_MAGIC = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe,
  0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);

function* machOFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* machOFiles(file);
    if (!entry.isFile()) continue;
    const fd = fs.openSync(file, "r");
    const header = Buffer.alloc(4);
    try {
      if (fs.readSync(fd, header, 0, 4, 0) !== 4 || !MACH_O_MAGIC.has(header.readUInt32BE())) continue;
    } finally {
      fs.closeSync(fd);
    }
    // Java class files share a magic number with universal Mach-O files.
    if (execFileSync("file", ["-b", file], { encoding: "utf8" }).startsWith("Mach-O")) yield file;
  }
}

export function checkMachOSignatures(app, team) {
  const requirement = developerIdRequirement(team);
  const failures = [];
  let count = 0;
  for (const file of machOFiles(app)) {
    count++;
    const relative = path.relative(app, file);
    const verification = spawnSync("codesign", ["--verify", "--strict", "--all-architectures", "-R", requirement, file]);
    if (verification.status !== 0) failures.push(`${relative}: Developer ID signature check failed.`);
    const arches = execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim().split(/\s+/);
    for (const arch of arches) {
      const display = spawnSync("codesign", ["--display", "--verbose=4", "--arch", arch, file], { encoding: "utf8" });
      const details = display.stderr ?? "";
      const flags = details.match(/\bflags=0x([\da-f]+)/i)?.[1];
      if (display.status !== 0 || !flags || !(parseInt(flags, 16) & 0x10000) || !/^Timestamp=.+$/m.test(details)) {
        failures.push(`${relative} (${arch}): The signature needs the runtime flag and a secure timestamp.`);
      }
    }
  }
  if (!count) throw new Error("The app contains no Mach-O files.");
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(`Developer ID signature check: ${count} Mach-O files.`);
}

export default async function sign(options, packager) {
  const binaries = new Set(machOFiles(options.app));
  // The app signature covers data files. Only code and bundles need separate signatures.
  const ignore = (file) => {
    if (file === options.app || fs.lstatSync(file).isDirectory()) return false;
    return !binaries.has(fs.realpathSync(file));
  };
  // Call the default signer before electron-builder submits the app.
  await packager.doSign({ ...options, ignore }, {}, { name: options.identity, hash: options.identity });
  checkMachOSignatures(options.app, process.env.YOPLAI_SIGNING_TEAM);
}
