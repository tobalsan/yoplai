// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@solidjs/router", () => ({
  useSearchParams: () => [{}, () => {}] as const,
  useNavigate: () => vi.fn(),
  A: (props: Record<string, unknown>) => props,
}));
vi.mock("./AgentSidebar", () => ({ AgentSidebar: () => null }));
vi.mock("./ContextPanel", () => ({ ContextPanel: () => null }));
vi.mock("./AgentChat", () => ({ AgentChat: () => null }));

import { parseRunAgent } from "./ProjectsBoard";

describe("parseRunAgent", () => {
  it("resolves the persisted native prefix", () => {
    expect(parseRunAgent("yoplai:agent-1")).toEqual({
      type: "native",
      id: "agent-1",
    });
  });

  it("resolves the legacy persisted prefix", () => {
    expect(parseRunAgent("aihub:agent-1")).toEqual({
      type: "native",
      id: "agent-1",
    });
  });

  it("resolves the cli prefix", () => {
    expect(parseRunAgent("cli:codex")).toEqual({
      type: "cli",
      id: "codex",
    });
  });

  it("returns null for an unrecognized or empty value", () => {
    // "native:" is the in-memory run-list key format, not a persisted
    // runAgent prefix, and must not be accepted here.
    expect(parseRunAgent("native:agent-1")).toBeNull();
    expect(parseRunAgent("bogus:agent-1")).toBeNull();
    expect(parseRunAgent("")).toBeNull();
    expect(parseRunAgent(undefined)).toBeNull();
  });
});
