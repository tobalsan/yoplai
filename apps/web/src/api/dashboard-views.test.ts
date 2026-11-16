import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardViewError, prepareDashboardView, readDashboardView } from "./dashboard-views";

const handle = "h".repeat(43);
const id = "d".repeat(32);
const meta = { dashboardId: id, agentId: "agent-7", canWrite: true, canEdit: true, chat: { sessionId: "s1" }, annotation: true };
const prepared = { handle, instance: "i1", shellUrl: `/api/relay/dashboard-views/${handle}/shell`, expiresAt: "2030-01-01T00:00:00.000Z", gateway: "east", dashboardId: id };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn();
const signal = new AbortController().signal;
const request = { gateway: "east", dashboardId: id, theme: "dark" as const };

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("dashboard view requests", () => {
  it("prepares with a same-origin JSON body that has only the allowed fields", async () => {
    fetchMock.mockResolvedValue(reply(201, prepared));
    await expect(prepareDashboardView({ ...request, query: "week=3" }, signal)).resolves.toMatchObject({ handle, instance: "i1", expiresAt: Date.parse(prepared.expiresAt) });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/relay/dashboard-views");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ gateway: "east", dashboardId: id, query: "week=3", theme: "dark" });
  });

  it("leaves out an empty query", async () => {
    fetchMock.mockResolvedValue(reply(201, prepared));
    await prepareDashboardView({ ...request, query: "" }, signal);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ gateway: "east", dashboardId: id, theme: "dark" });
  });

  it("raises a typed error with its reason and owner name, and no other body field", async () => {
    fetchMock.mockResolvedValue(reply(403, { error: "forbidden", ownerName: "Ada", handle: "leak" }));
    const error = await prepareDashboardView(request, signal).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DashboardViewError);
    expect(error).toMatchObject({ status: 403, code: "forbidden", ownerName: "Ada" });
    fetchMock.mockResolvedValue(reply(409, { error: "remote_update_required", reason: "asset_version" }));
    await expect(prepareDashboardView(request, signal)).rejects.toMatchObject({ status: 409, code: "remote_update_required", reason: "asset_version" });
  });

  it("refuses a prepare answer that names another gateway, dashboard, or shell path", async () => {
    for (const bad of [
      { ...prepared, gateway: "west" }, { ...prepared, dashboardId: "x".repeat(32) }, { ...prepared, shellUrl: "/api/relay/dashboard-views/other/shell" },
      { ...prepared, handle: "short", shellUrl: "/api/relay/dashboard-views/short/shell" }, { ...prepared, instance: "" }, { ...prepared, expiresAt: "soon" },
    ]) {
      fetchMock.mockResolvedValue(reply(201, bad));
      await expect(prepareDashboardView(request, signal)).rejects.toMatchObject({ code: "invalid_response" });
    }
    fetchMock.mockResolvedValue(reply(200, prepared));
    await expect(prepareDashboardView(request, signal)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reads the checked metadata with the handle in the body only", async () => {
    fetchMock.mockResolvedValue(reply(200, { expiresAt: prepared.expiresAt, state: "delivered", gateway: "east", dashboardId: id, meta }));
    await expect(readDashboardView(handle, signal)).resolves.toMatchObject({ state: "delivered", meta });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/relay/dashboard-views/read");
    expect(JSON.parse(init.body)).toEqual({ handle });
  });

  it("refuses metadata with an extra field, a wrong type, or annotation without Chat", async () => {
    for (const bad of [
      { ...meta, token: "secret" }, { ...meta, canWrite: "yes" }, { ...meta, chat: null }, { ...meta, chat: { sessionId: 3 } }, { ...meta, agentId: "" }, "meta",
    ]) {
      fetchMock.mockResolvedValue(reply(200, { expiresAt: prepared.expiresAt, state: "ready", gateway: "east", dashboardId: id, meta: bad }));
      await expect(readDashboardView(handle, signal)).rejects.toMatchObject({ code: "invalid_response" });
    }
    fetchMock.mockResolvedValue(reply(200, { expiresAt: prepared.expiresAt, state: "ready", gateway: "east", dashboardId: id, meta: { ...meta, chat: null, annotation: false } }));
    await expect(readDashboardView(handle, signal)).resolves.toMatchObject({ meta: { chat: null } });
  });

  it("reports an expired view as a typed 410 and an unreadable body as unknown", async () => {
    fetchMock.mockResolvedValue(reply(410, { state: "expired", error: "dashboard_view_expired", status: 410 }));
    await expect(readDashboardView(handle, signal)).rejects.toMatchObject({ status: 410, code: "dashboard_view_expired" });
    fetchMock.mockResolvedValue(new Response("<html>", { status: 502 }));
    await expect(readDashboardView(handle, signal)).rejects.toMatchObject({ status: 502, code: "unknown" });
  });
});
