// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { McpServerDetails } from "./McpServerDetails";

vi.mock("../auth/client", () => ({
  useSession: () => () => ({ isPending: false, data: { user: { id: "alice" } } }),
}));
vi.mock("@solidjs/router", () => ({
  A: (props: { href: string; children: unknown }) => <a href={props.href}>{String(props.children)}</a>,
  useParams: () => ({ agentId: "oauth-return", serverName: "webflow" }),
  useNavigate: () => vi.fn(),
}));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("MCP OAuth return", () => {
  it("shows Connected on Whole team before cold-load server data arrives and consumes the result URL", () => {
    window.history.replaceState(null, "", "/agents/oauth-return/mcp-servers/webflow?keep=yes&oauth=connected&oauth_scope=team#settings");
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    dispose = render(() => <McpServerDetails />, document.body);

    expect(document.querySelector('[role="status"]')?.textContent).toBe("Connected");
    const selected = document.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toContain("Whole team");
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/agents/oauth-return/mcp-servers/webflow?keep=yes#settings");
  });

  it("shows a denied sign-in immediately and keeps it visible when status loading fails", async () => {
    window.history.replaceState(null, "", "/agents/oauth-return/mcp-servers/webflow?oauth=error&oauth_scope=personal&oauth_error=Access+denied");
    const response = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", vi.fn(() => response.promise));
    dispose = render(() => <McpServerDetails />, document.body);

    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Access denied");
    expect(window.location.search).toBe("");
    response.resolve(new Response("Unavailable", { status: 503 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Access denied");
    expect(document.body.textContent).toContain("Failed to load MCP server.");
  });
});
