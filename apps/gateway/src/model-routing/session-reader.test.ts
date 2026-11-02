import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readRoutingSessions } from "./session-reader.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it("reads root and every user's histories, including legacy names, without retaining text", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "routing-reader-"));
  dirs.push(home);
  const lock = {
    version: 1, kind: "usual", mode: "shadow", provider: "openai", model: "usual",
    category: "work", score: 0.7, tableVersion: "v1", reason: "score<0.8",
    decidedAt: "2026-11-02T00:00:00.000Z",
  };
  for (const [dir, file, persisted] of [
    ["history", "agent-root.jsonl", true],
    ["sessions/users/alice/history", "agent-alice.jsonl", true],
    ["sessions/users/bob/history", "agent-bob.jsonl", false],
  ] as const) {
    await fs.mkdir(path.join(home, dir), { recursive: true });
    const user = { type: "history", role: "user", timestamp: 1793577600000,
      ...(persisted ? { agentId: "agent", sessionId: file.slice(6, -6) } : {}),
      content: [{ type: "text", text: "PRIVATE-MESSAGE-CANARY" }] };
    await fs.writeFile(path.join(home, dir, file), [
      JSON.stringify(user),
      JSON.stringify({ type: "history", role: "assistant", timestamp: 1793577600001,
        content: [{ type: "text", text: "PRIVATE-TOKEN-CANARY" }], meta: { provider: "openai", model: "usual", accountRef: "PRIVATE-ACCOUNT-CANARY" } }),
      JSON.stringify({ type: "meta", key: "modelRoute", value: lock }),
      JSON.stringify({ type: "meta", key: "modelRouteAttempt", value: { v: 99 } }),
      "{broken",
    ].join("\n"));
  }
  const sessions = await readRoutingSessions(home, ["agent"]);
  expect(sessions.map(({ owner, agent, session, lockCount, invalidLineCount }) =>
    ({ owner, agent, session, lockCount, invalidLineCount })).sort((a,b) => a.owner.localeCompare(b.owner))).toEqual([
    { owner: "alice", agent: "agent", session: "alice", lockCount: 1, invalidLineCount: 2 },
    { owner: "bob", agent: "agent", session: "bob", lockCount: 1, invalidLineCount: 2 },
    { owner: "single-user", agent: "agent", session: "root", lockCount: 1, invalidLineCount: 2 },
  ]);
  expect(sessions[0].entries).toEqual([
    { role: "user", timestamp: 1793577600000 },
    { role: "assistant", timestamp: 1793577600001, provider: "openai", model: "usual" },
  ]);
  expect(JSON.stringify(sessions)).not.toContain("PRIVATE-");
});

it("skips impossible routing and history timestamps instead of retaining corrupt records", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "routing-reader-epoch-"));
  dirs.push(home);
  await fs.mkdir(path.join(home, "history"));
  await fs.writeFile(path.join(home, "history/agent-epoch.jsonl"), [
    JSON.stringify({ type: "history", role: "user", timestamp: 1e100 }),
    JSON.stringify({ type: "history", role: "user", timestamp: 1793577600000 }),
    JSON.stringify({ type: "meta", key: "modelRouteAttempt", value: {
      v: 1, at: 1e100, userMessageAt: 1793577600000, mode: "shadow", tableVersion: "v1", threshold: 0.8, seq: 1,
      predicate: { result: "no", probability: 0.1, latencyMs: 2 }, decision: "none", noLockReason: "predicate-no", actual: "openai/usual", totalMs: 3,
    } }),
  ].join("\n"));
  const [session] = await readRoutingSessions(home, ["agent"]);
  expect(session.invalidLineCount).toBe(2);
  expect(session.attempts).toEqual([]);
  expect(session.entries).toEqual([{ role: "user", timestamp: 1793577600000 }]);
});

it("retains every valid lock's mode and version evidence while selecting the last lock", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "routing-reader-locks-"));
  dirs.push(home);
  await fs.mkdir(path.join(home, "history"));
  const lock = {
    version: 1, kind: "usual", provider: "openai", model: "usual", category: "work", score: 0.7,
    reason: "score<0.8", decidedAt: "2026-11-02T00:00:00.000Z",
  };
  await fs.writeFile(path.join(home, "history/agent-locks.jsonl"), [
    JSON.stringify({ type: "meta", key: "modelRoute", value: { ...lock, mode: "enforce", tableVersion: "v0" } }),
    JSON.stringify({ type: "meta", key: "modelRoute", value: { ...lock, mode: "shadow", tableVersion: "v1" } }),
  ].join("\n"));
  const [session] = await readRoutingSessions(home, ["agent"]);
  expect(session.locks?.map(({ mode, tableVersion }) => ({ mode, tableVersion }))).toEqual([
    { mode: "enforce", tableVersion: "v0" }, { mode: "shadow", tableVersion: "v1" },
  ]);
  expect(session.lock).toMatchObject({ mode: "shadow", tableVersion: "v1" });
  expect(session.lockCount).toBe(2);
});
