import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let home: string;
let root: string;
beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-model-auth-"));
  home = path.join(root, "yoplai");
  await fs.mkdir(home);
  vi.stubEnv("HOME", root);
  vi.stubEnv("YOPLAI_HOME", home);
  vi.stubEnv("YOPLAI_DESKTOP", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("prefers an owned key and keeps the environment path", async () => {
  const { createModelAuth } = await import("./model-auth.js");
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fake-owned" } }));
  vi.stubEnv("OPENAI_API_KEY", "fake-env");
  const readExternal = vi.fn(async () => ({ type: "api_key" as const, key: "fake-external", source: "test" }));
  const { resolveModelAuth } = await createModelAuth({ readExternal });
  expect((await resolveModelAuth("openai"))?.auth.apiKey === "fake-owned").toBe(true);
  expect(readExternal).not.toHaveBeenCalled();
  const env = await createModelAuth({ primaryProvider: "openai", mode: "api_key" });
  await fs.unlink(path.join(home, "auth.json"));
  expect((await env.resolveModelAuth("openai"))?.auth.apiKey === "fake-env").toBe(true);
});

it("refuses key commands and environment references", async () => {
  const { isLiteralKey } = await import("./model-auth.js");
  for (const candidate of ["!cmd", "$VAR", "key${VAR}", "  !cmd"]) expect(isLiteralKey(candidate)).toBe(false);
  expect(isLiteralKey("fake-literal-key")).toBe(true);
});
