import { expect, it } from "vitest";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

it("retains each authenticated account's visible sidebar order across restart", async () => {
  const gateway = await startDurableTestGateway({ multiUser: true, enableDurableMode: false });
  const route = "/api/me/sidebar-order";
  const save = (agentIds: unknown): RequestInit => ({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentIds }),
  });
  try {
    expect((await gateway.request("local", route)).status).toBe(401);
    expect((await gateway.request("local", route, save(["pilot"]))).status).toBe(401);
    expect(await (await gateway.request("alice", route)).json()).toEqual({ agentIds: [] });
    const saved = await gateway.request("alice", route, save(["unknown", "pilot", "pilot"]));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ agentIds: ["pilot"], updatedAt: expect.any(String) });
    expect(await (await gateway.request("bob", route)).json()).toEqual({ agentIds: [] });
    expect((await gateway.request("alice", route, save([""]))).status).toBe(400);
    expect((await gateway.request("alice", route, save([42]))).status).toBe(400);
    expect((await gateway.request("bob", route, save(["pilot"]))).status).toBe(200);
    const setPublic = (isPublic: boolean) => gateway.request("alice", "/api/admin/forks/pilot/visibility", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ public: isPublic }),
    });
    expect((await setPublic(false)).status).toBe(200);
    expect(await (await gateway.request("bob", route + "?local=1")).json()).toEqual({ agentIds: [], updatedAt: expect.any(String) });
    expect((await setPublic(true)).status).toBe(200);
    expect(await (await gateway.request("bob", route)).json()).toEqual({ agentIds: ["pilot"], updatedAt: expect.any(String) });
    expect((await setPublic(false)).status).toBe(200);
    expect((await gateway.request("bob", route, save([]))).status).toBe(200);
    expect((await setPublic(true)).status).toBe(200);
    await gateway.restart();
    expect(await (await gateway.request("alice", route)).json()).toEqual({ agentIds: ["pilot"], updatedAt: expect.any(String) });
    expect(await (await gateway.request("bob", route)).json()).toEqual({ agentIds: ["pilot"], updatedAt: expect.any(String) });
  } finally {
    await gateway.close();
  }
}, 10_000);

it("accepts only newer sync orders with valid timestamps", async () => {
  const gateway = await startDurableTestGateway({ multiUser: true, enableDurableMode: false, additionalAgents: [{ id: "scout" }] });
  const route = "/api/me/sidebar-order";
  const sync = (agentIds: string[], updatedAt: unknown) => gateway.request("alice", route, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentIds, updatedAt }),
  });
  try {
    const expected = { agentIds: ["pilot", "scout"], updatedAt: "2026-08-01T12:00:00.000Z" };
    const saved = await sync(expected.agentIds, expected.updatedAt);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual(expected);
    const swapped = ["scout", "pilot"];
    expect(await (await sync(swapped, "2026-08-01T11:00:00.000Z")).json()).toEqual(expected);
    expect(await (await sync(swapped, expected.updatedAt)).json()).toEqual(expected);
    const newer = { agentIds: swapped, updatedAt: "2026-08-01T13:00:00.000Z" };
    expect(await (await sync(swapped, newer.updatedAt)).json()).toEqual(newer);
    expect((await sync([], "not a timestamp")).status).toBe(400);
    expect((await sync([], "2026-08-01T12:00:00+99:99")).status).toBe(400);
    expect((await sync([], null)).status).toBe(400);
    expect(await (await gateway.request("alice", route)).json()).toEqual(newer);
  } finally {
    await gateway.close();
  }
}, 10_000);
