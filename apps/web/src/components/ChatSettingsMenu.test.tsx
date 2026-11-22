// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, getAllByRole, getByRole, queryByText } from "@testing-library/dom";
import { Route, Router, useLocation } from "@solidjs/router";
import { Suspense } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { ChatSettingsMenu } from "./ChatSettingsMenu";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";

let dispose: (() => void) | undefined;
beforeEach(() => {
  delegateEvents(["click", "keydown"]);
  history.replaceState({}, "", "/chat/assistant?session=saved-session");
  setCapabilitiesForTests({ multiUser: false });
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ mainAgentId: null, accessible: false }))));
});
afterEach(() => {
  dispose?.();
  document.body.innerHTML = "";
  resetCapabilitiesForTests();
  vi.unstubAllGlobals();
});

it.each([
  { multiUser: true, sessionId: "saved-session" },
  { multiUser: false, sessionId: "saved-session" },
  { multiUser: true, sessionId: undefined },
])("keeps the chat visible on every open while sharing is pending ($multiUser, $sessionId)", async ({ multiUser, sessionId }) => {
  setCapabilitiesForTests({ multiUser });
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/share")) return new Promise<Response>(() => {});
    return new Response(JSON.stringify({ mainAgentId: null, accessible: false }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  document.body.appendChild(container);
  dispose = render(() => <Router>
    <Route path="/chat/:agentId" component={() => <Suspense fallback={<p>App boot splash</p>}>
      <aside>Chat sidebar</aside>
      <main>Saved transcript</main>
      <textarea aria-label="Message" />
      <ChatSettingsMenu agentId="assistant" settingsAgentId="assistant" sessionId={sessionId} onPick={() => {}} />
    </Suspense>} />
  </Router>, container);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const sidebar = getByRole(container, "complementary");
  const transcript = getByRole(container, "main");
  const composer = getByRole(container, "textbox");
  const cog = getByRole(container, "button", { name: "Chat settings" });
  for (let opening = 0; opening < 2; opening++) {
    cog.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queryByText(container, "App boot splash")).toBeNull();
    expect(getByRole(container, "complementary")).toBe(sidebar);
    expect(getByRole(container, "main")).toBe(transcript);
    expect(getByRole(container, "textbox")).toBe(composer);
    expect(getByRole(container, "menu")).toBeTruthy();
    cog.click();
  }
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/share"))).toHaveLength(multiUser && sessionId ? 2 : 0);
});

it("keeps the originating chat in router state when opening agent settings", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  function SettingsDestination() {
    const location = useLocation<{ backTo?: string }>();
    return <a href={location.state?.backTo}>Back</a>;
  }
  dispose = render(() => <Router>
    <Route path="/chat/:agentId" component={() => <ChatSettingsMenu agentId="assistant" settingsAgentId="assistant" sessionId="saved-session" onPick={() => {}} />} />
    <Route path="/agents/:agentId/edit" component={SettingsDestination} />
  </Router>, container);
  getByRole(container, "button", { name: "Chat settings" }).click();
  getByRole(container, "menuitem", { name: "Extensions and schedules" }).click();
  await vi.waitFor(() => expect(getByRole(container, "link", { name: "Back" }).getAttribute("href")).toBe("/chat/assistant?session=saved-session"));
});

it("opens the menu without hiding the chat while its default preference is pending", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const container = document.createElement("div");
  document.body.appendChild(container);
  dispose = render(() => <Router>
    <Route path="/chat/:agentId" component={() => <Suspense fallback={<p>App boot splash</p>}>
      <main>Saved transcript</main>
      <ChatSettingsMenu agentId="assistant" settingsAgentId="assistant" onPick={() => {}} />
    </Suspense>} />
  </Router>, container);
  const transcript = getByRole(container, "main");
  getByRole(container, "button", { name: "Chat settings" }).click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(queryByText(container, "App boot splash")).toBeNull();
  expect(getByRole(container, "main")).toBe(transcript);
  expect(getByRole(container, "menuitem", { name: "Extensions and schedules" })).toBeTruthy();
});

it.each([
  { mainAgentId: "other", accessible: true, expected: ["Extensions and schedules", "Set as default agent", "Share link"] },
  { mainAgentId: "assistant", accessible: true, expected: ["Extensions and schedules", "Share link"] },
  { mainAgentId: "assistant", accessible: false, expected: ["Extensions and schedules", "Set as default agent", "Share link"] },
])("orders actions and hides only a known accessible default ($mainAgentId, $accessible)", async ({ mainAgentId, accessible, expected }) => {
  setCapabilitiesForTests({ multiUser: true });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(
    String(input).endsWith("/share") ? { shared: false } : { mainAgentId, accessible }
  ))));
  const container = document.createElement("div");
  document.body.appendChild(container);
  dispose = render(() => <Router>
    <Route path="/chat/:agentId" component={() => <ChatSettingsMenu agentId="assistant" settingsAgentId="assistant" sessionId="saved-session" onPick={() => {}} />} />
  </Router>, container);
  getByRole(container, "button", { name: "Chat settings" }).click();
  await vi.waitFor(() => expect((getByRole(container, "menuitem", { name: "Share link" }) as HTMLButtonElement).disabled).toBe(false));
  expect(getAllByRole(container, "menuitem").map((item) => item.textContent)).toEqual(expected);
});

it.each(["pending", "failed", "project"])("keeps the default action available unless in a project when preference is %s", async (state) => {
  const fetchMock = vi.fn(() => state === "pending" ? new Promise<Response>(() => {}) : Promise.reject(new Error("Offline")));
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  document.body.appendChild(container);
  dispose = render(() => <Router>
    <Route path="/chat/:agentId" component={() => <ChatSettingsMenu agentId="assistant" settingsAgentId="assistant" projectId={state === "project" ? "project-one" : undefined} onPick={() => {}} />} />
  </Router>, container);
  if (state !== "project") await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  getByRole(container, "button", { name: "Chat settings" }).click();
  expect(getAllByRole(container, "menuitem").map((item) => item.textContent)).toEqual(
    state === "project" ? ["Extensions and schedules"] : ["Extensions and schedules", "Set as default agent"]
  );
});

it("keeps Arrow, Home, End, Escape and Tab navigation working in the regrouped menu", async () => {
  setCapabilitiesForTests({ multiUser: true });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(
    String(input).endsWith("/share") ? { shared: false } : { mainAgentId: null, accessible: false }
  ))));
  const container = document.createElement("div");
  document.body.appendChild(container);
  dispose = render(() => <Router>
    <Route path="/chat/:agentId" component={() => <ChatSettingsMenu agentId="assistant" settingsAgentId="assistant" sessionId="saved-session" onPick={() => {}} />} />
  </Router>, container);
  const cog = getByRole(container, "button", { name: "Chat settings" });
  fireEvent.keyDown(cog, { key: "ArrowDown" });
  await vi.waitFor(() => expect((getByRole(container, "menuitem", { name: "Share link" }) as HTMLButtonElement).disabled).toBe(false));
  const settings = getByRole(container, "menuitem", { name: "Extensions and schedules" });
  const defaultAgent = getByRole(container, "menuitem", { name: "Set as default agent" });
  const share = getByRole(container, "menuitem", { name: "Share link" });
  expect(document.activeElement).toBe(settings);
  fireEvent.keyDown(settings, { key: "ArrowDown" });
  expect(document.activeElement).toBe(defaultAgent);
  fireEvent.keyDown(defaultAgent, { key: "End" });
  expect(document.activeElement).toBe(share);
  fireEvent.keyDown(share, { key: "Home" });
  expect(document.activeElement).toBe(settings);
  fireEvent.keyDown(settings, { key: "ArrowUp" });
  expect(document.activeElement).toBe(share);
  fireEvent.keyDown(share, { key: "Escape" });
  expect(cog.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(cog);
  fireEvent.keyDown(cog, { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(cog.getAttribute("aria-expanded")).toBe("false");
});
