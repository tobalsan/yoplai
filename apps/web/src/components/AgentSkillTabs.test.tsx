// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { SkillRow } from "../api/skills";

vi.mock("../api/agents", () => ({ fetchAgents: vi.fn(async () => [{ id: "alpha", name: "Alpha" }]) }));

import { AgentSkillTabs } from "./AgentSkillTabs";
import { defaultAvatarUrl } from "../lib/default-avatar";
import { defaultAvatarSources } from "../lib/default-avatar.fixture";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("AgentSkillTabs", () => {
  it("shows the default avatar on the tab of an agent that has no avatar", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const rows = [{ agentId: "alpha", agentName: "Alpha" }] as SkillRow[];
    dispose = render(
      () => <AgentSkillTabs rows={rows} selected="alpha" onSelect={() => {}} renderRow={() => <li>row</li>} />,
      root,
    );
    await vi.waitFor(() => expect(defaultAvatarSources(root)).toContain(defaultAvatarUrl("alpha")));
  });
});
