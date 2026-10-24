import { describe, expect, it } from "vitest";
import {
  MattermostApiError,
  MattermostRestClient,
  normalizeBaseUrl,
} from "./client.js";
import { BOT, CHANNEL, FakeMattermost, TOKEN } from "./test-fakes.js";

const URL_ = "https://chat.example.test";

describe("MattermostRestClient", () => {
  it("normalizes the server url an operator pastes", () => {
    expect(normalizeBaseUrl("https://chat.example.test/")).toBe(URL_);
    expect(normalizeBaseUrl("https://chat.example.test/api/v4/")).toBe(URL_);
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
