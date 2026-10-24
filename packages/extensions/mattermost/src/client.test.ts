import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MattermostApiError,
  MattermostRestClient,
  normalizeBaseUrl,
} from "./client.js";
import { BOT, CHANNEL, FakeMattermost, TOKEN } from "./test-fakes.js";

const URL_ = "https://chat.example.test";

describe("MattermostRestClient", () => {
  afterEach(() => vi.useRealTimers());

  it("times out hung headers and aborts the request without exposing the token", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    const fetch = vi.fn((_input: string, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    const client = new MattermostRestClient(URL_, TOKEN, fetch, 1, {
      requestTimeoutMs: 30,
    });
    let result: unknown;
    void client.getMe().catch((error: unknown) => {
      result = error;
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(result).toMatchObject({
      name: "TimeoutError",
      message: "Mattermost GET /users/me timed out",
    });
    expect(String(result)).not.toContain(TOKEN);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("normalizes the server url an operator pastes", () => {
    expect(normalizeBaseUrl("https://chat.example.test/")).toBe(URL_);
    expect(normalizeBaseUrl("https://chat.example.test/api/v4/")).toBe(URL_);
  });

  it("keeps the same deadline while reading a successful JSON body", async () => {
    vi.useFakeTimers();
    const client = new MattermostRestClient(
      URL_,
      TOKEN,
      async () => new Response(new ReadableStream(), { status: 200 }),
      1,
      { requestTimeoutMs: 30 }
    );
    let result: unknown;
    void client.getMe().catch((error: unknown) => {
      result = error;
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(result).toMatchObject({ name: "TimeoutError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds download bodies using the file deadline", async () => {
    vi.useFakeTimers();
    const client = new MattermostRestClient(
      URL_,
      TOKEN,
      async () => new Response(new ReadableStream(), { status: 200 }),
      1,
      { requestTimeoutMs: 10, fileTimeoutMs: 30 }
    );
    let result: unknown;
    void client.downloadFile("file1").catch((error: unknown) => {
      result = error;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    expect(result).toMatchObject({
      name: "TimeoutError",
      message: "Mattermost GET /files/file1 timed out",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows uploads the file budget and bounds their JSON bodies", async () => {
    vi.useFakeTimers();
    const client = new MattermostRestClient(
      URL_,
      TOKEN,
      async () => new Response(new ReadableStream(), { status: 200 }),
      1,
      { requestTimeoutMs: 10, fileTimeoutMs: 30 }
    );
    let result: unknown;
    void client
      .uploadFile(CHANNEL, new Uint8Array([1]), "a.txt")
      .catch((error: unknown) => {
        result = error;
      });
    await vi.advanceTimersByTimeAsync(10);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    expect(result).toMatchObject({
      name: "TimeoutError",
      message: "Mattermost POST /files timed out",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels hung calls immediately and never exposes the caller's abort reason", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const fetch = vi.fn((_input: string, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    const client = new MattermostRestClient(URL_, TOKEN, fetch, 1, {
      requestTimeoutMs: 30,
    });
    const result = client.getMe(caller.signal).catch((error: unknown) => error);
    caller.abort(new Error(TOKEN));
    await expect(result).resolves.toMatchObject({
      name: "AbortError",
      message: "Mattermost GET /users/me cancelled",
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts retry waits without leaving timers or starting another attempt", async () => {
    vi.useFakeTimers();
    const server = new FakeMattermost();
    server.overrides.push({
      match: (_method, path) => path === "/users/me",
      reply: { status: 429, body: { message: "slow down" } },
    });
    const client = new MattermostRestClient(URL_, TOKEN, server.fetch, 20, {
      requestTimeoutMs: 100,
    });
    const caller = new AbortController();
    const result = client.getMe(caller.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5);
    caller.abort();
    await expect(result).resolves.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(server.requests).toHaveLength(1);
  });

  it("disposes a pending retry response before a successful next attempt", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const retry = new Response(new ReadableStream({ cancel }), { status: 503 });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(retry)
      .mockResolvedValueOnce(Response.json(BOT));
    const client = new MattermostRestClient(URL_, TOKEN, fetch, 1);
    const result = client.getMe();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ id: BOT.id });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled retry-body cancellation with the operation deadline", async () => {
    vi.useFakeTimers();
    let finishCancel: (() => void) | undefined;
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCancel = resolve;
        })
    );
    const fetch = vi.fn(
      async () => new Response(new ReadableStream({ cancel }), { status: 503 })
    );
    const client = new MattermostRestClient(URL_, TOKEN, fetch, 1, {
      requestTimeoutMs: 30,
    });
    let result: unknown;
    void client.getMe().catch((error: unknown) => {
      result = error;
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(result).toMatchObject({
      name: "TimeoutError",
      message: "Mattermost GET /users/me timed out",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    finishCancel?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not issue any REST operation for an already cancelled caller", async () => {
    const caller = new AbortController();
    caller.abort(new Error(TOKEN));
    const server = new FakeMattermost();
    const client = new MattermostRestClient(URL_, TOKEN, server.fetch);
    const calls: Array<() => Promise<unknown>> = [
      () => client.getMe(caller.signal),
      () => client.getUser("alice", caller.signal),
      () => client.getUserByUsername("alice", caller.signal),
      () => client.getChannel(CHANNEL, caller.signal),
      () => client.getPost("root1", caller.signal),
      () =>
        client.createPost(
          { channel_id: CHANNEL, message: "hello" },
          caller.signal
        ),
      () => client.getChannelPostsSince(CHANNEL, 0, caller.signal),
      () => client.createDirectChannel(BOT.id, "alice", caller.signal),
      () => client.sendTyping(BOT.id, CHANNEL, undefined, caller.signal),
      () => client.addReaction(BOT.id, "root1", "eyes", caller.signal),
      () => client.removeReaction(BOT.id, "root1", "eyes", caller.signal),
      () =>
        client.uploadFile(
          CHANNEL,
          new Uint8Array([1]),
          "a.txt",
          undefined,
          caller.signal
        ),
      () => client.downloadFile("file1", caller.signal),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ name: "AbortError" });
    }
    expect(server.requests).toEqual([]);
  });

  it("bounds successful indicator response bodies", async () => {
    vi.useFakeTimers();
    const client = new MattermostRestClient(
      URL_,
      TOKEN,
      async () => new Response(new ReadableStream(), { status: 200 }),
      1,
      { requestTimeoutMs: 30 }
    );
    const calls = [
      () => client.sendTyping(BOT.id, CHANNEL),
      () => client.addReaction(BOT.id, "root1", "eyes"),
      () => client.removeReaction(BOT.id, "root1", "eyes"),
    ];
    for (const call of calls) {
      let result: unknown;
      void call().catch((error: unknown) => {
        result = error;
      });
      await vi.advanceTimersByTimeAsync(30);
      expect(result).toMatchObject({ name: "TimeoutError" });
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("keeps tokens out of transport failures and echoed server messages", async () => {
    const client = new MattermostRestClient(URL_, TOKEN, async () => {
      throw new Error(`could not send ${TOKEN}`);
    });
    await expect(client.getMe()).rejects.toThrow(
      "Mattermost GET /users/me failed"
    );
    const server = new FakeMattermost();
    server.overrides.push({
      match: (_method, path) => path === "/users/me",
      reply: {
        status: 401,
        body: { id: TOKEN, message: `Invalid token ${TOKEN}` },
      },
    });
    const error = await new MattermostRestClient(URL_, TOKEN, server.fetch)
      .getMe()
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      status: 401,
      serverId: "[redacted]",
      message:
        "Mattermost GET /users/me failed with 401: Invalid token [redacted]",
    });
  });

  it("bounds error bodies without retrying the timeout", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async () => new Response(new ReadableStream(), { status: 400 })
    );
    const client = new MattermostRestClient(URL_, TOKEN, fetch, 1, {
      requestTimeoutMs: 30,
    });
    let result: unknown;
    void client.getMe().catch((error: unknown) => {
      result = error;
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(result).toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses one deadline across all retry attempts and waits", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => Response.json({}, { status: 503 }));
    const client = new MattermostRestClient(URL_, TOKEN, fetch, 20, {
      requestTimeoutMs: 30,
    });
    let result: unknown;
    void client.getMe().catch((error: unknown) => {
      result = error;
    });
    await vi.advanceTimersByTimeAsync(29);
    expect(result).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes caller listeners and deadlines after success and HTTP failure", async () => {
    vi.useFakeTimers();
    for (const status of [200, 401]) {
      const caller = new AbortController();
      const add = vi.spyOn(caller.signal, "addEventListener");
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      const client = new MattermostRestClient(URL_, TOKEN, async () =>
        Response.json({}, { status })
      );
      await client.getMe(caller.signal).catch(() => undefined);
      expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("gives caller cancellation priority when its deadline also expires", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    setTimeout(() => caller.abort(new Error(TOKEN)), 30);
    const client = new MattermostRestClient(
      URL_,
      TOKEN,
      () => new Promise<Response>(() => undefined),
      1,
      { requestTimeoutMs: 30 }
    );
    let result: unknown;
    void client.getMe(caller.signal).catch((error: unknown) => {
      result = error;
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(result).toMatchObject({
      name: "AbortError",
      message: "Mattermost GET /users/me cancelled",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("authenticates with the bearer token in the header only", async () => {
    const server = new FakeMattermost();
    const client = new MattermostRestClient(URL_, TOKEN, server.fetch);
    await expect(client.getMe()).resolves.toMatchObject({ id: BOT.id });
    expect(server.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(server.requests[0].path).not.toContain(TOKEN);
  });

  it("creates posts in a thread and sends typing with the parent id", async () => {
    const server = new FakeMattermost();
    const client = new MattermostRestClient(URL_, TOKEN, server.fetch);
    await client.createPost({
      channel_id: CHANNEL,
      message: "hi",
      root_id: "root1",
    });
    await client.sendTyping(BOT.id, CHANNEL, "root1");
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/posts",
      body: { channel_id: CHANNEL, message: "hi", root_id: "root1" },
    });
    expect(server.requests[1]).toMatchObject({
      method: "POST",
      path: `/users/${BOT.id}/typing`,
      body: { channel_id: CHANNEL, parent_id: "root1" },
    });
  });

  it("adds and removes reactions by emoji name", async () => {
    const server = new FakeMattermost();
    const client = new MattermostRestClient(URL_, TOKEN, server.fetch);
    await client.addReaction(BOT.id, "p1", "eyes");
    await client.removeReaction(BOT.id, "p1", "eyes");
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /reactions",
      `DELETE /users/${BOT.id}/posts/p1/reactions/eyes`,
    ]);
    expect(server.requests[0].body).toEqual({
      user_id: BOT.id,
      post_id: "p1",
      emoji_name: "eyes",
    });
  });

  it("uploads files as multipart with the channel id", async () => {
    const server = new FakeMattermost();
    const client = new MattermostRestClient(URL_, TOKEN, server.fetch);
    const info = await client.uploadFile(
      CHANNEL,
      new Uint8Array([1, 2]),
      "a.txt",
      "text/plain"
    );
    expect(info.id).toBeTruthy();
    const body = server.requests[0].body as FormData;
    expect(body.get("channel_id")).toBe(CHANNEL);
    expect((body.get("files") as File).name).toBe("a.txt");
  });

  it("retries a rate-limited call, then succeeds", async () => {
    const server = new FakeMattermost();
    server.overrides.push({
      match: (method, path) => method === "GET" && path === "/users/me",
      reply: { status: 429, body: { message: "slow down" } },
    });
    const client = new MattermostRestClient(URL_, TOKEN, server.fetch, 1);
    await expect(client.getMe()).resolves.toMatchObject({ id: BOT.id });
    expect(server.requests).toHaveLength(2);
  });

  it("reports failures with the server message and never the token", async () => {
    const server = new FakeMattermost();
    const client = new MattermostRestClient(
      URL_,
      "wrong-token-value",
      server.fetch
    );
    const error = await client.getMe().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MattermostApiError);
    expect((error as MattermostApiError).status).toBe(401);
    expect(String((error as Error).message)).toContain(
      "Invalid or expired session"
    );
    expect(String((error as Error).message)).not.toContain("wrong-token-value");
  });
});
