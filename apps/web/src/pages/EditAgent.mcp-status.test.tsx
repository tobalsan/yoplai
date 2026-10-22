// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createStore } from "solid-js/store";
import type { JSX } from "solid-js";
import { getAllByRole, getByRole, queryAllByRole, queryByRole, within } from "@testing-library/dom";
import { EditAgent } from "./EditAgent";
import { fetchMcpServers } from "../api/mcp-servers";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";

vi.mock("../auth/client", () => ({ useSession: () => () => ({ isPending: false, data: { user: { role: "user" } } }) }));
const route = createStore({ agentId: "status-order" });
vi.mock("@solidjs/router", () => ({
  A: (props: { href: string; children: JSX.Element; "aria-label"?: string }) => <a href={props.href} aria-label={props["aria-label"]}>{props.children}</a>,
  useParams: () => route[0],
  useLocation: () => ({ state: undefined }),
  useNavigate: () => vi.fn(),
}));

const json = (value: unknown) => new Response(JSON.stringify(value));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const server = (name: string, extra = {}) => ({ name, type: "http", url: `https://${name}.test/mcp`, auth: "none", state: "disconnected", status: "pending", readOnly: true, ...extra });
let dispose: (() => void) | undefined;
beforeEach(() => { setCapabilitiesForTests({ forkedAgents: false }); route[1]("agentId", "status-order"); });
afterEach(() => { dispose?.(); document.body.replaceChildren(); resetCapabilitiesForTests(); vi.unstubAllGlobals(); });

it("waits for all fast inputs, paints final Top/name order, then checks active cards independently without moving them", async () => {
  const top = Promise.withResolvers<Response>();
  const alpha = Promise.withResolvers<Response>();
  const zulu = Promise.withResolvers<Response>();
  const paintedAtStatusStart: boolean[] = [];
  const requests: string[] = [];
  vi.stubGlobal("fetch", (input: string) => {
    requests.push(input);
    if (input === "/api/agents") return Promise.resolve(json([{ id: "status-order", name: "Agent" }]));
    if (input.endsWith("/extensions")) return Promise.resolve(json({ extensions: [{ id: "notes", displayName: "Notes", description: "Notes", enabled: false }] }));
    if (input === "/api/top-extensions") return top.promise;
    if (input === "/api/mcp/servers?agent=status-order") return Promise.resolve(json({ servers: [server("alpha", { title: "ZZ cached live title", status: undefined, state: "connected" })] }));
    if (input.endsWith("&live=0")) return Promise.resolve(json({ servers: [server("zulu"), server("alpha"), server("beta", { shared: true, enabled: false })], canConfigureTeam: false }));
    if (input.endsWith("&server=alpha") || input.endsWith("&server=zulu")) {
      paintedAtStatusStart.push(!!queryByRole(document.body, "link", { name: /Alpha/ }) && !!queryByRole(document.body, "link", { name: /Zulu/ }) && queryAllByRole(document.body, "link", { name: /Notes/ }).length > 0);
      return input.endsWith("&server=alpha") ? alpha.promise : zulu.promise;
    }
    throw new Error(`Unexpected request ${input}`);
  });
  await fetchMcpServers("status-order");
  dispose = render(() => <EditAgent />, document.body);
  await tick(); await tick();
  expect(document.body.textContent).toContain("Loading agent extensions");
  expect(queryByRole(document.body, "link", { name: /Alpha/ })).toBeNull();
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(requests.filter((request) => request.includes("&server="))).toEqual([]);

  top.resolve(json({ extensions: [], mcp: ["https://zulu.test/mcp"], system: { extensions: [], mcp: [] } }));
  await tick(); await tick();
  const cards = getAllByRole(document.body, "listitem");
  expect(cards.map((card) => within(card).getAllByRole("link")[0]?.textContent)).toEqual(["Zuluhttps://zulu.test/mcp", "Alphahttps://alpha.test/mcp", "Betahttps://beta.test/mcp", "NotesNotes"]);
  expect(paintedAtStatusStart).toEqual([true, true]);
  expect(within(cards[0]!).getByRole("status").textContent).toBe("Checking…");
  expect(within(cards[1]!).getByRole("status").textContent).toBe("Checking…");
  expect(within(cards[2]!).queryByRole("status")).toBeNull();
  expect(requests.filter((request) => request.includes("&server=")).sort()).toEqual(["/api/mcp/servers?agent=status-order&server=alpha", "/api/mcp/servers?agent=status-order&server=zulu"]);

  alpha.resolve(json({ servers: [server("alpha", { title: "ZZ Live title", status: undefined, state: "connected" })], canConfigureTeam: false }));
  await tick();
  expect(getByRole(document.body, "img", { name: "alpha connected" })).toBeTruthy();
  expect(within(cards[0]!).getByRole("status").textContent).toBe("Checking…");
  expect(getAllByRole(document.body, "listitem").map((card) => within(card).getAllByRole("link")[0]?.textContent)).toEqual(["Zuluhttps://zulu.test/mcp", "ZZ Live titlehttps://alpha.test/mcp", "Betahttps://beta.test/mcp", "NotesNotes"]);
});

it("retries only an unreachable or failed card while another check hangs and reserves Reconnect for invalid grants", async () => {
  const requests: string[] = [];
  const outcomes = [
    json({ servers: [server("docs", { state: "unreachable", status: undefined })] }),
    new Response("Unavailable", { status: 503 }),
    json({ servers: [server("docs", { state: "connected", status: undefined })] }),
  ];
  vi.stubGlobal("fetch", (input: string) => {
    requests.push(input);
    if (input === "/api/agents") return Promise.resolve(json([{ id: "status-order", name: "Agent" }]));
    if (input.endsWith("/extensions")) return Promise.resolve(json({ extensions: [] }));
    if (input === "/api/top-extensions") return Promise.resolve(json({ extensions: [], mcp: [], system: { extensions: [], mcp: [] } }));
    if (input.endsWith("&live=0")) return Promise.resolve(json({ servers: [server("docs"), server("slow"), server("expired", { auth: "oauth", personalState: "needs_reconnect" })] }));
    if (input.endsWith("&server=docs")) return Promise.resolve(outcomes.shift()!);
    if (input.endsWith("&server=expired")) return Promise.resolve(json({ servers: [server("expired", { auth: "oauth", state: "needs_reconnect", personalState: "needs_reconnect", teamState: "connected", status: undefined })] }));
    if (input.endsWith("&server=slow")) return new Promise<Response>(() => {});
    throw new Error(`Unexpected request ${input}`);
  });
  dispose = render(() => <EditAgent />, document.body);
  await tick(); await tick();
  expect(document.body.textContent).toContain("Unreachable");
  expect(getByRole(document.body, "link", { name: "Reconnect expired" }).textContent).toBe("Reconnect");
  getByRole(document.body, "button", { name: "Retry docs" }).click();
  await tick();
  expect(document.body.textContent).toContain("Failed to check status.");
  getByRole(document.body, "button", { name: "Retry docs" }).click();
  await tick();
  expect(getByRole(document.body, "img", { name: "docs connected" })).toBeTruthy();
  expect(document.body.textContent).toContain("Checking…");
  expect(requests.filter((request) => request.endsWith("&server=slow"))).toHaveLength(1);
  expect(requests.filter((request) => request.endsWith("&live=0"))).toHaveLength(1);
});

it("refreshes live cards without fetching configuration again and ignores late checks after refresh or agent navigation", async () => {
  const older = Promise.withResolvers<Response>();
  const fresh = Promise.withResolvers<Response>();
  const previousAgent = Promise.withResolvers<Response>();
  const requests: string[] = [];
  let checks = 0;
  vi.stubGlobal("fetch", (input: string) => {
    requests.push(input);
    if (input === "/api/agents") return Promise.resolve(json([{ id: "status-order", name: "Agent" }, { id: "other", name: "Other" }]));
    if (input.endsWith("/extensions")) return Promise.resolve(json({ extensions: [{ id: "notes", displayName: "Notes", description: "Notes", enabled: false }] }));
    if (input === "/api/top-extensions") return Promise.resolve(json({ extensions: [], mcp: [], system: { extensions: [], mcp: [] } }));
    if (input === "/api/mcp/servers?agent=status-order&live=0") return Promise.resolve(json({ servers: [server("docs", { title: "Alpha" })] }));
    if (input === "/api/mcp/servers?agent=status-order&server=docs") return [older.promise, fresh.promise, previousAgent.promise][checks++];
    if (input === "/api/mcp/servers?agent=other&live=0") return Promise.resolve(json({ servers: [server("docs", { title: "Bravo" })] }));
    if (input === "/api/mcp/servers?agent=other&server=docs") return new Promise<Response>(() => {});
    throw new Error(`Unexpected request ${input}`);
  });
  dispose = render(() => <EditAgent />, document.body);
  await tick(); await tick();
  window.dispatchEvent(new Event("focus"));
  fresh.resolve(json({ servers: [server("docs", { title: "Omega", state: "connected", status: undefined })] }));
  await tick();
  older.resolve(json({ servers: [server("docs", { title: "Stale", state: "unreachable", status: undefined })] }));
  await tick();
  expect(getAllByRole(document.body, "listitem").map((card) => within(card).getAllByRole("link")[0]?.textContent)).toEqual(["Omegahttps://docs.test/mcp", "NotesNotes"]);
  expect(document.body.textContent).not.toContain("Unreachable");
  expect(requests.filter((request) => request.includes("&live=0"))).toHaveLength(1);

  window.dispatchEvent(new MessageEvent("message", { data: { type: "yoplai-oauth", extension: "mcp" } }));
  route[1]("agentId", "other");
  await tick(); await tick();
  previousAgent.resolve(json({ servers: [server("docs", { title: "Old agent", state: "connected", status: undefined })] }));
  await tick();
  expect(getAllByRole(document.body, "listitem").map((card) => within(card).getAllByRole("link")[0]?.textContent)).toEqual(["Bravohttps://docs.test/mcp", "NotesNotes"]);
  expect(document.body.textContent).toContain("Checking…");
  expect(queryByRole(document.body, "img", { name: "docs connected" })).toBeNull();
});
