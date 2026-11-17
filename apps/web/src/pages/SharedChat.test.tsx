// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryByRole, queryByText } from "@testing-library/dom";
import { delegateEvents, render } from "solid-js/web";
import { SharedChat } from "./SharedChat";
import type { FullHistoryMessage } from "../api/types";
vi.mock("@solidjs/router", () => ({ useParams: () => ({ token: "colleague-token" }) }));
const messages: FullHistoryMessage[] = [
  { role: "user", timestamp: 1, content: [
    { type: "text", text: "What happened?" },
    { type: "file", fileId: "input-file", filename: "notes.pdf", mimeType: "application/pdf", size: 12, direction: "inbound" },
  ] },
  { role: "assistant", timestamp: 2, content: [
    { type: "text", text: "The deployment succeeded." },
    { type: "file", fileId: "output-file", filename: "report.png", mimeType: "image/png", size: 12, direction: "outbound" },
    { type: "toolCall", id: "app-call", name: "fixture_draw", arguments: { title: "Diagram" } },
  ] },
  { role: "toolResult", timestamp: 3, toolCallId: "app-call", toolName: "fixture_draw", content: [{ type: "text", text: "Diagram output text" }], isError: false, view: { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html", recordId: "diagram-record" } },
];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let dispose: (() => void) | undefined;
function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  dispose = render(() => <SharedChat />, container);
  return container;
}

beforeEach(() => {
  delegateEvents(["click"]);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ agentId: "agent-1", agentName: "Assistant", title: "Deployment handoff", messages }))));
});
afterEach(() => {
  dispose?.();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("SharedChat", () => {
  it("renders the shared transcript with name-only files and an inert app placeholder", async () => {
    const container = mount();
    await tick();
    await tick();
    expect(queryByText(container, "Shared, read-only")).not.toBeNull();
    expect(queryByText(container, "Deployment handoff")).not.toBeNull();
    expect(queryByText(container, "Assistant")).not.toBeNull();
    expect(queryByText(container, "What happened?")).not.toBeNull();
    expect(queryByText(container, "The deployment succeeded.")).not.toBeNull();
    expect(queryByText(container, "notes.pdf")).not.toBeNull();
    expect(queryByText(container, "report.png")).not.toBeNull();
    expect(queryByText(container, "Interactive view not available in a shared chat")).not.toBeNull();
    expect(queryByText(container, "Diagram output text")).not.toBeNull();
    expect(container.querySelector("a[href], img, iframe, textarea, input, form")).toBeNull();
    expect(queryByRole(container, "button", { name: /Send|Stop|Compact|Archive|New chat|Copy reply|Download|Open report/ })).toBeNull();
  });

  it("lets a colleague read persisted command output", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ agentId: "agent-1", agentName: "Assistant", title: "Command output", messages: [
      { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "shell", name: "bash", arguments: { command: "printf status" } }] },
      { role: "toolResult", timestamp: 2, toolCallId: "shell", toolName: "bash", content: [{ type: "text", text: "All services healthy" }], isError: false },
    ] }))));
    const container = mount();
    await tick();
    await tick();
    queryByRole(container, "button", { name: /Worked.*1 tool call/ })!.click();
    queryByRole(container, "button", { name: "Ran commands" })!.click();
    const tool = queryByRole(container, "button", { name: /printf status/ });
    expect(tool).not.toBeNull();
    tool!.click();
    expect(container.textContent).toContain("All services healthy");
  });

  it("shows the unavailable-link message for a revoked or unknown link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const container = mount();
    await tick();
    await tick();
    expect(queryByText(container, "This link is not available.")).not.toBeNull();
    expect(container.querySelector("textarea, input, form, iframe")).toBeNull();
  });

  it("renders markdown file references by name without image or download access", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ agentId: "agent-1", agentName: "Assistant", title: "Inline files", messages: [
      { role: "assistant", timestamp: 1, content: [{ type: "text", text: "![handoff.png](/api/media/download/8b81a31b-029f-4b74-8b29-e34880353e19)\n[handoff.pdf](/api/media/download/97bcb80a-8d99-441b-8895-5d4d0773c8b4)\n![remote.png](https://files.example.test/remote.png)" }] },
    ] }))));
    const container = mount();
    await tick();
    await tick();
    expect(container.textContent).toContain("handoff.png");
    expect(container.textContent).toContain("handoff.pdf");
    expect(container.textContent).toContain("remote.png");
    expect(container.querySelector("img, a[href*='/api/media/download/']")).toBeNull();
  });

});
