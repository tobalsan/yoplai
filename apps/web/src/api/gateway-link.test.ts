// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GatewayLinkApiError,
  approveGatewayLink,
  denyGatewayLink,
  describeGatewayLinkError,
  fetchGatewayLinkConsent,
  fetchGatewayLinks,
  revokeGatewayLink,
} from "./gateway-link";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response.clone());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("gateway link remote API client", () => {
  it("reads the consent view of one request with credentials", async () => {
    const fetchMock = stubFetch(Response.json({ requestId: "r/1", status: "pending" }));
    await expect(fetchGatewayLinkConsent("r/1")).resolves.toMatchObject({ status: "pending" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/gateway-link/requests/r%2F1");
    expect(init?.credentials).toBe("include");
  });

  it("posts the request ID and nonce as JSON for approve and refuse and returns the callback address", async () => {
    const fetchMock = stubFetch(Response.json({ redirectUrl: "http://127.0.0.1:4555/api/relay/link/callback#code=c&state=s" }));
    await expect(approveGatewayLink("r1", "n1")).resolves.toBe("http://127.0.0.1:4555/api/relay/link/callback#code=c&state=s");
    await denyGatewayLink("r1", "n1");
    const [approveCall, denyCall] = fetchMock.mock.calls;
    expect(approveCall![0]).toBe("/api/auth/gateway-link/approve");
    expect(denyCall![0]).toBe("/api/auth/gateway-link/deny");
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({ requestId: "r1", nonce: "n1" });
    }
  });

  it("lists links and revokes one by its ID", async () => {
    const fetchMock = stubFetch(Response.json({ links: [{ id: "l1" }] }));
    await expect(fetchGatewayLinks()).resolves.toEqual([{ id: "l1" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/gateway-link/links");
    const revokeMock = stubFetch(Response.json({ id: "l1", status: "revoked" }));
    await revokeGatewayLink("l1");
    expect(revokeMock.mock.calls[0]![0]).toBe("/api/auth/gateway-link/revoke");
    expect(JSON.parse(String(revokeMock.mock.calls[0]![1]?.body))).toEqual({ linkId: "l1" });
  });

  it("turns an error answer into an error with the code, the status, and a readable message", async () => {
    stubFetch(Response.json({ error: "request_not_pending" }, { status: 409 }));
    const failure = await approveGatewayLink("r1", "n1").catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(GatewayLinkApiError);
    expect(failure).toMatchObject({ code: "request_not_pending", status: 409 });
    expect((failure as Error).message).toBe(describeGatewayLinkError("request_not_pending"));
    stubFetch(new Response("<html>", { status: 502 }));
    const unreadable = await fetchGatewayLinks().catch((cause: unknown) => cause);
    expect(unreadable).toMatchObject({ code: "request_failed", status: 502 });
    expect(describeGatewayLinkError("anything-else")).toBe("The request failed. Try again.");
  });
});
