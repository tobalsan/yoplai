// @vitest-environment jsdom
import { fireEvent, getByRole, queryAllByRole, waitFor, within } from "@testing-library/dom";
import { render } from "solid-js/web";
import { expect, it, vi } from "vitest";
import { ModelAccess } from "./ModelAccess";
import { readAccess, readModels, request } from "./api";

vi.mock("./api", async (load) => ({
  ...await load<typeof import("./api")>(),
  readAccess: vi.fn(),
  readModels: vi.fn(),
  request: vi.fn(),
}));

it("keeps provider rows in the same order when Pi becomes ready", async () => {
  let enabled = false;
  vi.mocked(readAccess).mockImplementation(async () => ({
    external: [
      { source: "codex", detected: true, enabled: false, denied: false },
      { source: "pi", detected: true, enabled, denied: false },
    ],
    owned: [], attempts: [], apiKeyProviders: [],
  }));
  vi.mocked(readModels).mockImplementation(async () => enabled ? [{
    provider: "anthropic", model: "claude-haiku", name: "Claude Haiku", source: "pi", credentialType: "oauth", default: true, ready: false, free: false,
  }] : []);
  vi.mocked(request).mockImplementation(async () => { enabled = true; return { enabled }; });
  const root = document.body.appendChild(document.createElement("div"));
  const dispose = render(() => <ModelAccess onContinue={() => undefined} />, root);
  const order = () => queryAllByRole(root, "region").map((row) => row.getAttribute("aria-label"));
  const expected = ["Codex CLI", "Pi CLI", "ChatGPT subscription", "Claude subscription", "API key"];
  try {
    await waitFor(() => expect(order()).toEqual(expected));
    const pi = () => within(getByRole(root, "region", { name: "Pi CLI" }));
    expect(pi().queryByText("Ready")).toBeNull();
    fireEvent.click(pi().getByRole("switch", { name: "Pi CLI", checked: false }));
    await waitFor(() => expect(pi().getByText("Ready")).toBeTruthy());
    expect(order()).toEqual(expected);
  } finally {
    dispose();
    root.remove();
    vi.resetAllMocks();
  }
});
