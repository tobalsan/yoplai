import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "packaged-check.mjs");

describe("packaged-check", () => {
  it("accepts one app without a reference app", () => {
    // A missing app bundle stops the check before any gateway or Docker call.
    const result = spawnSync("node", [script, "/nonexistent/Yoplai.app"], { encoding: "utf8", timeout: 60_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("Specify");
  });

  it("asks for an app when none is given", () => {
    const result = spawnSync("node", [script], { encoding: "utf8", timeout: 60_000 });
    expect(result.stderr).toContain("Specify the app to check");
  });
});
