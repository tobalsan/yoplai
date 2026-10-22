// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { getByRole, queryByRole, within } from "@testing-library/dom";
import { McpServerDetails } from "./McpServerDetails";

vi.mock("../auth/client", () => ({ useSession: () => () => ({ isPending: false, data: { user: { id: "alice" } } }) }));
const route = createStore({ agentId: "fast-details", serverName: "docs" });
vi.mock("@solidjs/router", () => ({
  A: (props: { href: string; children: JSX.Element }) => <a href={props.href}>{props.children}</a>,
  useParams: () => route[0],
  useNavigate: () => vi.fn(),
}));
const json = (value: unknown) => new Response(JSON.stringify(value));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const docs = { name: "docs", title: "Docs", type: "http", url: "https://docs.test/mcp", auth: "oauth", state: "disconnected", personalState: "connected", teamState: "disconnected", personalAccount: "alice@example.test", status: "pending", readOnly: true };
let dispose: (() => void) | undefined;
beforeEach(() => { route[1]({ agentId: "fast-details", serverName: "docs" }); });
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it.each([
  { personalState: "connected", label: "Connected", reconnect: false },
  { personalState: "needs_reconnect", label: "Reconnect", reconnect: true },
])("paints a fast $personalState personal grant before live status and preserves it through an outage and retry", async ({ personalState, label, reconnect }) => {
  const configured = { ...docs, personalState };
  const paintedAtStatusStart: boolean[] = [];
  const live = Promise.withResolvers<Response>();
  const requests: string[] = [];
  let outcome: Response | Promise<Response> = live.promise;
  vi.stubGlobal("fetch", (input: string) => {
    requests.push(input);
    if (input === "/api/mcp/servers?agent=fast-details&live=0&server=docs") return Promise.resolve(json({ servers: [configured], canConfigureTeam: false }));
    if (input === "/api/mcp/servers?agent=fast-details&server=docs") {
      paintedAtStatusStart.push(!!queryByRole(document.body, "heading", { name: "Docs" }) && !!queryByRole(document.body, "button", { name: reconnect ? "Reconnect" : "Disconnect" }));
      return Promise.resolve(outcome);
    }
    throw new Error(`Unexpected request ${input}`);
  });
  dispose = render(() => <McpServerDetails />, document.body);
  await tick(); await tick();
  expect(getByRole(document.body, "heading", { name: "Docs" })).toBeTruthy();
  expect(getByRole(document.body, "tab", { name: /Just me/ }).getAttribute("aria-selected")).toBe("true");
  expect(getByRole(document.body, "button", { name: "Disconnect" })).toBeTruthy();
  expect(!!queryByRole(document.body, "button", { name: "Reconnect" })).toBe(reconnect);
  if (!reconnect) expect(document.body.textContent).toContain("alice@example.test");
  expect(document.body.textContent).toContain("Checking…");
  expect(paintedAtStatusStart).toEqual([true]);
  expect(requests).toEqual(["/api/mcp/servers?agent=fast-details&live=0&server=docs", "/api/mcp/servers?agent=fast-details&server=docs"]);

  live.resolve(json({ servers: [{ ...configured, state: "unreachable", status: undefined }], canConfigureTeam: false }));
  await tick();
  expect(document.body.textContent).toContain("Unreachable");
  expect(getByRole(document.body, "button", { name: "Disconnect" })).toBeTruthy();
  expect(!!queryByRole(document.body, "button", { name: "Reconnect" })).toBe(reconnect);
  expect(within(getByRole(document.body, "tab", { name: /Just me/ })).getByText(label)).toBeTruthy();

  outcome = new Response("Unavailable", { status: 503 });
  getByRole(document.body, "button", { name: "Retry" }).click();
  await tick();
  expect(document.body.textContent).toContain("Failed to check status.");
  outcome = json({ servers: [{ ...configured, state: "connected", status: undefined }], canConfigureTeam: false });
  getByRole(document.body, "button", { name: "Retry" }).click();
  await tick();
  expect(document.body.textContent).not.toContain("Failed to check status.");
  expect(document.body.textContent).not.toContain("Unreachable");
  expect(getByRole(document.body, "status").textContent).toBe("Connected");
  expect(requests.filter((request) => request.includes("live=0"))).toHaveLength(1);
});

it("leaves a disabled shared server available to enable without checking it on focus or OAuth return", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", (input: string) => {
    requests.push(input);
    return Promise.resolve(json({ servers: [{ ...docs, shared: true, enabled: false }], canConfigureTeam: false }));
  });
  dispose = render(() => <McpServerDetails />, document.body);
  await tick(); await tick();
  expect(getByRole(document.body, "button", { name: "Enable" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("Checking…");
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new MessageEvent("message", { data: { type: "yoplai-oauth", extension: "mcp" } }));
  await tick();
  expect(requests).toEqual(["/api/mcp/servers?agent=fast-details&live=0&server=docs"]);
  expect(document.body.textContent).not.toContain("Checking…");
});

it("ignores older overlapping checks and resets the selected credential scope when navigating to another agent", async () => {
  const old = Promise.withResolvers<Response>();
  const newest = Promise.withResolvers<Response>();
  let checks = 0;
  vi.stubGlobal("fetch", (input: string) => {
    if (input === "/api/mcp/servers?agent=fast-details&live=0&server=docs") return Promise.resolve(json({ servers: [{ ...docs, personalState: "disconnected", teamState: "connected" }] }));
    if (input === "/api/mcp/servers?agent=fast-details&server=docs") return ++checks === 1 ? old.promise : newest.promise;
    if (input === "/api/mcp/servers?agent=other-agent&live=0&server=docs") return Promise.resolve(json({ servers: [{ ...docs, title: "Other Docs" }] }));
    if (input === "/api/mcp/servers?agent=other-agent&server=docs") return new Promise<Response>(() => {});
    throw new Error(`Unexpected request ${input}`);
  });
  dispose = render(() => <McpServerDetails />, document.body);
  await tick(); await tick();
  expect(getByRole(document.body, "tab", { name: /Whole team/ }).getAttribute("aria-selected")).toBe("true");
  window.dispatchEvent(new Event("focus"));
  newest.resolve(json({ servers: [{ ...docs, state: "connected", status: undefined, personalState: "disconnected", teamState: "connected" }] }));
  await tick();
  old.resolve(json({ servers: [{ ...docs, state: "unreachable", status: undefined, title: "Old Docs" }] }));
  await tick();
  expect(document.body.textContent).not.toContain("Unreachable");
  expect(queryByRole(document.body, "heading", { name: "Old Docs" })).toBeNull();
  route[1]("agentId", "other-agent");
  await tick(); await tick();
  expect(getByRole(document.body, "heading", { name: "Other Docs" })).toBeTruthy();
  expect(getByRole(document.body, "tab", { name: /Just me/ }).getAttribute("aria-selected")).toBe("true");
  expect(getByRole(document.body, "button", { name: "Disconnect" })).toBeTruthy();
});
