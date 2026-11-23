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

it("renders only inlined icon sources and leaves missing icons to the fallback", async () => {
  const iconDataUri = "data:image/svg+xml;base64,PHN2Zy8+";
  request.mockResolvedValueOnce(Response.json({ source: "fixture", fetchedAt: null, stale: false, entries: [
    { ...available, iconUrl: "https://example.test/sample.svg", iconDataUri },
    { ...other, iconUrl: "https://example.test/other.svg" },
  ] }));
  dispose = render(() => <ReleaseCatalog gateway="east" ready canWrite
    icon={(src) => <span>{src ?? "No icon source"}</span>} onChange={() => undefined} />, document.body);

  await vi.waitFor(() => {
    expect(within(getByRole(document.body, "article", { name: "Sample" })).getByText(iconDataUri)).toBeTruthy();
    expect(within(getByRole(document.body, "article", { name: "Other" })).getByText("No icon source")).toBeTruthy();
  });
});

it("keeps the displayed icon after install while the catalog list reloads", async () => {
  const iconUrl = "https://example.test/sample.svg";
  const iconDataUri = "data:image/svg+xml;base64,PHN2Zy8+";
  const installed: ReleaseCatalogRow = { ...available, iconUrl, state: "installed", installedVersion: "1.0.0" };
  request.mockResolvedValueOnce(catalog({ ...available, iconUrl, iconDataUri }));
  request.mockResolvedValueOnce(Response.json(installed));
  request.mockImplementationOnce(() => new Promise(() => undefined));
  dispose = render(() => <ReleaseCatalog gateway="east" ready canWrite
    icon={(src) => <span>{src}</span>} onChange={() => undefined} />, document.body);

  const card = () => within(getByRole(document.body, "article", { name: "Sample" }));
  await vi.waitFor(() => expect(card().getByText(iconDataUri)).toBeTruthy());
  fireEvent.click(card().getByRole("button", { name: "Install" }));
  await vi.waitFor(() => expect(card().getByText("Installed")).toBeTruthy());
  expect(card().getByText(iconDataUri)).toBeTruthy();
});

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

it.each([
  ["a dropped connection", () => { throw new TypeError("Failed to fetch"); }],
  ["a relay timeout", () => Response.json({ error: "gateway_offline", gateway: "east" }, { status: 502 })],
])("reads the linked gateway again before retrying after a lost install response (%s)", async (_name, lose) => {
  let sample = available;
  let installs = 0;
  request.mockImplementation(async (target, init) => {
    if (target === path && init?.method === "GET") return catalog(sample);
    if (target === `${path}/sample/install` && init?.method === "POST") {
      installs++;
      if (installs === 1) {
        setTimeout(() => { sample = { ...sample, state: "installed", installedVersion: "1.0.0" }; }, 20);
        return lose();
      }
      return Response.json(sample);
    }
    throw new Error(`Unexpected request: ${target}`);
  });
  dispose = render(() => <ReleaseCatalog gateway="east" ready canWrite icon={() => null} onChange={() => undefined} />, document.body);
  const card = () => within(getByRole(document.body, "article", { name: "Sample" }));
  await vi.waitFor(() => expect(card().getByRole("button", { name: "Install" })).toBeTruthy());
  fireEvent.click(card().getByRole("button", { name: "Install" }));
  await vi.waitFor(() => expect(card().getByRole("alert").textContent).toContain("unknown"));
  expect(card().queryByRole("button", { name: "Install" })).toBeNull();
  await new Promise((done) => setTimeout(done, 40));
  fireEvent.click(card().getByRole("button", { name: "Check current status" }));
  await vi.waitFor(() => expect(card().getByText("Installed")).toBeTruthy());
  expect(installs).toBe(1);
});
