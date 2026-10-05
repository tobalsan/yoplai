import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackPairingService } from "./pairing.js";

describe("Slack pairing", () => {
  let dataDir: string;
  let service: SlackPairingService;
  const info = vi.fn();
  const client = { users: { info } };
  const user = { id: "existing-user", email: " Person@Example.com " };
  const tokenFrom = (link: string) => new URL(link).pathname.split("/").at(-1)!;
  const profile = (email: string | undefined = "person@example.com") => ({ ok: true, user: { id: "U1", name: "person", profile: { email } } });

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slack-pairing-"));
    service = new SlackPairingService(dataDir, "https://yoplai.test");
    info.mockReset().mockResolvedValue(profile());
  });
  afterEach(async () => {
    vi.useRealTimers();
    service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("pairs a matching existing user, scopes workspace/user and persists across restart", async () => {
    const token = tokenFrom(await service.issue("T1", "U1", client));
    expect(service.inspect(token)).toEqual({ workspaceId: "T1", slackUserId: "U1", identity: "person <person@example.com>" });
    await service.redeem(token, user);
    expect(info).toHaveBeenCalledTimes(2);
    expect(service.resolve("T1", "U1")).toBe(user.id);
    expect(service.resolve("T2", "U1")).toBeUndefined();
    expect(service.resolve("T1", "U2")).toBeUndefined();
    service.close();
    service = new SlackPairingService(dataDir, "https://yoplai.test");
    expect(service.resolve("T1", "U1")).toBe(user.id);
    await expect(service.redeem(token, user)).rejects.toThrow("already been used");
  });

  it("uses fresh Slack email and refuses mismatch without consuming the token", async () => {
    const token = tokenFrom(await service.issue("T1", "U1", client));
    info.mockResolvedValue(profile("changed@example.com"));
    await expect(service.redeem(token, user)).rejects.toThrow("This link was created for another Slack account");
    expect(service.resolve("T1", "U1")).toBeUndefined();
    info.mockResolvedValue(profile());
    await service.redeem(token, user);
  });

  it("redeems an unexpired durable token after startup registers the workspace client", async () => {
    const token = tokenFrom(await service.issue("T1", "U1", client));
    service.close();
    service = new SlackPairingService(dataDir, "https://yoplai.test");
    await expect(service.redeem(token, user)).rejects.toThrow("unavailable");
    service.registerClient("T1", client);
    await service.redeem(token, user);
    expect(service.resolve("T1", "U1")).toBe(user.id);
  });

  it.each(["missing", "failure", "wrong-user"])("refuses %s Slack identity", async (kind) => {
    const token = tokenFrom(await service.issue("T1", "U1", client));
    if (kind === "failure") info.mockRejectedValue(new Error("Slack unavailable"));
    else if (kind === "wrong-user") info.mockResolvedValue({ ...profile(), user: { ...profile().user, id: "U2" } });
    else info.mockResolvedValue({ ok: true, user: { id: "U1", profile: {} } });
    await expect(service.redeem(token, user)).rejects.toThrow(/unavailable/);
    expect(service.resolve("T1", "U1")).toBeUndefined();
  });

  it("rejects expired tokens without contacting Slack", async () => {
    vi.useFakeTimers();
    const token = tokenFrom(await service.issue("T1", "U1", client));
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await expect(service.redeem(token, user)).rejects.toThrow("expired");
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("consumes tokens once under concurrent redemption", async () => {
    const token = tokenFrom(await service.issue("T1", "U1", client));
    const results = await Promise.allSettled([service.redeem(token, user), service.redeem(token, user)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(service.redeem(token, user)).rejects.toThrow("already been used");
  });

  it("bounds a hung Slack lookup and permits a later retry", async () => {
    vi.useFakeTimers();
    const token = tokenFrom(await service.issue("T1", "U1", client));
    info.mockImplementation(() => new Promise(() => {}));
    const pending = expect(service.redeem(token, user)).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(service.resolve("T1", "U1")).toBeUndefined();
    info.mockResolvedValue(profile());
    await service.redeem(token, user);
  });
});
