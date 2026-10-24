import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocketFactory, TOKEN } from "./test-fakes.js";
import {
  MattermostSocket,
  backoffDelay,
  websocketUrl,
  type MattermostSocketEvent,
  type ReconnectInfo,
} from "./websocket.js";

function setup() {
  const factory = new FakeSocketFactory();
  const events: MattermostSocketEvent[] = [];
  const reconnects: ReconnectInfo[] = [];
  const socket = new MattermostSocket({
    baseUrl: "https://chat.example.test",
    token: TOKEN,
    logPrefix: "[test]",
    onEvent: (event) => events.push(event),
    onReconnect: (info) => reconnects.push(info),
    createSocket: factory.create,
    initialBackoffMs: 1_000,
    maxBackoffMs: 8_000,
    pingIntervalMs: 10_000,
    idleTimeoutMs: 25_000,
    random: () => 0.5, // no jitter
  });
  return { factory, events, reconnects, socket };
}

async function connect(env: ReturnType<typeof setup>, connectionId = "conn-1") {
  const started = env.socket.start();
  env.factory.last().open();
  env.factory.last().hello(connectionId);
  await started;
}

describe("backoffDelay", () => {
  it("doubles from the initial delay and stops at the cap", () => {
    const delays = [1, 2, 3, 4, 5, 6].map((n) =>
      backoffDelay(n, 1_000, 8_000, () => 0.5)
    );
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  });

  it("adds at most 20% jitter either way", () => {
    expect(backoffDelay(2, 1_000, 60_000, () => 0)).toBe(1_600);
    expect(backoffDelay(2, 1_000, 60_000, () => 1)).toBe(2_400);
  });
});

describe("MattermostSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("connects to /api/v4/websocket with the token in a header, not the url", async () => {
    const env = setup();
    await connect(env);
    const socket = env.factory.last();
    expect(socket.url).toBe("wss://chat.example.test/api/v4/websocket");
    expect(websocketUrl("http://localhost:8065")).toBe(
      "ws://localhost:8065/api/v4/websocket"
    );
    expect(socket.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(socket.url).not.toContain(TOKEN);
    env.socket.stop();
  });

  it("forwards events but not the hello or ping replies", async () => {
    const env = setup();
    await connect(env);
    env.factory.last().message({ status: "OK", seq_reply: 1 });
    env.factory
      .last()
      .message({ event: "posted", seq: 1, data: { post: "{}" } });
    expect(env.events.map((e) => e.event)).toEqual(["posted"]);
    env.socket.stop();
  });

  it("fails start() when the first connection is refused", async () => {
    const env = setup();
    const started = env.socket.start();
    env.factory.last().fail("Unexpected server response: 401");
    await expect(started).rejects.toThrow("401");
    expect(env.factory.sockets).toHaveLength(1);
  });

  it("reconnects with a growing delay until the server answers", async () => {
    const env = setup();
    await connect(env);
    env.factory.last().drop();
    expect(env.factory.sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(env.factory.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.factory.sockets).toHaveLength(2);

    env.factory.last().drop();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(env.factory.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.factory.sockets).toHaveLength(3);

    // A successful hello resets the backoff.
    env.factory.last().open();
    env.factory.last().hello("conn-1");
    env.factory.last().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.factory.sockets).toHaveLength(4);
    env.socket.stop();
  });

  it("resumes with connection_id and the next sequence number", async () => {
    const env = setup();
    await connect(env, "conn-1");
    env.factory.last().message({ event: "posted", seq: 1, data: {} });
    env.factory.last().message({ event: "typing", seq: 2, data: {} });
    env.factory.last().drop();
    await vi.advanceTimersByTimeAsync(1_000);

    const second = env.factory.last();
    expect(second.url).toBe(
      "wss://chat.example.test/api/v4/websocket?connection_id=conn-1&sequence_number=3"
    );
    second.open();
    second.hello("conn-1");
    expect(env.reconnects).toEqual([
      { resumed: true, disconnectedAt: expect.any(Number) },
    ]);
    env.socket.stop();
  });

  it("reports a gap when the server starts a new connection", async () => {
    const env = setup();
    await connect(env, "conn-1");
    env.factory.last().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    env.factory.last().open();
    env.factory.last().hello("conn-2");
    expect(env.reconnects).toEqual([
      { resumed: false, disconnectedAt: expect.any(Number) },
    ]);

    // The next resume uses the new connection and restarts the sequence.
    env.factory.last().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.factory.last().url).toContain(
      "connection_id=conn-2&sequence_number=1"
    );
    env.socket.stop();
  });

  it("pings and drops a silent connection so it reconnects", async () => {
    const env = setup();
    await connect(env);
    const first = env.factory.last();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(JSON.parse(first.sent[0])).toMatchObject({ action: "ping" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(first.terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.factory.sockets).toHaveLength(2);
    env.socket.stop();
  });

  it("stays down after stop()", async () => {
    const env = setup();
    await connect(env);
    env.socket.stop();
    expect(env.factory.last().closed).toBe(true);
    env.factory.last().drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.factory.sockets).toHaveLength(1);
  });
});
