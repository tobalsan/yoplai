import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayLinkApiError, cancelLink, disconnectLink, fetchLinkRows, fetchLinkStatus, startLink } from "./relay-link";

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const lastCall = () => {
  const [input, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(input), init: init ?? {}, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined };
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("relay link client", () => {
  it("starts a link with the address and the optional name only", async () => {
    fetchMock.mockImplementation(async () => json(201, { attemptId: "a", controlToken: "c", expiresAt: "2026-01-01T00:05:00.000Z", consentUrl: "https://remote.example.test/gateway-link?request=r" }));
    expect(await startLink("https://remote.example.test", "work")).toMatchObject({ kind: "pending", attemptId: "a", controlToken: "c" });
    expect(lastCall()).toMatchObject({ url: "/api/relay/link/start", body: { remote: "https://remote.example.test", name: "work" } });
    await startLink("https://remote.example.test");
    expect(lastCall().body).toEqual({ remote: "https://remote.example.test" });
  });

  it("returns a linked answer for a remote that needs no sign-in", async () => {
    fetchMock.mockResolvedValue(json(200, { status: "linked", name: "open" }));
    expect(await startLink("https://remote.example.test")).toEqual({ kind: "linked", name: "open" });
  });

  it("sends the control token in a header, never in the address", async () => {
    fetchMock.mockImplementation(async () => json(200, { status: "pending", name: "work", remote: "https://remote.example.test" }));
    await fetchLinkStatus("attempt-1", "control-secret");
    const call = lastCall();
    expect(call.url).toBe("/api/relay/link/status/attempt-1");
    expect(call.url).not.toContain("control-secret");
    expect(new Headers(call.init.headers).get("x-link-control")).toBe("control-secret");
    await cancelLink("attempt-1", "control-secret");
    expect(lastCall()).toMatchObject({ url: "/api/relay/link/cancel", body: { attemptId: "attempt-1" } });
    expect(new Headers(lastCall().init.headers).get("x-link-control")).toBe("control-secret");
  });

  it("reads saved links with POST, and disconnects by name", async () => {
    fetchMock.mockResolvedValue(json(200, { gateways: [{ name: "work" }] }));
    expect(await fetchLinkRows()).toEqual([{ name: "work" }]);
    expect(lastCall()).toMatchObject({ url: "/api/relay/link/metadata", body: {} });
    expect(lastCall().init.method).toBe("POST");
    fetchMock.mockImplementation(async () => json(200, { name: "work", revoked: "remote" }));
    await disconnectLink("work");
    expect(lastCall().body).toEqual({ name: "work", localOnly: false });
    await disconnectLink("work", true);
    expect(lastCall().body).toEqual({ name: "work", localOnly: true });
  });

  it("raises the plain message of the gateway on an error", async () => {
    fetchMock.mockResolvedValue(json(409, { error: "name_in_use", message: "A gateway named work is already linked." }));
    const failure = await startLink("https://remote.example.test", "work").catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(RelayLinkApiError);
    expect(failure).toMatchObject({ code: "name_in_use", status: 409, message: "A gateway named work is already linked." });
    fetchMock.mockResolvedValue(new Response("not json", { status: 500 }));
    await expect(fetchLinkRows()).rejects.toMatchObject({ code: "request_failed", status: 500 });
  });
});
