import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectRemoteGateway, linkWithBrowser } from "../cli/connect.js";
import { createFileRemoteGatewayStore } from "./store.js";

/**
 * Two real gateways in two processes with two isolated homes. The remote has multi-user sign-in with a synthetic
 * email and password account. The local gateway has the relay. The test plays the browser: it signs in on the
 * remote, approves, and posts the callback to the local gateway. It copies no key by hand. Nothing here is a real
 * account, a real key, a browser, an external service, or a protected port.
 */

const fixture = fileURLToPath(new URL("./link-gateway.fixture.ts", import.meta.url));
const gatewayDir = fileURLToPath(new URL("../..", import.meta.url));
const PASSWORD = "synthetic-password-for-isolated-test";

type Running = { child: ChildProcess; port: number; home: string; output: () => string };

let tmpDir: string;
let remote: Running;
let local: Running;
const started: Running[] = [];
let cookie: string;
let remoteBase: string;
/** The address that the local gateway links to. It forwards to the remote. */
let linkedRemote: string;
let forwarder: Awaited<ReturnType<typeof startForwarder>>;
let localBase: string;
let localStorePath: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function startGateway(name: string, mode: "remote" | "local"): Promise<Running> {
  const port = await freePort();
  const home = path.join(tmpDir, name);
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", fixture], {
    cwd: gatewayDir,
    detached: true,
    env: { ...process.env, FIXTURE_HOME: home, FIXTURE_PORT: String(port), FIXTURE_MODE: mode, YOPLAI_HOME: "", NODE_ENV: "test" },
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} gateway did not start in time`)), 80_000);
    child.stdout?.on("data", () => {
      if (output.includes(`READY ${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} gateway exited with ${code}`));
    });
  });
  const running = { child, port, home, output: () => output };
  started.push(running);
  return running;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(200);
  }
}

const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;

async function signUp(email: string): Promise<string> {
  const response = await fetch(`${remoteBase}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: remoteBase },
    body: JSON.stringify({ email, name: "Synthetic User", password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

const startLink = (name = "hub", origin?: string, remoteAddress = linkedRemote) =>
  fetch(`${localBase}/api/relay/link/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ remote: remoteAddress, name }),
  });

type Attempt = { attemptId: string; controlToken: string; consentUrl: string };
const attemptStatus = async (attempt: Attempt) =>
  json<{ status: string }>(await fetch(`${localBase}/api/relay/link/status/${attempt.attemptId}`, { headers: { "x-link-control": attempt.controlToken } }));

/** What the browser does after the user clicks Approve or Refuse on the consent page of the remote. */
async function browser(consentUrl: string, action: "approve" | "deny"): Promise<{ status: number; body: Record<string, unknown> }> {
  const requestId = new URL(consentUrl).searchParams.get("request")!;
  // The consent page is on the origin that the local gateway linked to. The browser reaches the same remote.
  expect(new URL(consentUrl).origin).toBe(linkedRemote);
  return finishInBrowser(requestId, action);
}

async function finishInBrowser(requestId: string, action: "approve" | "deny"): Promise<{ status: number; body: Record<string, unknown> }> {
  const view = await fetch(`${remoteBase}/api/auth/gateway-link/requests/${requestId}`, { headers: { Cookie: cookie } });
  expect(view.status).toBe(200);
  const { nonce } = await json<{ nonce: string }>(view);
  const answered = await fetch(`${remoteBase}/api/auth/gateway-link/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: remoteBase },
    body: JSON.stringify({ requestId, nonce }),
  });
  expect(answered.status).toBe(200);
  const { redirectUrl } = await json<{ redirectUrl: string }>(answered);
  const target = new URL(redirectUrl);
  // The remote sends the browser to the local gateway, to its callback page, with the code in the fragment.
  expect(`${target.origin}${target.pathname}`).toBe(`http://127.0.0.1:${local.port}/api/relay/link/callback`);
  expect((await fetch(`${target.origin}${target.pathname}`)).status).toBe(200);
  const params = new URLSearchParams(target.hash.slice(1));
  const completed = await fetch(`${localBase}/api/relay/link/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${local.port}` },
    body: JSON.stringify(action === "approve" ? { code: params.get("code"), state: params.get("state") } : { error: params.get("error"), state: params.get("state") }),
  });
  return { status: completed.status, body: await json(completed) };
}

type Row = { name: string; remote: string; kind: string; account: string | null; deviceLabel: string | null; linkId: string | null; keyState: string; connection: string };
const rows = async () => (await json<{ gateways: Row[] }>(await fetch(`${localBase}/api/relay/link/metadata`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))).gateways;

/** The key is read from the 0600 store of the local gateway, only to check that it works. The test prints it nowhere. */
async function storedKey(): Promise<string> {
  const saved = JSON.parse(await fs.readFile(localStorePath, "utf8")) as Array<{ name: string; token?: string }>;
  return saved.find((item) => item.name === "hub")!.token!;
}

const me = async (key: string) => (await fetch(`${remoteBase}/api/me`, { headers: { Authorization: `Bearer ${key}` } })).status;
const deviceStates = async () => json<Array<{ name: string; connected: boolean; status: string }>>(await fetch(`${localBase}/api/relay/device-links`));

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-link-http-"));
  [remote, local] = await Promise.all([startGateway("remote", "remote"), startGateway("local", "local")]);
  remoteBase = `http://127.0.0.1:${remote.port}`;
  localBase = `http://127.0.0.1:${local.port}`;
  localStorePath = path.join(local.home, ".yoplai", "remote-gateways.json");
  forwarder = await startForwarder();
  linkedRemote = forwarder.base;
  cookie = await signUp("alice@example.test");
}, 120_000);

afterAll(async () => {
  forwarder?.close();
  for (const running of started) if (running.child.pid) process.kill(-running.child.pid, "SIGTERM");
  await sleep(300);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * A forwarder between the local gateway and the remote. The local gateway links to this address, so every request and
 * the device socket pass through it. It names a new client address on each request, as a reverse proxy does, so the
 * remote start limit of five a minute for each source does not stop a suite that links many times. It can also pass
 * a token request to the remote and then drop the answer, which is how a lost first exchange looks.
 */
async function startForwarder() {
  const state = { dropTokenAnswer: false, dropped: 0 };
  let counter = 0;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const headers: Record<string, string> = { accept: "application/json", "x-forwarded-for": `10.1.${(++counter >> 8) & 255}.${counter & 255}` };
        for (const name of ["content-type", "authorization"]) {
          const value = request.headers[name];
          if (typeof value === "string") headers[name] = value;
        }
        const upstream = await fetch(`${remoteBase}${request.url}`, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.concat(chunks),
          redirect: "manual",
        });
        if (state.dropTokenAnswer && request.url === "/api/auth/gateway-link/token") {
          state.dropped += 1;
          request.socket.destroy();
          return;
        }
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      })().catch(() => request.socket.destroy());
    });
  });
  // The device link is a WebSocket. The forwarder copies the upgrade request and then the bytes in both directions.
  server.on("upgrade", (request, socket, head) => {
    const upstream = net.connect(remote.port, "127.0.0.1", () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    base: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe("browser link between two real gateways", () => {
  it("advertises the link on both sides", async () => {
    expect(await json(await fetch(`${remoteBase}/api/capabilities`))).toMatchObject({ multiUser: true, gatewayLink: { version: 1, method: "loopback-pkce" } });
    expect(await json(await fetch(`${localBase}/api/capabilities`))).toMatchObject({ multiUser: false, relayLink: { available: true } });
  });

  it("links from the command line with a browser sign-in and no key copied by hand", async () => {
    const printed: string[] = [];
    const store = createFileRemoteGatewayStore(localStorePath);
    let browserDone: Promise<{ status: number; body: Record<string, unknown> }> | undefined;
    const linked = await linkWithBrowser(linkedRemote, { name: "hub", openBrowser: true }, {
      gatewayBase: localBase,
      print: (line) => printed.push(line),
      open: (url) => {
        browserDone = browser(url, "approve");
      },
    });
    expect(linked).toEqual({ name: "hub" });
    expect((await browserDone)?.body).toEqual({ status: "linked" });
    expect(store.list()).toHaveLength(1);
    const [saved] = store.list();
    // The key is left out of the compared object, so a failure never prints it.
    const { token, ...visible } = saved;
    expect(token).toBeTruthy();
    expect(visible).toMatchObject({ name: "hub", url: linkedRemote, managed: { account: { email: "alice@example.test" } } });
    expect((await fs.stat(localStorePath)).mode & 0o777).toBe(0o600);
    // The printed text holds the consent address and no secret.
    expect(printed.join("\n")).toContain(`${linkedRemote}/gateway-link?request=`);
    expect(printed.join("\n").includes(token!)).toBe(false);
  });

  it("gives the local gateway a working key", async () => {
    const key = await storedKey();
    expect(key.startsWith("gl_")).toBe(true);
    expect(await me(key)).toBe(200);
    // The device link of the local gateway signs in to the remote with that key.
    const states = await until(async () => {
      const current = await deviceStates();
      return current.find((state) => state.name === "hub" && state.connected) ? current : false;
    });
    expect(states.find((state) => state.name === "hub")).toMatchObject({ connected: true, status: "connected" });
    // Remote agents show on the local gateway through the linked key.
    const agents = await json<Array<{ id: string }>>(await fetch(`${localBase}/api/agents`));
    expect(agents.map((agent) => agent.id)).toContain("pom@hub");
  });

  it("shows the saved link after a reload, with key state apart from connection state, and no secret", async () => {
    const response = await fetch(`${localBase}/api/relay/link/metadata`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const text = await response.text();
    expect(text.includes(await storedKey())).toBe(false);
    const [row] = (JSON.parse(text) as { gateways: Row[] }).gateways;
    expect(row).toMatchObject({ name: "hub", remote: linkedRemote, kind: "browser", account: "alice@example.test", keyState: "active", connection: "connected" });
    expect(row.linkId).toBeTruthy();
    expect(row.deviceLabel).toBeTruthy();
  });

  it("refuses the callback origin for anything but the completion", async () => {
    const origin = `http://127.0.0.1:${local.port}`;
    expect((await startLink("other", origin)).status).toBe(403);
    expect((await fetch(`${localBase}/api/relay/link/metadata`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${localBase}/api/relay/link/disconnect`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ name: "hub" }) })).status).toBe(403);
    expect(await rows()).toHaveLength(1);
  });

  it("refuses a state that no attempt owns, and keeps the stored link", async () => {
    const before = await storedKey();
    const response = await fetch(`${localBase}/api/relay/link/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${local.port}` },
      body: JSON.stringify({ code: "synthetic-code", state: "s".repeat(43) }),
    });
    expect(response.status).toBe(404);
    expect((await storedKey()) === before).toBe(true);
  });

  it("ends a refused request as denied and keeps the stored link", async () => {
    const before = await storedKey();
    const attempt = await json<Attempt>(await startLink("hub"));
    expect((await browser(attempt.consentUrl, "deny")).body).toMatchObject({ status: "denied" });
    expect(await attemptStatus(attempt)).toMatchObject({ status: "denied" });
    expect((await storedKey()) === before).toBe(true);
    expect(await me(before)).toBe(200);
  });

  it("links again with a new key and the old key stops", async () => {
    const oldKey = await storedKey();
    const [before] = await rows();
    const attempt = await json<Attempt>(await startLink("hub"));
    expect((await browser(attempt.consentUrl, "approve")).body).toEqual({ status: "linked" });
    expect(await attemptStatus(attempt)).toMatchObject({ status: "linked" });
    const newKey = await storedKey();
    expect(newKey === oldKey).toBe(false);
    expect(await me(oldKey)).toBe(401);
    expect(await me(newKey)).toBe(200);
    const [after] = await rows();
    expect(after.linkId).toBe(before.linkId);
    await until(async () => (await deviceStates()).find((state) => state.name === "hub" && state.connected));
  });

  it("stops the device link when the owner revokes the key on the remote", async () => {
    const [row] = await rows();
    const key = await storedKey();
    const revoked = await fetch(`${remoteBase}/api/auth/gateway-link/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: remoteBase },
      body: JSON.stringify({ linkId: row.linkId }),
    });
    expect(revoked.status).toBe(200);
    expect(await me(key)).toBe(401);
    // The live socket closes, and the reconnect fails with a refused key.
    const state = await until(async () => {
      const current = (await deviceStates()).find((item) => item.name === "hub");
      return current && !current.connected && current.status === "unauthorized" ? current : false;
    }, 45_000);
    expect(state.status).toBe("unauthorized");
    expect((await rows())[0]).toMatchObject({ keyState: "rejected", connection: "unauthorized" });
  }, 60_000);

  it("links again after a revoke, then disconnects from the command line and revokes the key", async () => {
    const attempt = await json<Attempt>(await startLink("hub"));
    expect((await browser(attempt.consentUrl, "approve")).body).toEqual({ status: "linked" });
    const key = await storedKey();
    expect(await me(key)).toBe(200);
    const store = createFileRemoteGatewayStore(localStorePath);
    const message = await disconnectRemoteGateway("hub", {}, store, { gatewayBase: localBase });
    expect(message).toContain("Revoked the key");
    expect(store.list()).toEqual([]);
    expect(await me(key)).toBe(401);
    // The device link manager reads the store every five seconds, so the link goes away within that time.
    await until(async () => (await deviceStates()).length === 0);
  }, 60_000);

  it("tells the user to revoke at the owner page after a lost first exchange, then links with a fresh start", async () => {
    forwarder.state.dropTokenAnswer = true;
    try {
      const first = await json<Attempt>(await startLink("lost"));
      const requestId = new URL(first.consentUrl).searchParams.get("request")!;
      // The remote makes the key, and the answer never reaches the local gateway.
      expect((await finishInBrowser(requestId, "approve")).body).toMatchObject({ status: "uncertain" });
      expect(forwarder.state.dropped).toBe(1);
      const status = await json<{ status: string; message: string; ownerPageUrl: string }>(
        await fetch(`${localBase}/api/relay/link/status/${first.attemptId}`, { headers: { "x-link-control": first.controlToken } })
      );
      expect(status).toMatchObject({ status: "uncertain", ownerPageUrl: `${linkedRemote}/account/gateway-links` });
      expect(status.message).toContain("/account/gateway-links");
      expect((JSON.parse(await fs.readFile(localStorePath, "utf8")) as Array<{ name: string }>).map((item) => item.name)).not.toContain("lost");

      // A fresh start repeats the instruction, and the remote consent page lists the key that nobody holds.
      const fresh = await json<Attempt & { recoveryNote?: string }>(await startLink("lost"));
      expect(fresh.recoveryNote).toContain("/account/gateway-links");
      const freshId = new URL(fresh.consentUrl).searchParams.get("request")!;
      const view = await json<{ sameDeviceLinks: Array<{ id: string; status: string }> }>(
        await fetch(`${remoteBase}/api/auth/gateway-link/requests/${freshId}`, { headers: { Cookie: cookie } })
      );
      const lost = view.sameDeviceLinks.filter((link) => link.status === "active");
      expect(lost).toHaveLength(1);

      // The owner revokes that link on the owner page, and the fresh start then links.
      const revoked = await fetch(`${remoteBase}/api/auth/gateway-link/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie, Origin: remoteBase },
        body: JSON.stringify({ linkId: lost[0].id }),
      });
      expect(revoked.status).toBe(200);
      forwarder.state.dropTokenAnswer = false;
      expect((await finishInBrowser(freshId, "approve")).body).toEqual({ status: "linked" });
      expect(await attemptStatus(fresh)).toMatchObject({ status: "linked" });
      const saved = JSON.parse(await fs.readFile(localStorePath, "utf8")) as Array<{ name: string; token: string }>;
      expect(await me(saved.find((item) => item.name === "lost")!.token)).toBe(200);
    } finally {
      forwarder.state.dropTokenAnswer = false;
    }
  }, 60_000);

  it("links a remote with no sign-in at once, with no key and no consent page", async () => {
    const plain = await startGateway("plain", "local");
    const plainBase = `http://127.0.0.1:${plain.port}`;
    const response = await startLink("open", undefined, plainBase);
    expect(response.status, response.status === 200 ? undefined : `${await response.text()}\n${plain.output()}`).toBe(200);
    expect(await json(response)).toEqual({ status: "linked", name: "open" });
    const saved = JSON.parse(await fs.readFile(localStorePath, "utf8")) as Array<{ name: string; url: string; token?: string; managed?: unknown }>;
    const open = saved.find((item) => item.name === "open");
    expect(open?.url).toBe(plainBase);
    expect(open?.token).toBeUndefined();
    expect(open?.managed).toBeUndefined();
  }, 120_000);

  it("refuses a plain http address that is not a literal loopback address, before any request", async () => {
    const response = await startLink("bad", undefined, "http://localhost:9");
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: "invalid_remote" });
  });
});
