// @vitest-environment jsdom
import { expect, it } from "vitest";
import { render } from "solid-js/web";
import { UserPicker } from "./UserPicker";

it("shows search result photos and falls back to each person's initials", () => {
  const root = document.createElement("div");
  document.body.append(root);
  const users = [
    { id: "ada", label: "Ada Lovelace (ada@example.test)", name: "Ada Lovelace", image: "https://lh3.googleusercontent.com/ada" },
    { id: "bob", label: "Bob Ross (bob@example.test)", name: "Bob Ross", image: null },
  ];
  const dispose = render(() => <UserPicker users={users} value="" onChange={() => {}} />, root);
  try {
    const input = root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    input.value = "example";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const options = root.querySelectorAll('[role="option"]');
    const photo = options[0]!.querySelector("img");
    expect(photo?.getAttribute("src")).toBe("https://lh3.googleusercontent.com/ada");
    expect(options[1]!.querySelector('[aria-hidden="true"]')?.textContent).toBe("BR");
    photo!.dispatchEvent(new Event("error"));
    expect(options[0]!.querySelector("img")).toBeNull();
    expect(options[0]!.querySelector('[aria-hidden="true"]')?.textContent).toBe("AL");
  } finally { dispose(); root.remove(); }
});
