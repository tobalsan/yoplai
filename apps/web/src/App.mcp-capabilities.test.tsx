// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findByRole, fireEvent, getByRole, queryByRole } from "@testing-library/dom";
import { render } from "solid-js/web";
import App from "./App";
import { resetCapabilitiesForTests } from "./lib/capabilities";

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
let installed: boolean;
let capabilitiesFail: boolean;
let capabilitiesGate: Promise<void> | undefined;
let capabilitiesReads: number;
const response = (body: unknown, status = 200) => Response.json(body, { status });
const row = () => ({ id: "mcp", name: "MCP", category: "tools", usedByAgents: 0, state: installed ? "installed" : "available", version: "1.0.0", installedVersion: installed ? "1.0.0" : undefined });

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  installed = false;
  capabilitiesFail = false;
  capabilitiesGate = undefined;
  capabilitiesReads = 0;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), location.origin).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/capabilities") {
      capabilitiesReads++;
      const snapshot = installed;
      await capabilitiesGate;
      return capabilitiesFail ? response({}, 500) : response({ version: 2, multiUser: false, extensions: { mcp: snapshot }, agents: [] });
    }
    if (path === "/api/admin/extension-catalog") return response({ source: "fixture", fetchedAt: null, stale: false, entries: [row()] });
    if (path === "/api/admin/extension-catalog/mcp/install" && method === "POST") { installed = true; return response(row()); }
    if (path === "/api/admin/extension-catalog/mcp" && method === "DELETE") { installed = false; return new Response(null, { status: 204 }); }
    if (path === "/api/mcp/catalog") return response({ servers: [] });
    if (path === "/api/agents") return response([]);
    return response({}, 404);
  }));
  root = document.body.appendChild(document.createElement("div"));
});
afterEach(() => { dispose?.(); dispose = undefined; root.remove(); resetCapabilitiesForTests(); vi.unstubAllGlobals(); });

function go(path: string) { history.pushState({}, "", path); window.dispatchEvent(new PopStateEvent("popstate")); }

it("shows the MCP controls after an install and hides them after a removal, in one app mount", async () => {
  history.replaceState({}, "", "/admin/extensions");
  dispose = render(() => <App />, root);
  const card = await findByRole(root, "article", { name: "MCP" });
  fireEvent.click(getByRole(card, "button", { name: "Install" }));
  await vi.waitFor(() => expect(getByRole(root, "article", { name: "MCP" }).textContent).toContain("Installed"));
  go("/admin/mcp-servers");
  await vi.waitFor(() => expect(root.querySelector('[aria-label="Server URL"]')).not.toBeNull());

  go("/admin/extensions");
  await findByRole(root, "article", { name: "MCP" });
  await vi.waitFor(() => expect(queryByRole(root, "button", { name: "Remove" })).not.toBeNull());
  fireEvent.click(getByRole(root, "button", { name: "Remove" }));
  fireEvent.click(await findByRole(root, "button", { name: "Confirm removal" }));
  await vi.waitFor(() => expect(getByRole(root, "article", { name: "MCP" }).textContent).not.toContain("Installed"));
  go("/admin/mcp-servers");
  await vi.waitFor(() => expect(queryByRole(root, "status")?.textContent).toContain("not installed"));
  expect(root.querySelector('[aria-label="Server URL"]')).toBeNull();
});

it("keeps a failed local capability read a failure with Retry, not 'not installed'", async () => {
  installed = true;
  capabilitiesFail = true;
  history.replaceState({}, "", "/admin/mcp-servers");
  dispose = render(() => <App />, root);
  await findByRole(root, "button", { name: "Retry" });
  expect(queryByRole(root, "status")?.textContent ?? "").not.toContain("not installed");
  expect(root.querySelector('[aria-label="Server URL"]')).toBeNull();
  capabilitiesFail = false;
  fireEvent.click(getByRole(root, "button", { name: "Retry" }));
  await vi.waitFor(() => expect(root.querySelector('[aria-label="Server URL"]')).not.toBeNull());
  expect(queryByRole(root, "button", { name: "Retry" })).toBeNull();
});

it("reads again after a removal that finishes while the install refresh is held", async () => {
  history.replaceState({}, "", "/admin/extensions");
  dispose = render(() => <App />, root);
  const card = await findByRole(root, "article", { name: "MCP" });
  let release!: () => void;
  capabilitiesGate = new Promise<void>((resolve) => { release = resolve; });
  fireEvent.click(getByRole(card, "button", { name: "Install" }));
  await vi.waitFor(() => expect(getByRole(root, "article", { name: "MCP" }).textContent).toContain("Installed"));
  await vi.waitFor(() => expect(queryByRole(root, "button", { name: "Remove" })).not.toBeNull());
  fireEvent.click(getByRole(root, "button", { name: "Remove" }));
  fireEvent.click(await findByRole(root, "button", { name: "Confirm removal" }));
  await vi.waitFor(() => expect(getByRole(root, "article", { name: "MCP" }).textContent).not.toContain("Installed"));
  expect(capabilitiesReads).toBe(2);
  capabilitiesGate = undefined;
  release();
  await vi.waitFor(() => expect(capabilitiesReads).toBe(3));
  go("/admin/mcp-servers");
  await vi.waitFor(() => expect(queryByRole(root, "status")?.textContent).toContain("not installed"));
  expect(root.querySelector('[aria-label="Server URL"]')).toBeNull();
});
