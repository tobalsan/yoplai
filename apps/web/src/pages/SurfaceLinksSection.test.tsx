// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { fireEvent, within } from "@testing-library/dom";
import { SurfaceLinksSection } from "./SurfaceLinksSection";

const link = { id: "link-threadit", surface: "threadit", scope: "https://board.example.test", externalId: "31", username: "river", linkedAt: 1704067200000 };
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let root: HTMLDivElement;
let dispose: () => void;
let available: boolean[];

const mount = () => {
  dispose = render(() => <SurfaceLinksSection gateway="ams" ownerId={() => "alice"} onAvailable={(value) => available.push(value)} />, root);
};
const calls = () => fetchMock.mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${String(input)}`);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  available = [];
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  dispose?.();
  root.remove();
  vi.unstubAllGlobals();
});

describe("SurfaceLinksSection on a linked gateway", () => {
  it("lists the links of the gateway and unlinks one", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ links: [link] }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ links: [] }));
    mount();
    await tick();
    expect(within(root).getByText("Threadit @river")).toBeTruthy();
    fireEvent.click(within(root).getByRole("button", { name: "Unlink" }));
    await tick();
    expect(calls()).toEqual([
      "GET /api/relay/gateways/ams/api/surface-links",
      "DELETE /api/relay/gateways/ams/api/surface-links/link-threadit",
      "GET /api/relay/gateways/ams/api/surface-links",
    ]);
    expect(within(root).getByText("No Threadit or Mattermost accounts are linked.")).toBeTruthy();
  });

  it.each([
    [404, { error: "extension_disabled" }],
    [409, { error: "multi_user_required" }],
    [404, undefined],
  ])("hides itself for %i %j", async (status, body) => {
    fetchMock.mockResolvedValue(body ? Response.json(body, { status }) : new Response("404 Not Found", { status }));
    mount();
    await tick();
    expect(within(root).queryByRole("heading", { name: "Threadit and Mattermost" })).toBeNull();
    expect(within(root).queryByRole("alert")).toBeNull();
    expect(available.at(-1)).toBe(false);
  });

  it("shows an error when the gateway is offline", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "gateway_offline" }, { status: 502 }));
    mount();
    await tick();
    expect(within(root).getByRole("alert").textContent).toBe("The remote gateway is offline.");
  });

  it("shows an error when the gateway refuses the key", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "login_required" }, { status: 401 }));
    mount();
    await tick();
    expect(within(root).getByRole("alert").textContent).toBe("The remote gateway refused this action.");
  });

  it("keeps the unlink error when the read after it says not available", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ links: [link] }))
      .mockResolvedValueOnce(Response.json({ error: "gateway_offline" }, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ error: "extension_disabled" }, { status: 404 }));
    mount();
    await tick();
    fireEvent.click(within(root).getByRole("button", { name: "Unlink" }));
    await tick();
    expect(within(root).getAllByRole("alert")[0]!.textContent).toBe("The remote gateway is offline.");
    expect(within(root).getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
