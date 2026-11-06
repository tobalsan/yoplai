// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, getByRole, getByText, queryByRole } from "@testing-library/dom";
import { render } from "solid-js/web";
import type { FileBlock } from "../../api/types";
import { FileCard } from "./ChatBlocks";

const file: FileBlock = {
  type: "file",
  fileId: "73b95cf7-43ec-4f5e-a61d-f8d87c74fd29",
  filename: "diagram.png",
  mimeType: "image/png",
  size: 68,
  direction: "outbound",
};
let container: HTMLDivElement;
let dispose: () => void;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => { dispose?.(); container.remove(); });

describe("sent image files", () => {
  it.each(["image/jpeg", "image/gif", "image/webp", "IMAGE/PNG"])("previews outbound %s", (mimeType) => {
    dispose = render(() => <FileCard file={{ ...file, mimeType }} />, container);
    expect(getByRole(container, "img", { name: "diagram.png" }).getAttribute("loading")).toBe("lazy");
    expect(getByRole(container, "link", { name: "Download" })).toBeTruthy();
  });

  it.each(["image/svg+xml", "application/pdf", "image/tiff", "image/heic", "application/octet-stream"])("keeps %s as a plain card", (mimeType) => {
    dispose = render(() => <FileCard file={{ ...file, mimeType }} />, container);
    expect(queryByRole(container, "img")).toBeNull();
    expect(getByText(container, "diagram.png")).toBeTruthy();
    expect(getByRole(container, "link", { name: "Download" })).toBeTruthy();
  });

  it("keeps inbound images as plain cards", () => {
    dispose = render(() => <FileCard file={{ ...file, direction: "inbound" }} />, container);
    expect(queryByRole(container, "img")).toBeNull();
    expect(getByText(container, "diagram.png")).toBeTruthy();
    expect(queryByRole(container, "link", { name: "Download" })).toBeNull();
  });

  it("shows a lazy authenticated preview alongside the original file download", () => {
    dispose = render(() => <FileCard file={file} />, container);
    const image = getByRole(container, "img", { name: "diagram.png" });
    expect(image.getAttribute("src")).toBe("/api/media/download/73b95cf7-43ec-4f5e-a61d-f8d87c74fd29");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(getByText(container, "diagram.png")).toBeTruthy();
    expect(getByRole(container, "link", { name: "Download" }).getAttribute("href"))
      .toBe("/api/media/download/73b95cf7-43ec-4f5e-a61d-f8d87c74fd29");
  });

  it("keeps the file download and removes the preview when loading fails", () => {
    dispose = render(() => <FileCard file={file} />, container);
    fireEvent.error(getByRole(container, "img"));
    expect(queryByRole(container, "img")).toBeNull();
    expect(queryByRole(container, "button", { name: "Open diagram.png" })).toBeNull();
    expect(getByText(container, "diagram.png")).toBeTruthy();
    expect(getByRole(container, "link", { name: "Download" })).toBeTruthy();
  });

  it("opens the image in a labelled dialog with focus and an original download", async () => {
    dispose = render(() => <FileCard file={file} />, container);
    fireEvent.click(getByRole(container, "button", { name: "Open diagram.png" }));
    await Promise.resolve();
    const dialog = getByRole(document.body, "dialog", { name: "diagram.png" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(getByText(dialog, "diagram.png")).toBeTruthy();
    expect(getByRole(dialog, "img", { name: "diagram.png" }).getAttribute("src"))
      .toBe("/api/media/download/73b95cf7-43ec-4f5e-a61d-f8d87c74fd29");
    const download = getByRole(dialog, "link", { name: "Download" });
    expect(download.getAttribute("href")).toBe("/api/media/download/73b95cf7-43ec-4f5e-a61d-f8d87c74fd29");
    expect(download.hasAttribute("download")).toBe(true);
    expect(document.activeElement).toBe(getByRole(dialog, "button", { name: "Close image" }));
  });

  it.each(["Escape", "close button", "backdrop", "space beside image"])("closes via %s and returns focus to the preview", async (method) => {
    dispose = render(() => <FileCard file={file} />, container);
    const preview = getByRole(container, "button", { name: "Open diagram.png" });
    fireEvent.click(preview);
    await Promise.resolve();
    const dialog = getByRole(document.body, "dialog");
    fireEvent.click(getByRole(dialog, "img"));
    expect(getByRole(document.body, "dialog")).toBe(dialog);
    if (method === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (method === "close button") fireEvent.click(getByRole(dialog, "button", { name: "Close image" }));
    else if (method === "space beside image") fireEvent.click(dialog);
    else fireEvent.click(dialog.parentElement!);
    expect(queryByRole(document.body, "dialog")).toBeNull();
    expect(document.activeElement).toBe(preview);
  });

  it("keeps keyboard focus within the viewer", async () => {
    dispose = render(() => <FileCard file={file} />, container);
    fireEvent.click(getByRole(container, "button", { name: "Open diagram.png" }));
    await Promise.resolve();
    const dialog = getByRole(document.body, "dialog");
    const download = getByRole(dialog, "link", { name: "Download" });
    const close = getByRole(dialog, "button", { name: "Close image" });
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(download);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it("returns Tab focus to the viewer after clicking its non-focusable image", async () => {
    dispose = render(() => <FileCard file={file} />, container);
    fireEvent.click(getByRole(container, "button", { name: "Open diagram.png" }));
    await Promise.resolve();
    const dialog = getByRole(document.body, "dialog");
    fireEvent.click(getByRole(dialog, "img"));
    // Browsers blur the active control when a non-focusable image is clicked.
    getByRole(dialog, "button", { name: "Close image" }).blur();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(getByRole(dialog, "link", { name: "Download" }));
  });
});
