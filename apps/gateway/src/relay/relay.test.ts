import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { writeTestV3Config } from "../test-utils/v3-config.js";
import { connectRemoteGateway } from "../cli/connect.js";
import { createFileRemoteGatewayStore } from "./store.js";
import { configureRelay, getLinkedGateways } from "./state.js";

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
      agents: [{ id: "local" }, { id: "twin" }],
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
    expect(agents.map((agent) => agent.id).sort()).toEqual(["local", "pom@ams", "twin", "twin@ams"]);
    expect(agents.find((agent) => agent.id === "pom@ams")?.gateway).toBe("ams");
    expect(agents.find((agent) => agent.id === "local")?.gateway).toBeUndefined();
    const { statuses } = (await (await fetch(`${localBase}/api/agents/status`)).json()) as {
      statuses: Record<string, string>;
    };
    expect(Object.keys(statuses).sort()).toEqual(["local", "pom@ams", "twin", "twin@ams"]);
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
