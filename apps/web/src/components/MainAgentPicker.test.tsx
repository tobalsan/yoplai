// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { Agent } from "../api/types";

vi.mock("../api/chat", () => ({ fetchAgentSessions: vi.fn(async () => ({ items: [] })) }));
vi.mock("../api/main-agent", () => ({ saveMainAgentPreference: vi.fn() }));

import { MainAgentPicker } from "./MainAgentPicker";
import { defaultAvatarUrl } from "../lib/default-avatar";
import { defaultAvatarSources } from "../lib/default-avatar.fixture";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("MainAgentPicker", () => {
  it("shows the default avatar of an agent that has no avatar", () => {
    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(
      () => <MainAgentPicker agents={[{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta", avatar: "🦊" }] as Agent[]} onPick={() => {}} onClose={() => {}} />,
      root,
    );
    expect(defaultAvatarSources(document.body)).toEqual([defaultAvatarUrl("alpha")]);
  });
});
