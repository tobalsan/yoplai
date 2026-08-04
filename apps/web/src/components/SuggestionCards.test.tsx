// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { delegateEvents, render } from "solid-js/web";
import { SuggestionCards } from "./SuggestionCards";

describe("SuggestionCards", () => {
  it("renders cards and returns the selected prompt", () => {
    delegateEvents(["click"]);
    const onSelect = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <SuggestionCards
          suggestions={[{ title: "Plan work", prompt: "Plan this work" }]}
          onSelect={onSelect}
        />
      ),
      container
    );

    (container.querySelector("button") as HTMLButtonElement).click();
    expect(container.textContent).toContain("Plan work");
    expect(onSelect).toHaveBeenCalledWith("Plan this work");
    dispose();
    container.remove();
  });

  it("renders nothing for no suggestions", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => <SuggestionCards suggestions={[]} onSelect={vi.fn()} />,
      container
    );
    expect(container.innerHTML).toBe("");
    dispose();
    container.remove();
  });
});
