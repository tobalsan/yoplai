// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, getByRole, queryByRole, within } from "@testing-library/dom";
import { render } from "solid-js/web";
import { ReleaseCatalog } from "./ReleaseCatalog";
import { apiFetch } from "../../api/core";
import type { ReleaseCatalogRow } from "@yoplai/shared";

vi.mock("../../api/core", () => ({ apiFetch: vi.fn() }));
const request = vi.mocked(apiFetch);
const path = "/api/relay/gateways/east/api/admin/extension-catalog";
const available: ReleaseCatalogRow = { id: "sample", name: "Sample", description: "Sample details", tagline: "Read records", category: "data", version: "1.0.0", usedByAgents: 2, state: "available" };
const other: ReleaseCatalogRow = { id: "other", name: "Other", category: "search", usedByAgents: 0, state: "manual" };
const catalog = (sample: ReleaseCatalogRow) => Response.json({ source: "fixture", fetchedAt: null, stale: false, entries: [sample, other] });
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.resetAllMocks(); });

it("filters the catalog and installs, updates, and removes an extension", async () => {
  let sample = available;
  const writes: string[] = [];
  request.mockImplementation(async (target, init) => {
    if (target === path && init?.method === "GET") return catalog(sample);
    if (target === `${path}/refresh` && init?.method === "POST") {
      sample = { ...sample, state: "update", version: "2.0.0" };
      return catalog(sample);
    }
    if (target === `${path}/sample/install` && init?.method === "POST") {
      writes.push(`install ${sample.version}`);
      sample = { ...sample, state: "installed", installedVersion: sample.version };
      return Response.json(sample);
    }
    if (target === `${path}/sample` && init?.method === "DELETE") {
      writes.push("remove");
      sample = { ...sample, state: "available", installedVersion: undefined };
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${target}`);
  });
  dispose = render(() => <ReleaseCatalog gateway="east" ready canWrite icon={() => null} onChange={() => undefined} />, document.body);
  const card = () => within(getByRole(document.body, "article", { name: "Sample" }));
  await vi.waitFor(() => expect(card().getByRole("button", { name: "Install" })).toBeTruthy());
  fireEvent.click(getByRole(document.body, "button", { name: "data" }));
  expect(queryByRole(document.body, "article", { name: "Other" })).toBeNull();
  fireEvent.input(getByRole(document.body, "searchbox", { name: "Search the catalog" }), { target: { value: "missing" } });
  expect(queryByRole(document.body, "article", { name: "Sample" })).toBeNull();
  fireEvent.input(getByRole(document.body, "searchbox", { name: "Search the catalog" }), { target: { value: "records" } });
  fireEvent.click(card().getByRole("button", { name: "Sample" }));
  expect(card().getByText("Sample details")).toBeTruthy();
  fireEvent.click(card().getByRole("button", { name: "Install" }));
  await vi.waitFor(() => expect(card().getByText("Installed")).toBeTruthy());
  fireEvent.click(getByRole(document.body, "button", { name: "Refresh" }));
  await vi.waitFor(() => expect(card().getByRole("button", { name: "Update" })).toBeTruthy());
  fireEvent.click(card().getByRole("button", { name: "Update" }));
  await vi.waitFor(() => expect(card().getByText("Installed")).toBeTruthy());
  fireEvent.click(card().getByRole("button", { name: "Remove" }));
  const dialog = within(getByRole(document.body, "alertdialog", { name: "Remove Sample?" }));
  expect(dialog.getByText("Used by 2 agents.")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(queryByRole(document.body, "alertdialog")).toBeNull();
  expect(writes).toEqual(["install 1.0.0", "install 2.0.0"]);
  fireEvent.click(card().getByRole("button", { name: "Remove" }));
  fireEvent.click(getByRole(document.body, "button", { name: "Confirm removal" }));
  await vi.waitFor(() => expect(card().getByRole("button", { name: "Install" })).toBeTruthy());
  expect(writes).toEqual(["install 1.0.0", "install 2.0.0", "remove"]);
});

it("shows the server error or a fallback on the extension row", async () => {
  request.mockResolvedValueOnce(catalog(available));
  request.mockResolvedValueOnce(Response.json({ error: "The archive contains a file that is not allowed." }, { status: 409 }));
  request.mockResolvedValueOnce(new Response("Gateway failure", { status: 502 }));
  dispose = render(() => <ReleaseCatalog gateway="east" ready canWrite icon={() => null} onChange={() => undefined} />, document.body);
  const card = () => within(getByRole(document.body, "article", { name: "Sample" }));
  await vi.waitFor(() => expect(card().getByRole("button", { name: "Install" })).toBeTruthy());
  fireEvent.click(card().getByRole("button", { name: "Install" }));
  await vi.waitFor(() => expect(card().getByRole("alert").textContent).toBe("The archive contains a file that is not allowed."));
  fireEvent.click(card().getByRole("button", { name: "Install" }));
  await vi.waitFor(() => expect(card().getByRole("alert").textContent).toBe("The extension operation failed."));
});
