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
    expect(await saved.json()).toEqual({ agentIds: ["pilot"] });
    expect(await (await gateway.request("bob", route)).json()).toEqual({ agentIds: [] });
    expect((await gateway.request("alice", route, save([""]))).status).toBe(400);
    expect((await gateway.request("alice", route, save([42]))).status).toBe(400);
    expect((await gateway.request("bob", route, save(["pilot"]))).status).toBe(200);
    const setPublic = (isPublic: boolean) => gateway.request("alice", "/api/admin/forks/pilot/visibility", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ public: isPublic }),
    });
    expect((await setPublic(false)).status).toBe(200);
    expect(await (await gateway.request("bob", route)).json()).toEqual({ agentIds: [] });
    expect((await setPublic(true)).status).toBe(200);
    expect(await (await gateway.request("bob", route)).json()).toEqual({ agentIds: ["pilot"] });
    expect((await setPublic(false)).status).toBe(200);
    expect((await gateway.request("bob", route, save(["pilot"]))).status).toBe(200);
    expect((await setPublic(true)).status).toBe(200);
    await gateway.restart();
    expect(await (await gateway.request("alice", route)).json()).toEqual({ agentIds: ["pilot"] });
    expect(await (await gateway.request("bob", route)).json()).toEqual({ agentIds: [] });
  } finally {
    await gateway.close();
  }
}, 10_000);
