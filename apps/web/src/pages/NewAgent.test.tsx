// @vitest-environment jsdom
import { findByRole, fireEvent, getByRole, queryByRole, waitFor, within } from "@testing-library/dom";
import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import { afterEach, expect, it, vi } from "vitest";
import { NewAgent } from "./NewAgent";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-yoplai-desktop");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ALG-815 Testing Decisions, approved in Thinh's Groom GO, cover the form and its create request.
it("protects the draft and creates with the selected gateway's model and optional folder", async () => {
  history.replaceState(null, "", "/agents/new");
  document.documentElement.setAttribute("data-yoplai-desktop", "");
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const writes: Array<{ path: string; body: unknown }> = [];
  let reply!: (response: Response) => void;
  vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
    if (path === "/api/relay/gateways") return Response.json({ gateways: [{ name: "east" }, { name: "west" }] });
    if (path.endsWith("/permissions")) return Response.json({ canCreate: !path.includes("/west/") });
    if (path === "/api/model-access") return Response.json({ external: [], owned: [{ providerId: "openai", type: "api_key" }] });
    if (path.endsWith("/models")) {
      const linked = path.includes("/east/");
      return Response.json({ models: [{ provider: linked ? "anthropic" : "openai", model: linked ? "reed" : "oak", name: linked ? "Reed" : "Oak", source: "owned", credentialType: "api_key", ready: true }] });
    }
    if (path.endsWith("/agents") && options.method === "POST") {
      writes.push({ path, body: JSON.parse(String(options.body)) });
      return new Promise<Response>((resolve) => { reply = resolve; });
    }
    return Response.json({}, { status: 404 });
  });
  dispose = render(() => <Router>
    <Route path="/agents/new" component={NewAgent} />
    <Route path="/agents" component={() => <h1>Agents</h1>} />
    <Route path="/chat/:agentId" component={() => <h1>Chat opened</h1>} />
  </Router>, document.body);

  const byRole = (role: string, name: string | RegExp) => getByRole(document.body, role, { name });
  const create = byRole("button", "Create agent") as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  const role = byRole("textbox", "Role");
  fireEvent.input(role, { target: { value: "Garden planner" } });
  const name = byRole("textbox", "Name");
  fireEvent.click(document.body);
  expect(queryByRole(document.body, "alertdialog")).toBeNull();
  fireEvent.keyDown(role, { key: "Escape" });
  expect(byRole("alertdialog", "Discard this new agent?")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(byRole("button", "Keep editing")));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(queryByRole(document.body, "alertdialog")).toBeNull();
  expect(writes).toHaveLength(0);
  fireEvent.input(name, { target: { value: "Garden Guide" } });
  expect(byRole("heading", "Garden Guide")).toBeTruthy();

  const pickModel = async (provider: string, local: boolean) => {
    await waitFor(() => expect((byRole("button", /^Model:/) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(byRole("button", /^Model:/));
    await waitFor(() => expect(Boolean(queryByRole(document.body, "button", { name: "Add model access" }))).toBe(local));
    const search = byRole("combobox", "Search models");
    fireEvent.input(search, { target: { value: provider } });
    fireEvent.keyDown(search, { key: "Enter" });
  };
  await pickModel("openai", true);
  expect(create.disabled).toBe(false);
  expect(queryByRole(document.body, "checkbox", { name: "Choose folder" })).toBeNull();
  expect(queryByRole(document.body, "radio", { name: "west" })).toBeNull();
  fireEvent.click(byRole("radio", "east"));
  await waitFor(() => expect(create.disabled).toBe(true));
  fireEvent.click(byRole("checkbox", "Choose folder"));
  fireEvent.input(byRole("textbox", "Agent folder"), { target: { value: "~/discarded" } });
  fireEvent.click(byRole("radio", "This computer"));
  expect(queryByRole(document.body, "checkbox", { name: "Choose folder" })).toBeNull();
  fireEvent.click(byRole("radio", "east"));
  expect((byRole("checkbox", "Choose folder") as HTMLInputElement).checked).toBe(false);
  await pickModel("anthropic", false);
  fireEvent.click(create);
  await waitFor(() => expect(writes).toHaveLength(1));
  fireEvent.keyDown(name, { key: "Escape" });
  fireEvent.click(byRole("link", "Agents"));
  expect(queryByRole(document.body, "alertdialog")).toBeNull();
  expect(location.pathname).toBe("/agents/new");
  const screen = byRole("dialog", "Agent creation");
  expect(within(screen).getByRole("status").textContent).toContain("Crafting Garden Guide");
  reply(Response.json({ message: "The discovery rules do not allow this agent." }, { status: 409 }));
  expect((await findByRole(document.body, "alert")).textContent).toBe("The discovery rules do not allow this agent.");
  expect(queryByRole(document.body, "dialog", { name: "Agent creation" })).toBeNull();
  expect(writes[0].body).not.toHaveProperty("folder");
  fireEvent.click(byRole("checkbox", "Choose folder"));
  const folder = byRole("textbox", "Agent folder");
  expect((folder as HTMLInputElement).value).toBe("");
  expect(create.disabled).toBe(true);
  fireEvent.input(folder, { target: { value: "garden-guide" } });
  fireEvent.click(create);
  expect(writes).toHaveLength(1);
  expect(byRole("alert", "").textContent).toContain("absolute folder path");
  fireEvent.input(folder, { target: { value: "  ~/garden-guide  " } });
  fireEvent.click(create);
  await waitFor(() => expect(writes).toHaveLength(2));
  reply(Response.json({ message: "The parent folder must already exist on the gateway." }, { status: 400 }));
  expect((await findByRole(document.body, "alert")).textContent).toBe("The parent folder must already exist on the gateway.");
  fireEvent.click(create);
  await waitFor(() => expect(writes).toHaveLength(3));
  reply(Response.json({ id: "garden-guide" }, { status: 201 }));
  const finish = await findByRole(document.body, "heading", { name: "Garden Guide is ready." });
  expect(finish).toBeTruthy();
  expect(location.pathname).toBe("/agents/new");
  await waitFor(() => expect(byRole("heading", "Chat opened")).toBeTruthy(), { timeout: 1800 });
  expect(location.pathname).toBe("/chat/garden-guide%40east");
  expect(writes[0]).toEqual({ path: "/api/relay/gateways/east/api/agent-management/agents", body: expect.objectContaining({ name: "Garden Guide", role: "Garden planner", model: { provider: "anthropic", model: "reed", source: "owned" } }) });
  expect(writes[1]).toEqual({ path: writes[0].path, body: { ...(writes[0].body as object), folder: "~/garden-guide" } });
  expect(writes[2]).toEqual(writes[1]);
});

it("submits and retries with the same UUID on plain HTTP", async () => {
  history.replaceState(null, "", "/agents/new");
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const requestIds: string[] = [];
  vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
    if (path === "/api/relay/gateways") return Response.json({ gateways: [] });
    if (path === "/api/agent-management/permissions") return Response.json({ canCreate: true });
    if (path === "/api/agent-management/models") {
      return Response.json({ models: [{ provider: "openai", model: "oak", name: "Oak", source: "owned", credentialType: "api_key", ready: true }] });
    }
    if (path === "/api/agent-management/agents" && options.method === "POST") {
      requestIds.push(JSON.parse(String(options.body)).requestId);
      if (requestIds.length === 1) throw new TypeError("Connection lost");
      return Response.json({ id: "orchard-guide" }, { status: 200 });
    }
    return Response.json({}, { status: 404 });
  });
  dispose = render(() => <Router>
    <Route path="/agents/new" component={NewAgent} />
    <Route path="/chat/:agentId" component={() => <h1>Chat opened</h1>} />
  </Router>, document.body);

  const byRole = (role: string, name: string | RegExp) => getByRole(document.body, role, { name });
  fireEvent.input(byRole("textbox", "Name"), { target: { value: "Orchard Guide" } });
  const model = byRole("button", /^Model:/) as HTMLButtonElement;
  await waitFor(() => expect(model.disabled).toBe(false));
  fireEvent.click(model);
  fireEvent.keyDown(byRole("combobox", "Search models"), { key: "Enter" });
  const create = byRole("button", "Create agent");
  fireEvent.click(create);

  await waitFor(() => expect(getByRole(document.body, "alert").textContent).toBe("Could not reach the gateway. Try again."));
  expect(requestIds).toEqual([expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)]);
  fireEvent.click(create);

  await waitFor(() => expect(byRole("heading", "Chat opened")).toBeTruthy());
  expect(location.pathname).toBe("/chat/orchard-guide");
  expect(requestIds).toEqual([requestIds[0], requestIds[0]]);
});
