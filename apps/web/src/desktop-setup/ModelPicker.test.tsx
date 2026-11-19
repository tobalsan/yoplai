// @vitest-environment jsdom
import { fireEvent, getByRole, within } from "@testing-library/dom";
import { render } from "solid-js/web";
import { expect, it } from "vitest";
import { ModelPicker } from "./ModelPicker";
import type { Model } from "./api";

it("marks only the suggested row as selected when its provider family expands", () => {
  const model: Model = {
    provider: "anthropic", model: "claude-haiku", name: "Claude Haiku",
    source: "owned", default: true, ready: true, free: false,
  };
  const root = document.body.appendChild(document.createElement("div"));
  const dispose = render(() => <ModelPicker models={[model]} selected={model} suggested={model}
    disabled={false} onSelect={() => undefined} />, root);
  try {
    fireEvent.click(getByRole(root, "button", { name: /Model: Claude Haiku/ }));
    const list = within(getByRole(root, "listbox", { name: "Model" }));
    fireEvent.click(list.getByRole("option", { name: /Anthropic.*Expand/ }));
    expect(list.getAllByRole("option", { name: /Claude Haiku/ })).toHaveLength(2);
    expect(list.getAllByRole("option", { selected: true })).toHaveLength(1);
    const suggested = within(list.getByRole("group", { name: "Suggested" }));
    expect(suggested.getByRole("option", { name: /Claude Haiku/, selected: true })).toBeTruthy();
    fireEvent.input(getByRole(root, "combobox", { name: "Search models" }), { target: { value: "haiku" } });
    expect(list.getAllByRole("option", { name: /Claude Haiku/, selected: true })).toHaveLength(1);
  } finally {
    dispose();
    root.remove();
  }
});
