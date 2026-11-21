// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { within } from "@testing-library/dom";
import { AgentAvatarFill } from "./AgentAvatarFill";
import { defaultAvatarUrl } from "../lib/default-avatar";

let dispose: () => void;
afterEach(() => { dispose?.(); document.body.replaceChildren(); });

/** The avatar image has an empty alt text, so it has the presentation role. */
const avatarImage = (root: HTMLElement) => within(root).queryByRole("presentation");

function mount(avatar: string | undefined, agentId: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  dispose = render(() => <AgentAvatarFill avatar={avatar} agentId={agentId} />, root);
  return root;
}

describe("AgentAvatarFill", () => {
  it("shows the default image of the agent when the avatar is empty", () => {
    expect(avatarImage(mount(undefined, "alpha"))?.getAttribute("src")).toBe(defaultAvatarUrl("alpha"));
  });

  it("uses the full remote ID for the default image", () => {
    expect(avatarImage(mount("", "scribe@east"))?.getAttribute("src")).toBe(defaultAvatarUrl("scribe@east"));
  });

  it("shows a set image", () => {
    expect(avatarImage(mount("/api/agents/alpha/avatar", "alpha"))?.getAttribute("src")).toBe("/api/agents/alpha/avatar");
  });

  it("shows an emoji as text with no image", () => {
    const root = mount("🦊", "alpha");
    expect(root.textContent).toBe("🦊");
    expect(avatarImage(root)).toBeNull();
  });
});
