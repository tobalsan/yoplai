import { expect, it, vi } from "vitest";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

type Gateway = Awaited<ReturnType<typeof startDurableTestGateway>>;

function jsonPost(body: object) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function createProject(gateway: Gateway, user: "local" | "alice", name: string) {
  const response = await gateway.request(user, "/api/chat-projects", jsonPost({ name }));
  expect(response.status).toBe(201);
  return await response.json() as { id: string; name: string };
}

it("keeps an existing project private and opens its room for the local owner", async () => {
  const gateway = await startDurableTestGateway({ enableDurableMode: false });
  try {
    const project = await createProject(gateway, "local", "Orchard");
    const list = async () => {
      const response = await gateway.request("local", "/api/rooms");
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await list()).toEqual({ items: [] });

    const room = "/api/rooms/" + project.id;
    const detail = await gateway.request("local", room);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual({
      id: project.id, name: "Orchard", ownerUserId: "local", role: "owner", members: [], agents: [],
    });
    expect(await list()).toEqual({ items: [
      { id: project.id, name: "Orchard", ownerUserId: "local", role: "owner" },
    ] });
    expect(await (await gateway.request("local", room + "/feed")).json()).toEqual({
      items: [], hasBefore: false, hasAfter: false, live: null, roomRuns: [],
    });
    expect((await gateway.request("local", "/api/chat-projects/" + project.id)).status).toBe(200);
  } finally {
    await gateway.close();
  }
});

it("persists each valid local send once, including concurrent retries and retries after restart", async () => {
  const gateway = await startDurableTestGateway({ enableDurableMode: false });
  try {
    const project = await createProject(gateway, "local", "Orchard");
    const room = "/api/rooms/" + project.id;
    for (const invalid of [
      { message: "Pick pears" }, { clientSendId: "bad id", message: "Pick pears" },
      { clientSendId: "stop", message: " /stop " },
      { clientSendId: "upload", message: "Pick pears", attachments: [{ path: "/inbound/notes.txt", mimeType: "text/plain", filename: "notes.txt" }] },
    ]) {
      expect((await gateway.request("local", room + "/messages", jsonPost(invalid))).status).toBe(400);
    }

    expect((await gateway.request("local", room + "/members", jsonPost({ userId: "anyone" }))).status).toBe(400);

    const send = (clientSendId: string) => gateway.request("local", room + "/messages", jsonPost({
      clientSendId, message: "Pick pears",
    }));
    const results = await Promise.all([send("harvest"), send("harvest")]);
    expect(results.map(({ status }) => status)).toEqual([200, 200]);
    expect(await Promise.all(results.map((result) => result.json()))).toEqual(expect.arrayContaining([
      { id: "r_1", seq: 1, duplicate: false },
      { id: "r_1", seq: 1, duplicate: true },
    ]));
    const item = {
      id: "r_1", role: "user", sender: "Local user", surface: "web", text: "Pick pears", timestamp: expect.any(Number),
    };
    expect(await (await gateway.request("local", room + "/feed")).json()).toEqual({
      items: [item], hasBefore: false, hasAfter: false, live: null, roomRuns: [],
    });

    await gateway.restart();
    expect(await (await send("harvest")).json()).toEqual({ id: "r_1", seq: 1, duplicate: true });
    expect(await (await send("harvest-again")).json()).toEqual({ id: "r_2", seq: 2, duplicate: false });
    expect(await (await gateway.request("local", room + "/feed/messages/r_1")).json()).toEqual({
      ...item, reasoning: [], toolCalls: [],
    });
    expect((await gateway.request("local", room + "/feed/messages/r_3")).status).toBe(404);
    expect(await (await gateway.request("local", room + "/feed")).json()).toMatchObject({
      items: [{ id: "r_1" }, { id: "r_2" }],
    });
  } finally {
    await gateway.close();
  }
});

it("admits only current members, lets them catch up, and reserves management for the owner", async () => {
  const gateway = await startDurableTestGateway({ multiUser: true, enableDurableMode: false });
  try {
    const project = await createProject(gateway, "alice", "Orchard");
    const room = "/api/rooms/" + project.id;
    const bobId = gateway.accountId("bob");
    const carolId = gateway.accountId("carol");
    const send = (user: "alice" | "bob", clientSendId: string, message: string) =>
      gateway.request(user, room + "/messages", jsonPost({ clientSendId, message }));
    expect((await gateway.request("bob", "/api/chat-projects/" + project.id)).status).toBe(404);
    expect((await gateway.request("carol", room)).status).toBe(404);
    const original = { id: "r_1", seq: 1, duplicate: false };
    expect(await (await send("alice", "note", "Pear trees")).json()).toEqual(original);
    expect(await (await send("alice", "note", "Pear trees")).json()).toEqual({ ...original, duplicate: true });
    expect(await (await gateway.request("alice", room + "/feed")).json()).toMatchObject({ items: [{ id: "r_1" }] });
    expect(await (await send("alice", "note-2", "Pear trees")).json()).toEqual({ id: "r_2", seq: 2, duplicate: false });

    const add = (userId: string) => gateway.request("alice", room + "/members", jsonPost({ userId }));
    expect((await add("unknown-user")).status).toBe(400);
    const userPath = "/api/admin/users/" + carolId;
    expect((await gateway.request("alice", userPath, { ...jsonPost({ approved: false }), method: "PATCH" })).status).toBe(200);
    expect((await add(carolId)).status).toBe(400);
    expect((await gateway.request("alice", userPath, { ...jsonPost({ approved: true }), method: "PATCH" })).status).toBe(200);
    expect((await add(bobId)).status).toBe(200);
    expect((await add(bobId)).status).toBe(200);

    const summary = { id: project.id, name: "Orchard", role: "member", ownerUserId: gateway.accountId("alice") };
    expect(await (await gateway.request("bob", "/api/rooms")).json()).toEqual({ items: [summary] });
    expect(await (await gateway.request("bob", room)).json()).toEqual({ ...summary, members: [bobId], agents: [] });
    expect((await gateway.request("bob", "/api/chat-projects/" + project.id)).status).toBe(404);
    expect(await (await gateway.request("bob", room + "/feed")).json()).toMatchObject({
      items: [{ id: "r_1", sender: "alice" }, { id: "r_2", sender: "alice" }],
    });
    expect(await (await send("bob", "note", "Plum trees")).json()).toEqual({ id: "r_3", seq: 3, duplicate: false });
    expect(await (await gateway.request("bob", room + "/feed")).json()).toMatchObject({
      items: [{ id: "r_1" }, { id: "r_2" }, { id: "r_3", sender: "bob", text: "Plum trees" }],
    });

    for (const [query, ids, hasBefore, hasAfter] of [
      ["limit=1", ["r_3"], true, false],
      ["limit=1&before=r_2", ["r_1"], false, true],
      ["limit=1&after=r_2", ["r_3"], true, false],
      ["limit=2&around=r_2", ["r_1", "r_2"], false, true],
      ["limit=2&around=r_3", ["r_2", "r_3"], true, false],
      ["before=r_1", [], false, true],
      ["after=r_3", [], true, false],
    ] as const) {
      const response = await gateway.request("bob", room + "/feed?" + query);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ items: ids.map((id) => ({ id })), hasBefore, hasAfter, live: null });
    }
    for (const query of ["limit=0", "limit=201", "limit=1.5", "before=r_2&after=r_2", "around=r_1&around=r_2"]) {
      expect((await gateway.request("bob", room + "/feed?" + query)).status).toBe(400);
    }
    expect((await gateway.request("bob", room + "/feed?around=r_4")).status).toBe(404);

    const mutations = [
      ["/members", jsonPost({ userId: carolId })],
      ["/members/" + bobId, { method: "DELETE" }],
      ["/agents", jsonPost({ agentId: "pilot" })],
      ["/agents/pilot", { method: "DELETE" }],
    ] as const;
    for (const [suffix, init] of mutations) {
      expect((await gateway.request("bob", room + suffix, init)).status).toBe(403);
    }
    expect((await gateway.request("alice", room + "/members/" + gateway.accountId("alice"), { method: "DELETE" })).status).toBe(400);
    expect((await gateway.request("alice", room + "/agents", jsonPost({ agentId: "missing" }))).status).toBe(400);
    expect((await gateway.request("alice", room + "/agents", jsonPost({ agentId: "pilot" }))).status).toBe(200);
    expect(await (await gateway.request("bob", room)).json()).toMatchObject({ agents: ["pilot"] });
    expect((await gateway.request("alice", room + "/agents/pilot", { method: "DELETE" })).status).toBe(200);
    expect(await (await gateway.request("bob", room)).json()).toMatchObject({ agents: [] });

    expect(await (await gateway.request("carol", "/api/rooms")).json()).toEqual({ items: [] });
    for (const [suffix, init] of [
      ["", undefined], ["/feed", undefined], ["/feed/messages/r_1", undefined],
      ["/messages", jsonPost({ clientSendId: "note", message: "Outsider" })], ...mutations,
    ] as const) {
      const denied = await gateway.request("carol", room + suffix, init);
      const missing = await gateway.request("carol", "/api/rooms/missing-room" + suffix, init);
      expect(denied.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await denied.text()).toBe(await missing.text());
    }

    expect((await gateway.request("alice", room + "/members/" + bobId, { method: "DELETE" })).status).toBe(200);
    expect(await (await gateway.request("bob", "/api/rooms")).json()).toEqual({ items: [] });
    for (const [suffix, init] of [
      ["", undefined], ["/feed", undefined], ["/feed/messages/r_1", undefined],
      ["/messages", jsonPost({ clientSendId: "note", message: "Removed" })], ...mutations,
    ] as const) {
      expect((await gateway.request("bob", room + suffix, init)).status).toBe(404);
    }
  } finally {
    await gateway.close();
  }
});

it("streams room messages only to current members and rejects excluded reconnects", async () => {
  const gateway = await startDurableTestGateway({ multiUser: true, enableDurableMode: false });
  try {
    const { id } = await createProject(gateway, "alice", "Orchard");
    const room = "/api/rooms/" + id;
    const subscribe = { type: "subscribeRoomFeed", roomId: id, limit: 1 } as const;
    const denied = { type: "error", message: "Room not found" };
    const firstOutsider = await gateway.socket("carol");
    firstOutsider.send(subscribe);
    await vi.waitFor(() => expect(firstOutsider.events).toEqual([denied]));
    firstOutsider.close();
    const outsider = await gateway.socket("carol");
    outsider.send(subscribe);
    await vi.waitFor(() => expect(outsider.events).toEqual([denied]));
    const bobId = gateway.accountId("bob");
    expect((await gateway.request("alice", room + "/members", jsonPost({ userId: bobId }))).status).toBe(200);

    const watcher = await gateway.socket("bob");
    const owner = await gateway.socket("alice");
    watcher.send(subscribe);
    owner.send(subscribe);
    const snapshot = {
      type: "feed_snapshot", roomId: id, seq: 1, items: [], hasBefore: false, live: null, roomRuns: [],
    };
    await vi.waitFor(() => {
      expect(watcher.events).toEqual([snapshot]);
      expect(owner.events).toEqual([snapshot]);
    });
    const first = jsonPost({ clientSendId: "pear", message: "Pear trees" });
    expect((await gateway.request("alice", room + "/messages", first)).status).toBe(200);
    const delta = {
      type: "feed_delta", roomId: id, seq: 2, hasBefore: false, live: null, roomRuns: [],
      upsert: [{ id: "r_1", role: "user", sender: "alice", surface: "web", text: "Pear trees", timestamp: expect.any(Number) }],
    };
    await vi.waitFor(() => expect(watcher.events).toEqual([snapshot, delta]));
    expect(await (await gateway.request("alice", room + "/messages", first)).json()).toMatchObject({ duplicate: true });
    await watcher.flush();
    expect(watcher.events).toEqual([snapshot, delta]);

    const ended = { type: "feed_end", roomId: id, reason: "forbidden" };
    expect((await gateway.request("alice", room + "/members/" + bobId, { method: "DELETE" })).status).toBe(200);
    await vi.waitFor(() => expect(watcher.events).toEqual([snapshot, delta, ended]));
    expect((await gateway.request("alice", room + "/messages", jsonPost({ clientSendId: "plum", message: "Plum trees" }))).status).toBe(200);
    await vi.waitFor(() => expect(owner.events[2]).toMatchObject({
      type: "feed_delta", roomId: id, seq: 3, dropBefore: "r_2", upsert: [{ id: "r_2", text: "Plum trees" }], hasBefore: true,
    }));
    await watcher.flush();
    expect(watcher.events).toEqual([snapshot, delta, ended]);

    const reconnected = await gateway.socket("bob");
    reconnected.send(subscribe);
    await vi.waitFor(() => expect(reconnected.events).toEqual([denied]));

    owner.send(subscribe);
    await vi.waitFor(() => expect(owner.events[3]).toMatchObject({
      type: "feed_snapshot", roomId: id, seq: 1, items: [{ id: "r_2" }],
    }));
    owner.send({ type: "unsubscribeFeed" });
    await owner.flush();
    expect((await gateway.request("alice", room + "/messages", jsonPost({ clientSendId: "apple", message: "Apple trees" }))).status).toBe(200);
    await owner.flush();
    expect(owner.events).toHaveLength(4);
    await outsider.flush();
    expect(outsider.events).toEqual([denied]);
  } finally {
    await gateway.close();
  }
});

it("deletes the room and ends its existing watch when the owner deletes the project", async () => {
  const gateway = await startDurableTestGateway({ enableDurableMode: false });
  try {
    const { id } = await createProject(gateway, "local", "Orchard");
    const room = "/api/rooms/" + id;
    const message = jsonPost({ clientSendId: "pear", message: "Pear trees" });
    expect((await gateway.request("local", room + "/messages", message)).status).toBe(200);
    const watcher = await gateway.socket();
    watcher.send({ type: "subscribeRoomFeed", roomId: id });
    await vi.waitFor(() => expect(watcher.events).toMatchObject([
      { type: "feed_snapshot", roomId: id, items: [{ id: "r_1", text: "Pear trees" }] },
    ]));
    expect((await gateway.request("local", "/api/chat-projects/" + id, { method: "DELETE" })).status).toBe(200);
    await vi.waitFor(() => expect(watcher.events[1]).toEqual({
      type: "feed_end", roomId: id, reason: "forbidden",
    }));
    expect((await gateway.request("local", room)).status).toBe(404);
    expect(await (await gateway.request("local", "/api/rooms")).json()).toEqual({ items: [] });

    await gateway.restart();
    expect((await gateway.request("local", room + "/messages", message)).status).toBe(404);
    expect((await gateway.request("local", room + "/feed/messages/r_1")).status).toBe(404);
  } finally {
    await gateway.close();
  }
});

it("stops an open room feed when the member's account loses access", async () => {
  const gateway = await startDurableTestGateway({ multiUser: true, enableDurableMode: false, recheckMs: 50 });
  try {
    const { id } = await createProject(gateway, "alice", "Orchard");
    const room = "/api/rooms/" + id;
    const userId = gateway.accountId("bob");
    expect((await gateway.request("alice", room + "/members", jsonPost({ userId }))).status).toBe(200);
    const watcher = await gateway.socket("bob");
    const subscribe = { type: "subscribeRoomFeed", roomId: id } as const;
    watcher.send(subscribe);
    const snapshot = { type: "feed_snapshot", roomId: id, seq: 1, items: [], hasBefore: false, live: null, roomRuns: [] };
    await vi.waitFor(() => expect(watcher.events).toEqual([snapshot]));

    expect((await gateway.request("alice", "/api/admin/users/" + userId, {
      ...jsonPost({ approved: false }), method: "PATCH",
    })).status).toBe(200);
    expect(await (await gateway.request("alice", room)).json()).toMatchObject({ members: [userId] });
    expect((await gateway.request("alice", room + "/messages", jsonPost({
      clientSendId: "pear", message: "Pear trees",
    }))).status).toBe(200);
    const ended = { type: "feed_end", roomId: id, reason: "forbidden" };
    await vi.waitFor(() => expect(watcher.events).toEqual([snapshot, ended]));
    expect((await gateway.request("bob", room + "/feed")).status).toBe(403);
    watcher.send(subscribe);
    await vi.waitFor(() => expect(watcher.events).toEqual([snapshot, ended, { type: "error", message: "Room not found" }]));
  } finally {
    await gateway.close();
  }
});
