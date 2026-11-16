import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectRemoteGateway, disconnectRemoteGateway, linkWithBrowser, type LinkClientDeps } from "./connect.js";
import { createFileRemoteGatewayStore, type RemoteGatewayStore } from "../relay/store.js";

/** The local gateway is a scripted fake. Every address, key, and attempt ID here is synthetic. */
const GATEWAY = "http://127.0.0.1:4000";
const REMOTE = "https://remote.example.test";
const CONSENT = `${REMOTE}/gateway-link?request=req-1`;
const ATTEMPT = "A".repeat(43);
const CONTROL = "C".repeat(43);

type Request = { method: string; route: string; headers: Headers; body: Record<string, unknown> | undefined };

let dir: string;
let store: RemoteGatewayStore;
let requests: Request[];
let answers: Array<Response | Error>;
let lines: string[];
let opened: string[];
let clock: number;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deps = (): Partial<LinkClientDeps> => ({
  gatewayBase: GATEWAY,
  fetch: async (input, init) => {
    const url = new URL(String(input));
    requests.push({ method: init?.method ?? "GET", route: url.pathname, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    const next = answers.shift();
    if (!next) throw new Error("no answer scripted");
    if (next instanceof Error) throw next;
    return next;
  },
  print: (line) => lines.push(line),
  open: (url) => opened.push(url),
  sleep: async (ms) => {
    clock += ms;
  },
  now: () => clock,
});

const started = () => json(201, { attemptId: ATTEMPT, controlToken: CONTROL, expiresAt: new Date(clock + 300_000).toISOString(), consentUrl: CONSENT });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-connect-"));
  store = createFileRemoteGatewayStore(path.join(dir, "remote-gateways.json"));
  requests = [];
  answers = [];
  lines = [];
  opened = [];
  clock = 1_000_000;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("yoplai connect with a browser", () => {
  it("prints the consent address, opens the browser, and waits for the link", async () => {
    answers.push(started(), json(200, { status: "pending" }), json(200, { status: "linked", name: "work" }));
    await expect(linkWithBrowser(REMOTE, { name: "work", openBrowser: true }, deps())).resolves.toEqual({ name: "work" });
    expect(requests[0]).toMatchObject({ method: "POST", route: "/api/relay/link/start", body: { remote: REMOTE, name: "work" } });
    expect(requests[0].headers.get("origin")).toBeNull();
    expect(requests[1]).toMatchObject({ method: "GET", route: `/api/relay/link/status/${ATTEMPT}` });
    expect(requests[1].headers.get("x-link-control")).toBe(CONTROL);
    expect(lines.join("\n")).toContain(CONSENT);
    expect(opened).toEqual([CONSENT]);
    // The CLI never sees a key, a code, or a state, so it prints none of the control values either.
    expect(lines.join("\n")).not.toContain(CONTROL);
    expect(lines.join("\n")).not.toContain(ATTEMPT);
  });

  it("opens no browser with --no-browser and still prints the address", async () => {
    answers.push(started(), json(200, { status: "linked", name: "work" }));
    await linkWithBrowser(REMOTE, { name: "work", openBrowser: false }, deps());
    expect(opened).toEqual([]);
    expect(lines.join("\n")).toContain(CONSENT);
  });

  it("links a single-user remote with no page", async () => {
    answers.push(json(200, { status: "linked", name: "open" }));
    await expect(linkWithBrowser(REMOTE, { name: "open", openBrowser: true }, deps())).resolves.toEqual({ name: "open" });
    expect(opened).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("fails with the plain words of the gateway when it refuses the start", async () => {
    answers.push(json(409, { error: "link_callback_unavailable", message: "The browser link needs this gateway to listen on 127.0.0.1." }));
    await expect(linkWithBrowser(REMOTE, { openBrowser: true }, deps())).rejects.toThrow("listen on 127.0.0.1");
  });

  it("tells the user to start the gateway when it does not answer", async () => {
    answers.push(new Error("ECONNREFUSED"));
    await expect(linkWithBrowser(REMOTE, { openBrowser: true }, deps())).rejects.toThrow(/Start it with "yoplai gateway"/);
  });

  it("reports a refusal on the remote", async () => {
    answers.push(started(), json(200, { status: "denied", message: "refused" }));
    await expect(linkWithBrowser(REMOTE, { openBrowser: false }, deps())).rejects.toThrow("refused on the remote gateway");
  });

  it("tells the user to revoke at the owner page after an unconfirmed key", async () => {
    const message = `The remote gateway may have made a key that this gateway did not receive. Revoke it on the remote page ${REMOTE}/account/gateway-links, then start a new link.`;
    answers.push(started(), json(200, { status: "uncertain", message, ownerPageUrl: `${REMOTE}/account/gateway-links` }));
    await expect(linkWithBrowser(REMOTE, { openBrowser: false }, deps())).rejects.toThrow("/account/gateway-links");
  });

  it("prints the recovery note of a fresh start", async () => {
    answers.push(json(201, { attemptId: ATTEMPT, controlToken: CONTROL, expiresAt: new Date(clock + 300_000).toISOString(), consentUrl: CONSENT, recoveryNote: "Revoke the old key first." }), json(200, { status: "linked", name: "work" }));
    await linkWithBrowser(REMOTE, { name: "work", openBrowser: false }, deps());
    expect(lines).toContain("Revoke the old key first.");
  });

  it("stops after the attempt expires", async () => {
    answers.push(started(), ...Array.from({ length: 400 }, () => json(200, { status: "pending" })));
    await expect(linkWithBrowser(REMOTE, { openBrowser: false }, deps())).rejects.toThrow("expired");
  });
});

describe("yoplai connect with a token", () => {
  it("refuses a plain http address that is not a literal loopback address", async () => {
    await expect(connectRemoteGateway("http://gateway.example.com", { token: "t" }, store)).rejects.toThrow(/https/);
    await expect(connectRemoteGateway("http://localhost:4100", { token: "t" }, store)).rejects.toThrow(/https/);
    await expect(connectRemoteGateway("https://gateway.example.com/app", { token: "t" }, store)).rejects.toThrow(/origin|address/i);
    expect(store.list()).toEqual([]);
  });

  it("checks the token with one call and saves it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(200, []));
    try {
      const gateway = await connectRemoteGateway("https://gateway.example.com/", { name: "work", token: "synthetic-token" }, store);
      expect(gateway).toEqual({ name: "work", url: "https://gateway.example.com", token: "synthetic-token" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(store.list()[0]).toMatchObject({ name: "work", token: "synthetic-token" });
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("yoplai disconnect", () => {
  const managed = { linkId: "link-1", account: { email: "user@example.test", name: null }, deviceLabel: "Laptop", expiresAt: null, linkedAt: "2026-01-01T00:00:00.000Z" };

  it("revokes a browser link through the local gateway and does not touch the store itself", async () => {
    store.save({ name: "work", url: REMOTE, token: "synthetic-key", managed });
    answers.push(json(200, { name: "work", revoked: "remote" }));
    const remove = vi.spyOn(store, "remove");
    const removeChecked = vi.spyOn(store, "removeIfGeneration");
    await expect(disconnectRemoteGateway("work", {}, store, deps())).resolves.toContain("Revoked the key");
    expect(requests[0]).toMatchObject({ route: "/api/relay/link/disconnect", body: { name: "work", localOnly: false } });
    expect(remove).not.toHaveBeenCalled();
    expect(removeChecked).not.toHaveBeenCalled();
  });

  it("keeps a browser link while the local gateway is down", async () => {
    store.save({ name: "work", url: REMOTE, token: "synthetic-key", managed });
    answers.push(new Error("ECONNREFUSED"));
    await expect(disconnectRemoteGateway("work", {}, store, deps())).rejects.toThrow(/--local-only/);
    expect(store.list()).toHaveLength(1);
  });

  it("removes a browser link from this computer only on request, with the remote key warning", async () => {
    store.save({ name: "work", url: REMOTE, token: "synthetic-key", managed });
    answers.push(new Error("ECONNREFUSED"));
    const message = await disconnectRemoteGateway("work", { localOnly: true }, store, deps());
    expect(message).toContain("remote key stays valid");
    expect(store.list()).toEqual([]);
  });

  it("removes a manual link with no gateway call when the gateway is down", async () => {
    store.save({ name: "manual", url: REMOTE, token: "manual-token" });
    answers.push(new Error("ECONNREFUSED"));
    await expect(disconnectRemoteGateway("manual", {}, store, deps())).resolves.toBe('Removed "manual" from this computer.');
    expect(store.list()).toEqual([]);
  });

  it("reports a gateway that failed to revoke and an unknown name", async () => {
    store.save({ name: "work", url: REMOTE, token: "synthetic-key", managed });
    answers.push(json(502, { error: "revoke_failed", message: "The remote gateway did not confirm the revoke." }));
    await expect(disconnectRemoteGateway("work", {}, store, deps())).rejects.toThrow("did not confirm the revoke");
    await expect(disconnectRemoteGateway("missing", {}, store, deps())).rejects.toThrow('No linked gateway named "missing"');
  });
});
