// @vitest-environment jsdom
import { fireEvent, getByRole, queryByRole, waitFor } from "@testing-library/dom";
import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import { afterEach, expect, it, vi } from "vitest";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../../lib/capabilities";
import AdminLayout from "./AdminLayout";
import AgentManagement from "./AgentManagement";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  resetCapabilitiesForTests();
  vi.unstubAllGlobals();
});

it.each([
  [true, "superadmin", undefined, true],
  [true, "admin", undefined, false],
  [true, "user", undefined, false],
  [false, "superadmin", undefined, false],
  [true, "superadmin", "east", false],
] as const)("exposes the agent management tab only to a local multi-user superadmin", (multiUser, role, gateway, visible) => {
  setCapabilitiesForTests({ multiUser, user: { id: "mira", role, name: "Mira" } });
  dispose = render(() => <Router><Route path="*" component={() => <AdminLayout title="Extensions" description="Manage extensions." gateway={gateway} />} /></Router>, document.body);
  expect(!!queryByRole(document.body, "link", { name: "Agent management" })).toBe(visible);
});

it.each([false, true])("changes the radio setting only on Save when locked is %s", async (locked) => {
  setCapabilitiesForTests({ multiUser: true, user: { id: "mira", role: "superadmin", name: "Mira" } });
  history.replaceState(null, "", "/admin/agent-management");
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", async (_path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      return Response.json({ ...body, locked: false, source: "ui" });
    }
    return Response.json({ mode: "off", locked, source: locked ? "config" : "default" });
  });
  dispose = render(() => <Router><Route path="/admin/agent-management" component={AgentManagement} /></Router>, document.body);
  await waitFor(() => expect(getByRole(document.body, "group", { name: "Who can create and edit agents" })).toBeTruthy());
  const option = getByRole(document.body, "radio", { name: "Anyone (members edit their own agents)" }) as HTMLInputElement;
  const save = getByRole(document.body, "button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  if (locked) {
    expect(option.matches(":disabled")).toBe(true);
    expect(document.body.textContent).toContain("Set in yoplai.json.");
  } else {
    fireEvent.click(option);
    expect(save.disabled).toBe(false);
    expect(writes).toEqual([]);
    fireEvent.click(save);
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(writes).toEqual([{ mode: "anyone" }]);
  }
});
