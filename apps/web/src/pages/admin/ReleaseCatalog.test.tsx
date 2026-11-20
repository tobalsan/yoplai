// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, getByRole, queryByRole, within } from "@testing-library/dom";
import { render } from "solid-js/web";
import { ReleaseCatalog } from "./ReleaseCatalog";
import { fetchReleaseCatalog, changeReleaseCatalog } from "../../api/release-catalog";
import type { ReleaseCatalogRow } from "@yoplai/shared";

vi.mock("../../api/release-catalog", () => ({ fetchReleaseCatalog: vi.fn(), changeReleaseCatalog: vi.fn(), releaseCatalogChanged: "catalog-change" }));
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.resetAllMocks(); });

it("filters the catalog and installs, updates, and removes an extension", async () => {
  let sample: ReleaseCatalogRow = { id: "sample", name: "Sample", description: "Sample details", tagline: "Read records", category: "data", version: "1.0.0", usedByAgents: 2, state: "available" };
  const other: ReleaseCatalogRow = { id: "other", name: "Other", category: "search", usedByAgents: 0, state: "manual" };
  vi.mocked(fetchReleaseCatalog).mockImplementation(async (_gateway, refresh) => {
    if (refresh && sample.state === "installed") sample = { ...sample, state: "update", version: "2.0.0" };
    return { source: "fixture", fetchedAt: null, stale: false, entries: [sample, other] };
  });
  vi.mocked(changeReleaseCatalog).mockImplementation(async (_gateway, _id, remove) => {
    sample = { ...sample, state: remove ? "available" : "installed", installedVersion: remove ? undefined : sample.version };
    return remove ? undefined : sample;
  });
  dispose = render(() => <ReleaseCatalog gateway="east" ready canWrite icon={() => null} onChange={() => undefined} />, document.body);
  const card = () => within(getByRole(document.body, "article", { name: "Sample" }));
  await vi.waitFor(() => expect(card().getByRole("button", { name: "Install" })).toBeTruthy());
  fireEvent.click(getByRole(document.body, "button", { name: "data" }));
  expect(queryByRole(document.body, "article", { name: "Other" })).toBeNull();
  fireEvent.input(getByRole(document.body, "searchbox"), { target: { value: "missing" } });
  expect(queryByRole(document.body, "article", { name: "Sample" })).toBeNull();
  fireEvent.input(getByRole(document.body, "searchbox"), { target: { value: "records" } });
  fireEvent.click(card().getByRole("button", { name: "Sample" }));
  expect(card().getByText("Sample details")).toBeTruthy();
  fireEvent.click(card().getByRole("button", { name: "Install" }));
  await vi.waitFor(() => expect(card().getByText("Installed")).toBeTruthy());
  fireEvent.click(getByRole(document.body, "button", { name: "Refresh" }));
  await vi.waitFor(() => expect(card().getByRole("button", { name: "Update" })).toBeTruthy());
  fireEvent.click(card().getByRole("button", { name: "Update" }));
  await vi.waitFor(() => expect(card().getByText("Installed")).toBeTruthy());
  fireEvent.click(card().getByRole("button", { name: "Remove" }));
  expect(within(card().getByRole("group", { name: "Remove Sample" })).getByText(/Used by 2 agents/)).toBeTruthy();
  fireEvent.click(card().getByRole("button", { name: "Confirm removal" }));
  await vi.waitFor(() => expect(card().getByRole("button", { name: "Install" })).toBeTruthy());
  expect(vi.mocked(changeReleaseCatalog).mock.calls).toEqual([["east", "sample", false], ["east", "sample", false], ["east", "sample", true]]);
});
