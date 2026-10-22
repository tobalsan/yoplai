// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const { saveMock, recipientsMock } = vi.hoisted(() => ({ saveMock: vi.fn(), recipientsMock: vi.fn() }));
vi.mock("../api/dashboards", () => ({ saveDashboardShares: saveMock, fetchDashboardRecipients: recipientsMock }));
vi.mock("../auth/client", () => ({ useSession: () => () => ({ data: { user: { name: "Owner Person", image: "https://lh3.googleusercontent.com/owner" } } }) }));

import { DashboardAccessDialog } from "./DashboardAccessDialog";

let root: HTMLDivElement;
let dispose: () => void;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const select = (label: string) => document.body.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const choose = (element: HTMLSelectElement, value: string) => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); };
const search = async (text: string) => {
  const input = document.body.querySelector<HTMLInputElement>('[role="combobox"][aria-label="Select a user"]')!;
  input.focus();
  input.value = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await tick();
  return input;
};
const options = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));
const button = (text: string) => Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === text)!;

beforeEach(() => {
  saveMock.mockReset().mockResolvedValue({});
  recipientsMock.mockReset().mockResolvedValue({ users: [{ id: "u1", name: "Ada Lovelace", email: "ada@example.com" }] });
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => { dispose?.(); root.remove(); });

const open = async (shares: object[] = []) => {
  dispose = render(() => <DashboardAccessDialog dashboard={{ id: "d1", title: "Revenue", shares: shares as never }} onClose={() => {}} onSaved={() => {}} />, root);
  await tick();
};

describe("DashboardAccessDialog", () => {
  it("shows owner and recipient photos, with initials for missing and failed photos", async () => {
    recipientsMock.mockResolvedValue({ users: [
      { id: "u1", name: "Ada Lovelace", email: "ada@example.com", image: "https://lh3.googleusercontent.com/ada" },
      { id: "u2", name: "Bob Ross", email: "bob@example.com", image: null },
    ] });
    await open([{ kind: "user", id: "u1", mode: "read" }, { kind: "user", id: "u2", mode: "read" }]);
    const rows = document.body.querySelectorAll(".share-person");
    expect(rows[0]!.querySelector("img")?.getAttribute("src")).toBe("https://lh3.googleusercontent.com/owner");
    const photo = rows[1]!.querySelector("img");
    expect(photo?.getAttribute("src")).toBe("https://lh3.googleusercontent.com/ada");
    expect(rows[2]!.querySelector(".share-avatar")?.textContent).toBe("BR");
    photo!.dispatchEvent(new Event("error"));
    expect(rows[1]!.querySelector("img")).toBeNull();
    expect(rows[1]!.querySelector(".share-avatar")?.textContent).toBe("AL");
  });

  it("titles the dialog with the dashboard and disables Save until changed", async () => {
    await open();
    expect(document.body.textContent).toContain('Share "Revenue"');
    expect(button("Save").disabled).toBe(true);
  });

  it("saves Everyone on the platform with Can edit as a single all share", async () => {
    await open();
    choose(select("General access"), "all");
    await tick();
    choose(select("Everyone permission"), "write");
    await tick();
    expect(button("Save").disabled).toBe(false);
    button("Save").click();
    await tick();
    expect(saveMock).toHaveBeenCalledWith("d1", [{ kind: "all", mode: "write" }]);
  });

  it("keeps Save disabled after removing and adding back the same person", async () => {
    recipientsMock.mockResolvedValue({ users: [{ id: "u1", name: "Ada Lovelace", email: "ada@example.com" }, { id: "u2", name: "Bob Ross", email: "bob@example.com" }] });
    await open([{ kind: "user", id: "u1", mode: "read" }, { kind: "user", id: "u2", mode: "read" }]);
    const remove = document.body.querySelector<HTMLButtonElement>('button[aria-label="Remove Ada Lovelace"]')!;
    remove.click();
    await tick();
    expect(button("Save").disabled).toBe(false);
    await search("ada");
    options().find((option) => option.textContent?.includes("Ada Lovelace"))!.click();
    await tick();
    button("Add").click();
    await tick();
    expect(button("Save").disabled).toBe(true);
  });

  it("filters users by name or email and adds the one picked with the keyboard", async () => {
    recipientsMock.mockResolvedValue({ users: [{ id: "u1", name: "Ada Lovelace", email: "ada@example.com" }, { id: "u2", name: "Bob Ross", email: "bob@paint.org" }] });
    await open();
    await search("");
    expect(options()).toHaveLength(0);
    const input = await search("paint");
    expect(options().map((option) => option.textContent)).toEqual(["BRBob Ross (bob@paint.org)"]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    expect(document.body.querySelector('button[aria-label="Remove Bob Ross"]')).not.toBeNull();
    expect(input.value).toBe("");
    await search("zzz");
    expect(document.body.textContent).toContain("No matching users");
  });

  it("lists existing people and removes them", async () => {
    await open([{ kind: "user", id: "u1", mode: "read" }]);
    expect(document.body.textContent).toContain("Ada Lovelace");
    expect(document.body.textContent).toContain("ada@example.com");
    document.body.querySelector<HTMLButtonElement>('button[aria-label="Remove Ada Lovelace"]')!.click();
    await tick();
    button("Save").click();
    await tick();
    expect(saveMock).toHaveBeenCalledWith("d1", []);
  });
});
