// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import { Skills } from "./Skills";
import { ChatView } from "../components/ChatView";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
let mainAgentId: string | null;
let includeOpenClaw: boolean;
let onlyOpenClaw: boolean;
const frames: Array<Record<string, unknown>> = [];
const agent = { id: "sage", name: "Sage", model: { provider: "openai", model: "gpt-4o-mini" }, sdk: "pi" };

class Socket {
  static OPEN = 1; static CONNECTING = 0;
  readyState = 0;
  onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void;
  constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send(text: string) { frames.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
}
beforeEach(() => {
  mainAgentId = "sage"; includeOpenClaw = false; onlyOpenClaw = false; frames.length = 0;
  localStorage.clear(); setCapabilitiesForTests({ multiUser: false });
  history.replaceState({}, "", "/skills"); root = document.createElement("div"); document.body.appendChild(root);
  vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/skills") return Response.json({ mine: [], sharedWithMe: [], agent: [] });
    if (path === "/api/me/main-agent") return Response.json({ mainAgentId, accessible: !!mainAgentId, pickerDismissedAt: null });
    if (path === "/api/agents") return Response.json(includeOpenClaw ? [{ ...agent, id: "claw", name: "Claw", sdk: "openclaw" }, ...(onlyOpenClaw ? [] : [agent])] : [agent]);
    if (path === "/api/agents/sage") return Response.json(agent);
    if (path === "/api/agents/sage/suggestions") return Response.json([]);
    if (path === "/api/agents/sessions") return Response.json({ items: [] });
    if (path === "/api/agents/status") return Response.json({ statuses: { sage: "idle" } });
    if (path.includes("/history?")) return Response.json({ messages: [], isStreaming: false, activeTurn: null });
    return Response.json({});
  }));
});
afterEach(() => { dispose?.(); root.remove(); resetCapabilitiesForTests(); vi.unstubAllGlobals(); });
const PROMPT = "Help me create a skill. Let's start with you interviewing me to understand what the skill should do.";
const input = () => document.body.querySelector("textarea");
function click(label: string) {
  const button = Array.from(document.body.querySelectorAll("button")).find((element) => element.getAttribute("aria-label") === label || element.textContent?.trim() === label);
  expect(button, label).toBeDefined(); button!.click();
}
describe("Create skill", () => {
  it("opens a fresh chat with the main agent and fills in the prompt without sending it", async () => {
    dispose = render(() => <Router><Route path="/skills" component={Skills} /><Route path="/chat/:agentId" component={ChatView} /></Router>, root);
    await vi.waitFor(() => expect(root.textContent).toContain("No skills yet."));
    click("Add skill"); click("Create skill");
    await vi.waitFor(() => expect(input()?.value).toBe(PROMPT));
    expect(location.pathname).toBe("/chat/sage");
    expect(frames.filter((frame) => frame.type === "send")).toHaveLength(0);
  });
  it("asks for an agent when no main agent is set, then fills in the prompt", async () => {
    mainAgentId = null;
    dispose = render(() => <Router><Route path="/skills" component={Skills} /><Route path="/chat/:agentId" component={ChatView} /></Router>, root);
    await vi.waitFor(() => expect(root.textContent).toContain("No skills yet."));
    click("Add skill"); click("Create skill");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Create skill: choose an agent"));
    expect(frames.filter((frame) => frame.type === "send")).toHaveLength(0); click("Sage");
    await vi.waitFor(() => expect(input()?.value).toBe(PROMPT));
    expect(location.pathname).toBe("/chat/sage");
    expect(frames.filter((frame) => frame.type === "send")).toHaveLength(0);
  });
  it("offers skill-capable agents when the main agent is OpenClaw", async () => {
    mainAgentId = "claw"; includeOpenClaw = true;
    dispose = render(() => <Router><Route path="/skills" component={Skills} /><Route path="/chat/:agentId" component={ChatView} /></Router>, root);
    await vi.waitFor(() => expect(root.textContent).toContain("No skills yet.")); click("Add skill"); click("Create skill");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Create skill: choose an agent"));
    expect(Array.from(document.body.querySelectorAll("button")).some((button) => button.textContent === "Claw")).toBe(false);
    click("Sage"); await vi.waitFor(() => expect(input()?.value).toBe(PROMPT));
    expect(location.pathname).toBe("/chat/sage");
  });
  it("explains the alternatives when no agent supports skills", async () => {
    mainAgentId = "claw"; includeOpenClaw = true; onlyOpenClaw = true;
    dispose = render(() => <Router><Route path="/skills" component={Skills} /><Route path="/chat/:agentId" component={ChatView} /></Router>, root);
    await vi.waitFor(() => expect(root.textContent).toContain("No skills yet.")); click("Add skill"); click("Create skill");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Ask your operator for an agent that supports skills, or upload or import a skill instead."));
    expect(frames.filter((frame) => frame.type === "send")).toHaveLength(0);
  });
});
