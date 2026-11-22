// @vitest-environment jsdom
import { fireEvent, getByRole, queryByRole, waitFor } from "@testing-library/dom";
import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import { afterEach, expect, it, vi } from "vitest";
import { NewAgent } from "./NewAgent";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("protects the draft and creates with the selected gateway's model", async () => {
  history.replaceState(null, "", "/agents/new");
  vi.stubGlobal("scrollTo", vi.fn());
  const writes: Array<{ path: string; body: unknown }> = [];
  let reply!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { reply = resolve; });
  vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
    if (path === "/api/relay/gateways") return Response.json({ gateways: [{ name: "east" }, { name: "west" }] });
    if (path.endsWith("/permissions")) return Response.json({ canCreate: !path.includes("/west/") });
    if (path.endsWith("/models")) {
      const linked = path.includes("/east/");
      return Response.json({ models: [{ provider: linked ? "anthropic" : "openai", model: linked ? "reed" : "oak", name: linked ? "Reed" : "Oak", ready: true }] });
    }
    if (path.endsWith("/agents") && options.method === "POST") {
      writes.push({ path, body: JSON.parse(String(options.body)) });
      return pending;
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
  const name = byRole("textbox", "Name");
  fireEvent.input(name, { target: { value: "Garden Guide" } });
  expect(byRole("heading", "Garden Guide")).toBeTruthy();
  fireEvent.click(document.body);
  expect(queryByRole(document.body, "alertdialog")).toBeNull();
  fireEvent.keyDown(name, { key: "Escape" });
  expect(byRole("alertdialog", "Discard this new agent?")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(byRole("button", "Keep editing")));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(queryByRole(document.body, "alertdialog")).toBeNull();
  expect(writes).toHaveLength(0);

  const pickModel = async (provider: string) => {
    await waitFor(() => expect((byRole("button", /^Model:/) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(byRole("button", /^Model:/));
    const search = byRole("combobox", "Search models");
    fireEvent.input(search, { target: { value: provider } });
    fireEvent.keyDown(search, { key: "Enter" });
  };
  await pickModel("openai");
  expect(create.disabled).toBe(false);
  expect(queryByRole(document.body, "radio", { name: "west" })).toBeNull();
  fireEvent.click(byRole("radio", "east"));
  await waitFor(() => expect(create.disabled).toBe(true));
  await pickModel("anthropic");
  fireEvent.click(create);
  await waitFor(() => expect(writes).toHaveLength(1));
  fireEvent.keyDown(name, { key: "Escape" });
  fireEvent.click(byRole("link", "Agents"));
  expect(queryByRole(document.body, "alertdialog")).toBeNull();
  expect(location.pathname).toBe("/agents/new");
  reply(Response.json({ id: "garden-guide" }, { status: 201 }));
  await waitFor(() => expect(byRole("heading", "Chat opened")).toBeTruthy());
  expect(location.pathname).toBe("/chat/garden-guide%40east");
  expect(writes).toEqual([{ path: "/api/relay/gateways/east/api/agent-management/agents", body: expect.objectContaining({ name: "Garden Guide", model: { provider: "anthropic", model: "reed" } }) }]);
});
