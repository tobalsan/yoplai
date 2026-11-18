import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: string;
let home: string;
beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "model-access-"));
  home = path.join(root, "yoplai");
  await fs.mkdir(home);
  vi.stubEnv("HOME", root);
  vi.stubEnv("YOPLAI_HOME", home);
  vi.stubEnv("YOPLAI_DESKTOP", "1");
  vi.stubEnv("YOPLAI_DEV", "1");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("checks a new key alone before replacement", async () => {
  const { createModelAuth } = await import("./model-auth.js");
  const { createModelAccessRoutes } = await import("./model-access.js");
  const file = path.join(home, "auth.json");
  await fs.writeFile(file, JSON.stringify({ openai: { type: "api_key", key: "fake-old-key" } }));
  const checkKey = vi.fn(async (_provider: string, key: string) => key === "fake-new-key");
  const routes = createModelAccessRoutes(home, { createAuth: createModelAuth, checkKey });
  const post = (body: Record<string, unknown>) => routes.request("/api-key", { method: "POST", body: JSON.stringify({ provider: "openai", ...body }) });
  for (const key of ["!cmd", "$VAR", "${VAR}"]) expect((await post({ key })).status).toBe(400);
  expect((await post({ key: "fake-new-key" })).status).toBe(409);
  expect(checkKey).not.toHaveBeenCalled();
  expect((await post({ key: "fake-bad-key", replace: true })).status).toBe(422);
  expect((await post({ key: "fake-new-key", checkOnly: true })).status).toBe(200);
  expect(JSON.parse(await fs.readFile(file, "utf8")).openai.key === "fake-old-key").toBe(true);
  const saved = await post({ key: "fake-new-key", replace: true });
  expect(await saved.json()).toMatchObject({ provider: "openai", ready: true, saved: true });
  expect(JSON.parse(await fs.readFile(file, "utf8")).openai.key === "fake-new-key").toBe(true);
  expect((await (await routes.request("/")).text()).includes("fake-new-key")).toBe(false);
  expect((await routes.request("/openai", { method: "DELETE" })).status).toBe(204);
});

it("opens an approved browser URL and drops prompts on either abort signal", async () => {
  const { createOAuthAttempts } = await import("./oauth-attempts.js");
  const opener = vi.fn(async (_url: string) => {});
  const prompt = new AbortController();
  let interaction!: AuthInteraction;
  let saves = 0;
  const login = vi.fn(async (_provider, input: AuthInteraction) => {
    interaction = input;
    expect(await input.prompt({ type: "select", message: "test", options: [{ id: "browser", label: "Browser" }] })).toBe("browser");
    input.notify({ type: "auth_url", url: "https://auth.openai.com/login?state=fake-state" });
    try {
      await input.prompt({ type: "manual_code", message: "test", signal: prompt.signal });
      input.signal?.throwIfAborted();
      saves += 1;
    } catch {
      if (!input.signal?.aborted && !prompt.signal.aborted) throw new Error("fake-error");
    }
  });
  const attempts = createOAuthAttempts(login, opener);
  const { handle } = attempts.start("openai-codex");
  await vi.waitFor(() => expect(attempts.status(handle)?.state).toBe("waiting-code"));
  expect(attempts.busy("openai-codex")).toBe(true);
  expect(opener).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(attempts.status(handle)).includes("fake-state")).toBe(false);
  attempts.answer(handle, "fake-code");
  await vi.waitFor(() => expect(attempts.status(handle)?.state).toBe("done"));
  expect(saves).toBe(1);
  await expect(interaction.prompt({ type: "manual_code", message: "test" })).rejects.toThrow();
  const cancelled = attempts.start("openai-codex");
  await vi.waitFor(() => expect(attempts.status(cancelled.handle)?.state).toBe("waiting-code"));
  expect(attempts.cancel(cancelled.handle)?.state).toBe("cancelled");
  await vi.waitFor(() => expect(attempts.busy("openai-codex")).toBe(false));
  expect(saves).toBe(1);
  const callback = attempts.start("openai-codex");
  await vi.waitFor(() => expect(attempts.status(callback.handle)?.state).toBe("waiting-code"));
  prompt.abort();
  expect(attempts.answer(callback.handle, "fake-late-code")).toBeUndefined();
  await vi.waitFor(() => expect(attempts.status(callback.handle)?.state).toBe("done"));
  expect(saves).toBe(1);
});

it("refuses another active attempt and requires the Claude warning", async () => {
  const { createModelAuth } = await import("./model-auth.js");
  const { createModelAccessRoutes } = await import("./model-access.js");
  const auth = await createModelAuth({ home });
  const login = vi.spyOn(auth.runtime, "login").mockImplementation(async (_provider, _type, io) => {
    await io.prompt({ type: "manual_code", message: "test" });
    throw new Error("fake-provider-private-error");
  });
  const routes = createModelAccessRoutes(home, { createAuth: async () => auth, open: async () => {} });
  const start = (provider: string, body = {}) => routes.request(`/oauth/${provider}`, { method: "POST", body: JSON.stringify(body) });
  expect((await start("anthropic")).status).toBe(409);
  expect(login).not.toHaveBeenCalled();
  const res = await start("anthropic", { warningAccepted: true });
  expect(res.status).toBe(202);
  const { handle } = await res.json();
  expect((await start("anthropic", { warningAccepted: true })).status).toBe(409);
  expect(login).toHaveBeenCalledTimes(1);
  const answer = await routes.request(`/oauth/attempts/${handle}/answer`, { method: "POST", body: '{"code":"fake-code"}' });
  expect(answer.status).toBe(200);
  const status = async () => (await routes.request(`/oauth/attempts/${handle}`)).text();
  await vi.waitFor(async () => expect(await status()).toContain('"failed"'));
  expect((await status()).includes("fake-provider-private-error")).toBe(false);
});

it("expires attempts after ten minutes and refuses other browser hosts", async () => {
  const { createOAuthAttempts } = await import("./oauth-attempts.js");
  vi.useFakeTimers();
  const opener = vi.fn(async (_url: string) => {});
  const attempts = createOAuthAttempts(async (provider, io) => {
    if (provider === "anthropic") io.notify({ type: "auth_url", url: "https://claude.ai.example.test/?state=fake-state" });
    await io.prompt({ type: "manual_code", message: "test" });
  }, opener);
  const wrong = attempts.start("anthropic");
  const expired = attempts.start("openai-codex");
  await vi.advanceTimersByTimeAsync(1);
  expect(attempts.status(wrong.handle)?.state).toBe("failed");
  await vi.advanceTimersByTimeAsync(599_999);
  expect(attempts.status(expired.handle)).toMatchObject({ state: "failed", message: "The sign-in time expired. Start again." });
  expect(attempts.answer(expired.handle, "fake-late-code")).toBeUndefined();
  expect(opener).not.toHaveBeenCalled();
});
