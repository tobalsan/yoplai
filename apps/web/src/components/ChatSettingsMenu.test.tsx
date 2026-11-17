// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getByRole } from "@testing-library/dom";
import { Route, Router, useLocation } from "@solidjs/router";
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
  getByRole(container, "menuitem", { name: "Agent settings" }).click();
  await vi.waitFor(() => expect(getByRole(container, "link", { name: "Back" }).getAttribute("href")).toBe("/chat/assistant?session=saved-session"));
});
