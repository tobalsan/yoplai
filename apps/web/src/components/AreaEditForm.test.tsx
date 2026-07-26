// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { AreaEditForm } from "./AreaEditForm";

describe("AreaEditForm", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("uses a native color picker for area colors", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const dispose = render(
      () => (
        <AreaEditForm
          draft={{ title: "Yoplai", color: "#3b82f6", order: "", repo: "" }}
          saving={false}
          error={null}
          onChange={() => {}}
          onSave={() => {}}
          onCancel={() => {}}
        />
      ),
      container
    );

    const input = container.querySelector(".area-edit-color");
    expect(input).not.toBeNull();
    expect(input?.getAttribute("type")).toBe("color");

    dispose();
  });
});
