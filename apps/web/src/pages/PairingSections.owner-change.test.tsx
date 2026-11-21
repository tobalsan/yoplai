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

it.each(sections)("$name: republishing the same owner preserves a pending unlink", async (section) => {
  let release = () => {};
  let listed = [section.row("alice")];
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      await new Promise<void>((resolve) => { release = resolve; });
      listed = [];
      return Response.json({ ok: true });
    }
    return Response.json({ [section.key]: listed });
  }));
  const [session, setSession] = createSignal({ ownerId: "alice" });
  dispose = render(() => section.mount(() => session().ownerId), root);
  await tick();
  const screen = within(root);
  const control = () => screen.getByRole("button", { name: /Unpair|Unlink|Removing/ }) as HTMLButtonElement;
  fireEvent.click(control());
  await tick();
  expect(control().disabled).toBe(true);
  setSession({ ownerId: "alice" });
  await tick();
  const stayedLocked = control().disabled;
  release();
  await tick();

  expect(screen.queryByText(section.label("alice"))).toBeNull();
  expect(stayedLocked).toBe(true);
});

it.each(sections)("$name: an old visit of the same owner changes nothing after A, B, A", async (section) => {
  let releaseOld = () => {};
  let held = true;
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      if (held) { held = false; await new Promise<void>((resolve) => { releaseOld = resolve; }); return Response.json({ error: "gateway_offline" }, { status: 502 }); }
      return Response.json({ ok: true });
    }
    return Response.json({ [section.key]: [section.row("alice")] });
  }));
  const [owner, setOwner] = createSignal<string | undefined>("alice");
  dispose = render(() => section.mount(owner), root);
  await tick();
  fireEvent.click(within(root).getByRole("button", { name: section.button }));
  await tick();
  setOwner("bob");
  await tick();
  setOwner("alice");
  await tick();
  expect((within(root).getByRole("button", { name: section.button }) as HTMLButtonElement).disabled).toBe(false);
  releaseOld();
  await tick();
  expect(within(root).queryByRole("alert")).toBeNull();
  expect((within(root).getByRole("button", { name: section.button }) as HTMLButtonElement).disabled).toBe(false);
});
