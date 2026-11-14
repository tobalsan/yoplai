import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { writeTestV3Config } from "../test-utils/v3-config.js";
import { connectRemoteGateway } from "../cli/connect.js";
import { createFileRemoteGatewayStore } from "./store.js";
import { configureRelay, getLinkedGateways } from "./state.js";
import { FIRST_RESPONSE_TIMEOUT_MS, fetchRemote } from "./remote.js";

type WsEvent = { type: string; agentId?: string; data?: string; message?: string };

const fixture = fileURLToPath(new URL("./remote-gateway.fixture.ts", import.meta.url));
const gatewayDir = fileURLToPath(new URL("../..", import.meta.url));

async function startRemoteGateway(home: string): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(
    process.execPath,
    ["--conditions=development", "--import", "tsx", fixture],
    {
      cwd: gatewayDir,
      detached: true,
      env: { ...process.env, FIXTURE_HOME: home, FIXTURE_AGENTS: "pom,twin", FIXTURE_LABEL: "remote" },
    }
  );
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /PORT (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", () => reject(new Error(`remote gateway exited: ${output}`)));
  });
  return { child, port };
}


type Recorded = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

/** A fake remote gateway. It records each request and each WebSocket message. */
async function startFakeGateway(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, recorded: Recorded) => void = (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end("{}");
  },
  upgradeGate?: Promise<void>
) {
  const requests: Recorded[] = [];
  const socketMessages: Array<{ type?: string; agentId?: string }> = [];
  const sockets: WebSocket[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() };
      requests.push(recorded);
      handler(req, res, recorded);
    });
  });
  const wss = new WebSocketServer({
    server,
    verifyClient: upgradeGate ? (_info, done) => void upgradeGate.then(() => done(true)) : undefined,
  });
  let upgradeAttempts = 0;
  server.on("upgrade", () => {
    upgradeAttempts += 1;
  });
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => socketMessages.push(JSON.parse(raw.toString()) as { type?: string; agentId?: string }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    socketMessages,
    sockets,
    upgradeAttempts: () => upgradeAttempts,
    close: () => {
      for (const socket of sockets) socket.terminate();
      server.closeAllConnections();
      server.close();
    },
  };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("desktop relay: chat relay", () => {
  let tmpDir: string;
  let remote: { child: ChildProcess; port: number };
  let localServer: ReturnType<typeof import("../server/index.js").startServer>;
  let localBase: string;
  let remoteBase: string;
  let saveGateway: (gateway: { name: string; url: string; token?: string }) => void;
  let removeGateway: (name: string) => boolean;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-relay-"));
    remote = await startRemoteGateway(path.join(tmpDir, "remote"));
    remoteBase = `http://127.0.0.1:${remote.port}`;

    const localHome = path.join(tmpDir, "local");
    process.env.YOPLAI_HOME = path.join(localHome, ".yoplai");
    process.env.HOME = localHome;
    await writeTestV3Config(process.env.YOPLAI_HOME, {
      agents: [{ id: "local" }, { id: "twin" }, { id: "pom@loc" }],
    });
    vi.resetModules();
    const { piAdapter } = await import("../sdk/pi/adapter.js");
    piAdapter.run = async (params) => {
      const text = `local answers ${params.agentId}: ${params.message}`;
      params.onHistoryEvent({ type: "user", text: params.message, timestamp: Date.now() });
      params.onEvent({ type: "text", data: text });
      params.onHistoryEvent({ type: "assistant_text", text, timestamp: Date.now() });
      params.onHistoryEvent({ type: "turn_end", timestamp: Date.now() });
      return { text };
    };
    const state = await import("./state.js");
    saveGateway = (gateway) => state.getRemoteGatewayStore().save(gateway);
    removeGateway = (name) => state.getRemoteGatewayStore().remove(name);
    saveGateway({ name: "ams", url: remoteBase });
    const { startServer } = await import("../server/index.js");
    localServer = startServer(0, "127.0.0.1");
    await new Promise<void>((resolve) => localServer.once("listening", () => resolve()));
    localBase = `http://127.0.0.1:${(localServer.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => localServer?.close(() => resolve()));
    if (remote?.child.pid) process.kill(-remote.child.pid, "SIGTERM");
    process.env = previousEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function chat(base: string, agentId: string, message: string, sessionKey = "main"): Promise<WsEvent[]> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
      const events: WsEvent[] = [];
      ws.on("open", () => ws.send(JSON.stringify({ type: "send", agentId, sessionKey, message })));
      ws.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as WsEvent;
        events.push(event);
        if (event.type === "done" || event.type === "error") {
          ws.close();
          resolve(events);
        }
      });
      ws.on("error", reject);
    });
  }

  async function history(agentId: string, sessionKey = "main"): Promise<string> {
    const response = await fetch(
      `${localBase}/api/agents/${encodeURIComponent(agentId)}/history?view=full&sessionKey=${sessionKey}`
    );
    expect(response.status).toBe(200);
    return JSON.stringify(await response.json());
  }

  it("lists remote agents with a suffix and a gateway field", async () => {
    const agents = (await (await fetch(`${localBase}/api/agents`)).json()) as Array<{ id: string; gateway?: string }>;
    expect(agents.map((agent) => agent.id).sort()).toEqual(["local", "pom@ams", "pom@loc", "twin", "twin@ams"]);
    expect(agents.find((agent) => agent.id === "pom@ams")?.gateway).toBe("ams");
    expect(agents.find((agent) => agent.id === "local")?.gateway).toBeUndefined();
    const { statuses } = (await (await fetch(`${localBase}/api/agents/status`)).json()) as {
      statuses: Record<string, string>;
    };
    expect(Object.keys(statuses).sort()).toEqual(["local", "pom@ams", "pom@loc", "twin", "twin@ams"]);
  });

  it("returns the stream events and the answer of the remote gateway", async () => {
    const events = await chat(localBase, "pom@ams", "hello");
    expect(events.find((event) => event.type === "text")?.data).toBe("remote answers pom: hello");
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("loads the history and the session list of a remote chat", async () => {
    await chat(localBase, "pom@ams", "remember this", "history-key");
    expect(await history("pom@ams", "history-key")).toContain("remote answers pom: remember this");
    const { items } = (await (await fetch(`${localBase}/api/agents/sessions`)).json()) as {
      items: Array<{ agentId: string }>;
    };
    expect(items.map((item) => item.agentId)).toContain("pom@ams");
  });

  it("keeps two agents with the same id on the two gateways apart", async () => {
    await chat(localBase, "twin", "one", "twin-key");
    await chat(localBase, "twin@ams", "two", "twin-key");
    const localHistory = await history("twin", "twin-key");
    const remoteHistory = await history("twin@ams", "twin-key");
    expect(localHistory).toContain("local answers twin: one");
    expect(localHistory).not.toContain("remote answers");
    expect(remoteHistory).toContain("remote answers twin: two");
    expect(remoteHistory).not.toContain("local answers");
  });

  it("keeps local agents and the lists working while a remote gateway is offline", async () => {
    saveGateway({ name: "dead", url: "http://127.0.0.1:1" });
    try {
      const agents = (await (await fetch(`${localBase}/api/agents`)).json()) as Array<{ id: string }>;
      expect(agents.map((agent) => agent.id)).toContain("local");
      expect(agents.map((agent) => agent.id)).toContain("pom@ams");
      expect(agents.some((agent) => agent.id.endsWith("@dead"))).toBe(false);
      const events = await chat(localBase, "local", "still here");
      expect(events.find((event) => event.type === "text")?.data).toBe("local answers local: still here");
    } finally {
      removeGateway("dead");
    }
  });

  it("uploads to the remote gateway and downloads from it", async () => {
    const form = new FormData();
    form.set("file", new File(["remote file body"], "note.txt", { type: "text/plain" }));
    form.set("agentId", "pom@ams");
    const upload = await fetch(`${localBase}/api/media/upload`, { method: "POST", body: form });
    expect(upload.status).toBe(200);
    const uploaded = (await upload.json()) as { filename: string };
    const fileId = uploaded.filename.replace(/\.txt$/, "");
    const direct = await fetch(`${remoteBase}/api/media/download/${fileId}`);
    expect(await direct.text()).toBe("remote file body");
    const viaLocal = await fetch(`${localBase}/api/media/download/${fileId}`);
    expect(viaLocal.status).toBe(200);
    expect(await viaLocal.text()).toBe("remote file body");
  });

  it("sends history_updated with the suffix to a subscriber of a remote chat", async () => {
    const ws = new WebSocket(`${localBase.replace("http", "ws")}/ws`);
    const updated = new Promise<WsEvent>((resolve) => {
      ws.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as WsEvent;
        if (event.type === "history_updated") resolve(event);
      });
    });
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "subscribe", agentId: "pom@ams", sessionKey: "sub-key" }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await chat(localBase, "pom@ams", "ping", "sub-key");
    expect((await updated).agentId).toBe("pom@ams");
    ws.close();
  });

  it("closes the page socket when the remote socket closes during a run", async () => {
    const flaky = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    flaky.on("connection", (socket) => socket.on("message", () => socket.close()));
    await new Promise<void>((resolve) => flaky.once("listening", () => resolve()));
    saveGateway({ name: "flaky", url: `http://127.0.0.1:${(flaky.address() as AddressInfo).port}` });
    try {
      const ws = new WebSocket(`${localBase.replace("http", "ws")}/ws`);
      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      ws.send(JSON.stringify({ type: "send", agentId: "x@flaky", sessionKey: "main", message: "hi" }));
      await closed;
    } finally {
      removeGateway("flaky");
      flaky.close();
    }
  });


  function openPage(base: string, origin?: string): Promise<WebSocket> {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, origin ? { origin } : undefined);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  async function withFakeGateway<T>(
    name: string,
    handler: Parameters<typeof startFakeGateway>[0],
    run: (fake: Awaited<ReturnType<typeof startFakeGateway>>) => Promise<T>,
    token?: string
  ): Promise<T> {
    const fake = await startFakeGateway(handler);
    saveGateway({ name, url: fake.url, ...(token ? { token } : {}) });
    try {
      return await run(fake);
    } finally {
      removeGateway(name);
      fake.close();
    }
  }

  it("refuses to relay for a page of another site and relays for a loopback page", async () => {
    const list = async (origin?: string) =>
      ((await (await fetch(`${localBase}/api/agents`, { headers: origin ? { origin } : {} })).json()) as Array<{ id: string }>).map((agent) => agent.id);
    expect(await list("https://evil.example")).not.toContain("pom@ams");
    expect(await list("http://localhost:5173")).toContain("pom@ams");
    expect(await list()).toContain("pom@ams");
    const evilPage = await openPage(localBase, "https://evil.example");
    const reply = new Promise<WsEvent>((resolve) => evilPage.once("message", (raw) => resolve(JSON.parse(raw.toString()) as WsEvent)));
    evilPage.send(JSON.stringify({ type: "send", agentId: "pom@ams", sessionKey: "main", message: "hi" }));
    expect((await reply).message).toBe("Agent not found");
    evilPage.close();
    const loopbackPage = await openPage(localBase, "http://127.0.0.1:5173");
    const loopbackEvents = await new Promise<WsEvent[]>((resolve) => {
      const events: WsEvent[] = [];
      loopbackPage.on("message", (raw) => {
        events.push(JSON.parse(raw.toString()) as WsEvent);
        if (events.at(-1)?.type === "done") resolve(events);
      });
      loopbackPage.send(JSON.stringify({ type: "send", agentId: "pom@ams", sessionKey: "main", message: "origin" }));
    });
    loopbackPage.close();
    expect(loopbackEvents.find((event) => event.type === "text")?.data).toBe("remote answers pom: origin");
  });

  it("refuses to forward an upload for a page of another site", async () => {
    await withFakeGateway("origin-up", undefined, async (fake) => {
      const form = new FormData();
      form.set("file", new File(["x"], "note.txt", { type: "text/plain" }));
      form.set("agentId", "pom@origin-up");
      await fetch(`${localBase}/api/media/upload`, { method: "POST", body: form, headers: { origin: "https://evil.example" } });
      expect(fake.requests).toEqual([]);
    });
  });

  it("does not start the relay when Tailscale serve is on", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      configureRelay("127.0.0.1", false, true);
      expect(getLinkedGateways()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Tailscale serve"));
    } finally {
      warn.mockRestore();
      configureRelay("127.0.0.1", false);
    }
  });

  it("does not start the relay for a host name that starts with 127.", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      configureRelay("127.evil.example", false);
      expect(getLinkedGateways()).toEqual([]);
    } finally {
      warn.mockRestore();
      configureRelay("127.0.0.1", false);
    }
  });

  it("delivers an unsubscribe that a page sends while the remote socket connects", async () => {
    let openUpgrade!: () => void;
    const gate = new Promise<void>((resolve) => { openUpgrade = resolve; });
    const fake = await startFakeGateway(undefined, gate);
    saveGateway({ name: "race", url: fake.url });
    try {
      const ws = await openPage(localBase);
      ws.send(JSON.stringify({ type: "subscribe", agentId: "x@race", sessionKey: "race" }));
      await waitFor(() => fake.upgradeAttempts() === 1);
      ws.send(JSON.stringify({ type: "unsubscribe" }));
      await new Promise<void>((resolve) => { ws.once("pong", () => resolve()); ws.ping(); });
      expect(fake.socketMessages).toEqual([]);
      openUpgrade();
      await waitFor(() => fake.socketMessages.length === 2);
      expect(fake.socketMessages.map((message) => message.type)).toEqual(["subscribe", "unsubscribe"]);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    } finally {
      removeGateway("race");
      fake.close();
    }
  });

  it("sends unsubscribe to a remote gateway when the page subscribes to another agent", async () => {
    await withFakeGateway("rec", undefined, async (fake) => {
      const ws = await openPage(localBase);
      ws.send(JSON.stringify({ type: "subscribe", agentId: "x@rec", sessionKey: "main" }));
      await waitFor(() => fake.socketMessages.length === 1);
      ws.send(JSON.stringify({ type: "subscribe", agentId: "pom@ams", sessionKey: "main" }));
      await waitFor(() => fake.socketMessages.some((message) => message.type === "unsubscribe"));
      ws.send(JSON.stringify({ type: "subscribe", agentId: "x@rec", sessionKey: "main" }));
      ws.send(JSON.stringify({ type: "subscribe", agentId: "local", sessionKey: "main" }));
      await waitFor(() => fake.socketMessages.filter((message) => message.type === "unsubscribe").length === 2);
      ws.close();
    });
  });

  it("drops the local subscription when the page subscribes to a remote agent", async () => {
    const ws = await openPage(localBase);
    const updates: WsEvent[] = [];
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as WsEvent;
      if (event.type === "history_updated") updates.push(event);
    });
    ws.send(JSON.stringify({ type: "subscribe", agentId: "local", sessionKey: "one-sub" }));
    await sleep(100);
    ws.send(JSON.stringify({ type: "subscribe", agentId: "pom@ams", sessionKey: "one-sub" }));
    await sleep(200);
    await chat(localBase, "local", "no echo", "one-sub");
    await sleep(300);
    expect(updates).toEqual([]);
    ws.close();
  });

  it("keeps the page socket open while a status gateway is offline or closes its socket", async () => {
    saveGateway({ name: "dead", url: "http://127.0.0.1:1" });
    try {
      await withFakeGateway("closer", undefined, async (fake) => {
        const ws = await openPage(localBase);
        ws.send(JSON.stringify({ type: "subscribeStatus" }));
        await waitFor(() => fake.socketMessages.length === 1);
        fake.sockets[0]?.close();
        await sleep(500);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
      });
    } finally {
      removeGateway("dead");
    }
  });

  it("sends the status message of a remote gateway with the suffix", async () => {
    const ws = await openPage(localBase);
    const status = new Promise<WsEvent>((resolve) => {
      ws.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as WsEvent;
        if (event.type === "status" && event.agentId === "pom@ams") resolve(event);
      });
    });
    ws.send(JSON.stringify({ type: "subscribeStatus" }));
    await sleep(300);
    await chat(localBase, "pom@ams", "status please", "status-key");
    expect((await status).agentId).toBe("pom@ams");
    ws.close();
  });

  it("closes the page socket when the queue for a connecting remote socket is full", async () => {
    const stall = net.createServer(() => {});
    await new Promise<void>((resolve) => stall.listen(0, "127.0.0.1", resolve));
    saveGateway({ name: "stall", url: `http://127.0.0.1:${(stall.address() as AddressInfo).port}` });
    try {
      const ws = await openPage(localBase);
      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      for (let i = 0; i < 30; i++) {
        ws.send(JSON.stringify({ type: "send", agentId: "x@stall", sessionKey: "main", message: `m${i}` }));
      }
      await closed;
    } finally {
      removeGateway("stall");
      stall.close();
    }
  });

  it("closes the page socket when the remote socket does not connect in time", async () => {
    const stall = net.createServer(() => {});
    await new Promise<void>((resolve) => stall.listen(0, "127.0.0.1", resolve));
    saveGateway({ name: "slow", url: `http://127.0.0.1:${(stall.address() as AddressInfo).port}` });
    const { RelayWsBridge } = await import("./ws.js");
    const closed = new Promise<void>((resolve) => {
      const page = { readyState: WebSocket.OPEN, send: vi.fn(), close: resolve } as unknown as WebSocket;
      const bridge = new RelayWsBridge(page, undefined, () => {}, 200);
      bridge.handle(JSON.stringify({ type: "send", agentId: "x@slow", sessionKey: "main", message: "hi" }));
    });
    try {
      await closed;
    } finally {
      removeGateway("slow");
      stall.close();
    }
  });

  it("sends the bearer token and drops Origin, Referer, and cookies for a remote gateway", async () => {
    await withFakeGateway(
      "hdr",
      (req, res) => {
        if (req.headers.authorization !== "Bearer test-bearer") {
          res.statusCode = 401;
          res.end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.setHeader("set-cookie", "session=remote; Path=/");
        res.end(JSON.stringify({ messages: [] }));
      },
      async (fake) => {
        const response = await fetch(`${localBase}/api/agents/pom%40hdr/history`, {
          headers: { origin: "http://localhost:5173", referer: "http://localhost:5173/", cookie: "local=1" },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toBeNull();
        const seen = fake.requests[0]?.headers;
        expect(seen?.authorization).toBe("Bearer test-bearer");
        expect(seen?.origin).toBeUndefined();
        expect(seen?.referer).toBeUndefined();
        expect(seen?.cookie).toBeUndefined();
      },
      "test-bearer"
    );
  });

  it("answers a HEAD request and a 204 without a body, and keeps an error object as it is", async () => {
    await withFakeGateway(
      "body",
      (req, res) => {
        if (req.url?.includes("/missing")) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Agent not found" }));
          return;
        }
        if (req.method === "DELETE") {
          res.statusCode = 204;
          res.setHeader("content-type", "application/json");
          res.end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.setHeader("content-length", "11");
        res.end(req.method === "HEAD" ? undefined : '{"a":"bbbb"}');
      },
      async () => {
        const head = await fetch(`${localBase}/api/agents/pom%40body/history`, { method: "HEAD" });
        expect(head.status).toBe(200);
        const noContent = await fetch(`${localBase}/api/agents/pom%40body/sessions/abc`, { method: "DELETE" });
        expect(noContent.status).toBe(204);
        const missing = await fetch(`${localBase}/api/agents/missing%40body`);
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: "Agent not found" });
      }
    );
  });

  it("stops a run on a remote agent", async () => {
    await withFakeGateway("stopper", undefined, async (fake) => {
      const response = await fetch(`${localBase}/api/agents/pom%40stopper/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "/abort", sessionKey: "main" }),
      });
      expect(response.status).toBe(200);
      expect(fake.requests[0]).toMatchObject({ method: "POST", url: "/api/agents/pom/messages" });
      expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toMatchObject({ message: "/abort" });
    });
  });

  it("renames a session of a remote agent", async () => {
    await chat(localBase, "pom@ams", "rename me", "rename-key");
    const { items } = (await (await fetch(`${localBase}/api/agents/sessions/search?q=rename%20me`)).json()) as {
      items: Array<{ agentId: string; sessionId: string }>;
    };
    const session = items.find((item) => item.agentId === "pom@ams");
    expect(session).toBeDefined();
    const renamed = await fetch(`${localBase}/api/agents/pom%40ams/sessions/${session?.sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed remotely" }),
    });
    expect(renamed.status).toBe(200);
    const after = (await (await fetch(`${localBase}/api/agents/sessions`)).json()) as { items: Array<{ sessionId: string; title?: string }> };
    expect(after.items.find((item) => item.sessionId === session?.sessionId)?.title).toBe("Renamed remotely");
  });

  it("finds a session of a remote agent in the search", async () => {
    await chat(localBase, "pom@ams", "zebra-needle", "search-key");
    const { items } = (await (await fetch(`${localBase}/api/agents/sessions/search?q=zebra-needle`)).json()) as {
      items: Array<{ agentId: string }>;
    };
    expect(items.map((item) => item.agentId)).toContain("pom@ams");
  });

  it("keeps the title-first order and the 50 result limit in a merged search", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ agentId: "a", sessionId: `s${i}`, match: "text", lastActivity: 1000 + i }));
    const items = [...many, { agentId: "a", sessionId: "title-hit", match: "title", lastActivity: 1 }];
    await withFakeGateway(
      "many",
      (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ items }));
      },
      async () => {
        const result = (await (await fetch(`${localBase}/api/agents/sessions/search?q=x`)).json()) as {
          items: Array<{ sessionId: string }>;
        };
        expect(result.items).toHaveLength(50);
        expect(result.items[0]?.sessionId).toBe("title-hit");
      }
    );
  });

  it("prefers a local agent whose id ends with a gateway suffix", async () => {
    saveGateway({ name: "loc", url: remoteBase });
    try {
      const events = await chat(localBase, "pom@loc", "hi");
      expect(events.find((event) => event.type === "text")?.data).toBe("local answers pom@loc: hi");
      const agents = (await (await fetch(`${localBase}/api/agents`)).json()) as Array<{ id: string; gateway?: string }>;
      const matching = agents.filter((agent) => agent.id === "pom@loc");
      expect(matching).toHaveLength(1);
      expect(matching[0]?.gateway).toBeUndefined();
    } finally {
      removeGateway("loc");
    }
  });

  it("refuses a too large upload before it reaches the remote gateway", async () => {
    await withFakeGateway("big", undefined, async (fake) => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(26 * 1024 * 1024)], "big.txt", { type: "text/plain" }));
      form.set("agentId", "pom@big");
      const response = await fetch(`${localBase}/api/media/upload`, { method: "POST", body: form });
      expect(response.status).toBe(413);
      expect(fake.requests).toEqual([]);
    });
  });

  it("stops a forwarded upload when the page request aborts", async () => {
    let closed = false;
    await withFakeGateway(
      "hang-up",
      (_req, res) => {
        res.on("close", () => {
          closed = true;
        });
      },
      async (fake) => {
        const controller = new AbortController();
        const form = new FormData();
        form.set("file", new File(["x"], "note.txt", { type: "text/plain" }));
        form.set("agentId", "pom@hang-up");
        const pending = fetch(`${localBase}/api/media/upload`, { method: "POST", body: form, signal: controller.signal }).catch(() => null);
        await waitFor(() => fake.requests.length === 1);
        controller.abort();
        await pending;
        await waitFor(() => closed);
      }
    );
  });

  it("stops a download fallback when the page request aborts", async () => {
    let closed = false;
    await withFakeGateway(
      "hang-down",
      (_req, res) => {
        res.on("close", () => {
          closed = true;
        });
      },
      async (fake) => {
        const controller = new AbortController();
        const pending = fetch(`${localBase}/api/media/download/11111111-1111-4111-8111-111111111111`, { signal: controller.signal }).catch(() => null);
        await waitFor(() => fake.requests.some((request) => request.url.includes("/download/")));
        controller.abort();
        await pending;
        await waitFor(() => closed);
      }
    );
  });

  it("gives the first response a deadline and lets a streamed body run on", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return Promise.resolve(new Response("ok"));
    });
    try {
      await fetchRemote({ name: "x", url: "http://127.0.0.1:1" }, "/a");
      await vi.advanceTimersByTimeAsync(FIRST_RESPONSE_TIMEOUT_MS + 1000);
      expect(signals[0]?.aborted).toBe(false);
      let pendingSignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
        pendingSignal = init.signal as AbortSignal;
        return new Promise<Response>(() => {});
      });
      void fetchRemote({ name: "x", url: "http://127.0.0.1:1" }, "/b");
      await vi.advanceTimersByTimeAsync(FIRST_RESPONSE_TIMEOUT_MS + 1000);
      expect(pendingSignal?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("does not start the relay when the UI listens on a non-loopback address", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      configureRelay("127.0.0.1", false, false, "0.0.0.0");
      expect(getLinkedGateways()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("the UI listens on 0.0.0.0"));
    } finally {
      warn.mockRestore();
      configureRelay("127.0.0.1", false);
    }
  });

  it("drops a remote session and a remote search hit whose id belongs to a local agent", async () => {
    const items = [
      { agentId: "pom", sessionId: "clash", match: "title", lastActivity: 5 },
      { agentId: "other", sessionId: "fine", match: "title", lastActivity: 4 },
    ];
    await withFakeGateway(
      "loc",
      (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ items }));
      },
      async () => {
        for (const url of ["/api/agents/sessions", "/api/agents/sessions/search?q=x"]) {
          const result = (await (await fetch(`${localBase}${url}`)).json()) as { items: Array<{ sessionId: string }> };
          const ids = result.items.map((item) => item.sessionId);
          expect(ids).toContain("fine");
          expect(ids).not.toContain("clash");
        }
      }
    );
  });

  it("drops a remote status event whose id belongs to a local agent", async () => {
    await withFakeGateway("loc", undefined, async (fake) => {
      const ws = await openPage(localBase);
      const seen: string[] = [];
      const other = new Promise<void>((resolve) => {
        ws.on("message", (raw) => {
          const event = JSON.parse(raw.toString()) as WsEvent;
          if (event.type !== "status" || !event.agentId) return;
          seen.push(event.agentId);
          if (event.agentId === "other@loc") resolve();
        });
      });
      ws.send(JSON.stringify({ type: "subscribeStatus" }));
      await waitFor(() => fake.sockets.length > 0 && fake.socketMessages.length > 0);
      fake.sockets[0]?.send(JSON.stringify({ type: "status", agentId: "pom", status: "running" }));
      fake.sockets[0]?.send(JSON.stringify({ type: "status", agentId: "other", status: "running" }));
      await other;
      expect(seen).toEqual(["other@loc"]);
      ws.close();
    });
  });

  /** A multipart body with no Content-Length. A file, then a padding field, then the agent id. */
  function chunkedUpload(agentId: string, padBytes: number): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const part = (name: string, value: string, file?: string) =>
      `--B\r\nContent-Disposition: form-data; name="${name}"${file ? `; filename="${file}"` : ""}\r\n\r\n${value}\r\n`;
    const pad = new Uint8Array(1024 * 1024).fill(97);
    let sent = 0;
    let step = 0;
    return new ReadableStream({
      pull(controller) {
        if (step === 0) controller.enqueue(encoder.encode(part("file", "x", "note.txt") + `--B\r\nContent-Disposition: form-data; name="pad"\r\n\r\n`));
        else if (sent < padBytes) {
          controller.enqueue(pad);
          sent += pad.length;
        } else {
          controller.enqueue(encoder.encode(`\r\n${part("agentId", agentId)}--B--\r\n`));
          controller.close();
        }
        step += 1;
      },
    });
  }

  it("refuses a remote upload over the byte limit when the request has no Content-Length", async () => {
    await withFakeGateway("chunky", undefined, async (fake) => {
      const response = await fetch(`${localBase}/api/media/upload`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=B" },
        body: chunkedUpload("pom@chunky", 28 * 1024 * 1024),
        duplex: "half",
      } as RequestInit);
      expect(response.status).toBe(413);
      expect(fake.requests).toEqual([]);
    });
  });

  it("does not apply the relay byte limit to an upload for a local agent", async () => {
    const form = new FormData();
    form.set("file", new File(["local file"], "note.txt", { type: "text/plain" }));
    form.set("pad", "a".repeat(28 * 1024 * 1024));
    form.set("agentId", "local");
    const response = await fetch(`${localBase}/api/media/upload`, { method: "POST", body: form });
    expect(response.status).toBe(200);
  });

  it("does not close the page when a remote socket closes after the page left its chat", async () => {
    await withFakeGateway("left", undefined, async (fake) => {
      const ws = await openPage(localBase);
      ws.send(JSON.stringify({ type: "subscribe", agentId: "x@left", sessionKey: "main" }));
      await waitFor(() => fake.sockets.length === 1 && fake.socketMessages.length === 1);
      ws.send(JSON.stringify({ type: "unsubscribe" }));
      await waitFor(() => fake.socketMessages.length === 2);
      const remoteClosed = new Promise<void>((resolve) => fake.sockets[0]?.once("close", () => resolve()));
      fake.sockets[0]?.close();
      await remoteClosed;
      await new Promise<void>((resolve) => { ws.once("pong", () => resolve()); ws.ping(); });
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });

  it("cancels the body of a refused download before it asks the next gateway", async () => {
    let refusedClosed = false;
    await withFakeGateway(
      "refuse",
      (_req, res) => {
        res.on("close", () => {
          refusedClosed = true;
        });
        res.writeHead(404, { "content-type": "text/plain" });
        res.write("not here");
      },
      async () => {
        const response = await fetch(`${localBase}/api/media/download/22222222-2222-4222-8222-222222222222`);
        expect(response.status).toBe(404);
        await waitFor(() => refusedClosed);
      }
    );
  });

  it("saves the store file with mode 0600 when an old temp file has a wider mode", async () => {
    const dir = path.join(tmpDir, "mode-store");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "remote-gateways.json");
    await fs.writeFile(`${file}.${process.pid}.tmp`, "old", { mode: 0o644 });
    createFileRemoteGatewayStore(file).save({ name: "a", url: "http://127.0.0.1:1", token: "t" });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    createFileRemoteGatewayStore(file).remove("a");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("does not start the relay on a non-loopback address without multi-user mode", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      configureRelay("0.0.0.0", false);
      expect(getLinkedGateways()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a loopback address"));
    } finally {
      warn.mockRestore();
      configureRelay("127.0.0.1", false);
    }
  });

  it("saves a linked gateway with file mode 0600", async () => {
    const file = path.join(tmpDir, "store", "remote-gateways.json");
    const gateway = await connectRemoteGateway(remoteBase, { name: "ams2", token: "secret-token" }, createFileRemoteGatewayStore(file));
    expect(gateway.name).toBe("ams2");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await fs.readFile(file, "utf8")) as Array<{ name: string; token?: string }>;
    expect(saved).toEqual([expect.objectContaining({ name: "ams2", token: "secret-token" })]);
  });

  it("names the gateway after the host of the URL by default", async () => {
    const store = createFileRemoteGatewayStore(path.join(tmpDir, "default-name.json"));
    const gateway = await connectRemoteGateway(remoteBase, {}, store);
    expect(gateway.name).toBe("127.0.0.1");
    expect(gateway.token).toBeUndefined();
  });

  it("gives a clear error for a wrong token and saves nothing", async () => {
    const refusing = http.createServer((_req, res) => {
      res.statusCode = 401;
      res.end("{}");
    });
    await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
    const file = path.join(tmpDir, "refused.json");
    try {
      const url = `http://127.0.0.1:${(refusing.address() as AddressInfo).port}`;
      await expect(
        connectRemoteGateway(url, { token: "wrong" }, createFileRemoteGatewayStore(file))
      ).rejects.toThrow(/refused the token/);
      await expect(fs.stat(file)).rejects.toThrow();
    } finally {
      refusing.close();
    }
  });
});
