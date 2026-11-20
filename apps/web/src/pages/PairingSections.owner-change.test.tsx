// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { fireEvent, within } from "@testing-library/dom";
import { SlackPairingsSection } from "./SlackPairingsSection";
import { SurfaceLinksSection } from "./SurfaceLinksSection";

type Row = Record<string, unknown>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const slack = (user: string): Row => ({ workspaceId: "T1", slackUserId: user, pairedAt: 1704067200000 });
const surface = (user: string): Row => ({ id: `link-${user}`, surface: "threadit", scope: "https://board.example.test", externalId: user, username: user, linkedAt: 1704067200000 });

const sections = [
  {
    name: "Slack", button: "Unpair", listPath: "/slack/pairings", deletePath: "/slack/pairings/T1/", key: "pairings", row: slack, label: (user: string) => `Slack user ${user}`,
    mount: (owner: () => string | undefined) => <SlackPairingsSection gateway="ams" ownerId={owner} onAvailable={() => undefined} />,
  },
  {
    name: "Threadit and Mattermost", button: "Unlink", listPath: "/surface-links", deletePath: "/surface-links/link-", key: "links", row: surface, label: (user: string) => `Threadit @${user}`,
    mount: (owner: () => string | undefined) => <SurfaceLinksSection gateway="ams" ownerId={owner} onAvailable={() => undefined} />,
  },
];

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
beforeEach(() => { root = document.body.appendChild(document.createElement("div")); });
afterEach(() => { dispose?.(); dispose = undefined; root.remove(); vi.unstubAllGlobals(); });

it.each(sections)("$name: the new owner can act while the answer of the previous owner is held", async (section) => {
  let listed = "alice";
  let releaseAlice = () => {};
  const deletes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      deletes.push(url);
      if (url.endsWith("alice")) await new Promise<void>((resolve) => { releaseAlice = resolve; });
      return Response.json({ ok: true });
    }
    expect(url).toContain(section.listPath);
    return Response.json({ [section.key]: [section.row(listed)] });
  }));
  const [owner, setOwner] = createSignal<string | undefined>("alice");
  dispose = render(() => section.mount(owner), root);
  await tick();
  fireEvent.click(within(root).getByRole("button", { name: section.button }));
  await tick();
  expect(deletes).toHaveLength(1);

  listed = "bob";
  setOwner("bob");
  await tick();
  expect(within(root).getByText(section.label("bob"))).toBeTruthy();
  const control = within(root).getByRole("button", { name: section.button }) as HTMLButtonElement;
  expect(control.disabled).toBe(false);
  fireEvent.click(control);
  await tick();
  expect(deletes).toHaveLength(2);

  releaseAlice();
  await tick();
  expect(within(root).queryByText(section.label("alice"))).toBeNull();
  expect(deletes).toHaveLength(2);
});
