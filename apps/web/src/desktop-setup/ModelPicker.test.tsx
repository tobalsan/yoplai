// @vitest-environment jsdom
import { fireEvent, getByRole, queryByRole, within } from "@testing-library/dom";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { expect, it } from "vitest";
import { ModelPicker } from "./ModelPicker";
import { modelKey, type Model } from "./api";

it("chooses the same GPT model from the ChatGPT and Pi CLI tabs", () => {
  const chatgpt: Model = {
    provider: "openai-codex", model: "gpt-6-astra", name: "GPT-6 Astra",
    source: "owned", credentialType: "oauth", default: true, ready: false, free: false,
  };
  const pi: Model = { ...chatgpt, source: "pi" };
  const root = document.body.appendChild(document.createElement("div"));
  const dispose = render(() => {
    const [selected, setSelected] = createSignal(chatgpt);
    return <ModelPicker models={[chatgpt, pi]} selected={selected()} disabled={false}
      onSelect={(key) => setSelected(key === modelKey(pi) ? pi : chatgpt)} />;
  }, root);
  try {
    fireEvent.click(getByRole(root, "button", { name: /Model: GPT-6 Astra.*ChatGPT · Subscription/ }));
    const tabs = within(getByRole(root, "tablist", { name: "Model sources" }));
    expect(tabs.getByRole("tab", { name: "ChatGPT", selected: true })).toBeTruthy();
    expect(tabs.queryByRole("tab", { name: "Codex CLI" })).toBeNull();
    expect(queryByRole(root, "button", { name: "Sign out" })).toBeNull();
    fireEvent.click(tabs.getByRole("tab", { name: "Pi CLI" }));
    fireEvent.input(getByRole(root, "combobox", { name: "Search models" }), { target: { value: "haiku" } });
    expect(queryByRole(root, "option", { name: "GPT-6 Astra" })).toBeNull();
    fireEvent.input(getByRole(root, "combobox", { name: "Search models" }), { target: { value: "astra" } });
    fireEvent.click(getByRole(root, "option", { name: "GPT-6 Astra" }));
    expect(getByRole(root, "button", { name: /Model: GPT-6 Astra.*Pi CLI · ChatGPT subscription/ })).toBeTruthy();
  } finally {
    dispose();
    root.remove();
  }
});
