// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { within } from "@testing-library/dom";

const { navigate, fetchSessions, fetchProject, saveInstructions, startNewChat, fetchFiles, uploadFile, deleteFile, fetchReferences, deleteReference, fetchNotes, saveNotes, renameProject } = vi.hoisted(() => ({
  navigate: vi.fn(), fetchSessions: vi.fn(), fetchProject: vi.fn(), saveInstructions: vi.fn(), startNewChat: vi.fn(), fetchFiles: vi.fn(), uploadFile: vi.fn(), deleteFile: vi.fn(),
  fetchReferences: vi.fn(), deleteReference: vi.fn(), fetchNotes: vi.fn(), saveNotes: vi.fn(), renameProject: vi.fn(),
}));
vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
  useParams: () => ({ id: "project-1" }),
  useNavigate: () => navigate,
}));
vi.mock("../api", () => ({
  fetchAgentSessions: fetchSessions,
  fetchAgents: vi.fn(async () => [{ id: "agent-1", name: "Writer" }, { id: "agent-2", name: "Researcher" }]),
  startNewChat,
}));
vi.mock("../api/chat-projects", () => ({
  fetchChatProjectReferences: fetchReferences, deleteChatProjectReference: deleteReference,
  fetchChatProjectNotes: fetchNotes, updateChatProjectNotes: saveNotes,
  fetchChatProjectFiles: fetchFiles,
  uploadChatProjectFile: uploadFile, deleteChatProjectFile: deleteFile,
  fetchChatProject: fetchProject,
  updateChatProjectInstructions: saveInstructions,
  renameChatProject: renameProject, deleteChatProject: vi.fn(),
}));
import { ChatProject } from "./ChatProject";
import { defaultAvatarUrl } from "../lib/default-avatar";
import { defaultAvatarSources } from "../lib/default-avatar.fixture";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
let dispose: (() => void) | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  fetchSessions.mockResolvedValue({ items: [] });
  fetchReferences.mockResolvedValue({ items: [] }); deleteReference.mockResolvedValue({});
  fetchNotes.mockResolvedValue({ text: "- Shared project learning" }); saveNotes.mockResolvedValue({ text: "" });
  fetchFiles.mockResolvedValue({ items: [] });
  uploadFile.mockResolvedValue(undefined); deleteFile.mockResolvedValue(undefined);
  fetchProject.mockResolvedValue({ id: "project-1", name: "Writing", instructions: "Be concise." });
  saveInstructions.mockResolvedValue({});
  container = document.createElement("div");
  document.body.append(container);
  dispose = render(() => <ChatProject />, container);
});
afterEach(() => { dispose?.(); container.remove(); });

describe("ChatProject", () => {
  it("shows the default avatar for a project chat whose agent has no avatar", async () => {
    dispose?.();
    fetchSessions.mockResolvedValue({ items: [{ agentId: "agent-1", sessionId: "s1", projectId: "project-1", title: "Draft", firstUserMessage: "", lastActivity: 1, pinned: null }] });
    dispose = render(() => <ChatProject />, container);
    await vi.waitFor(() => expect(defaultAvatarSources(container)).toContain(defaultAvatarUrl("agent-1")));
  });

  it("shows the default avatar for an agent with no avatar in the agent picker", async () => {
    await tick();
    within(container).getAllByRole("button", { name: "New chat" })[0].click();
    await vi.waitFor(() => expect(defaultAvatarSources(document.body)).toContain(defaultAvatarUrl("agent-2")));
  });

  it("swaps title to input on click and saves on Enter", async () => {
    await tick();
    renameProject.mockResolvedValue({});
    container.querySelector<HTMLElement>(".project-title-button")!.click();
    await tick();
    const input = container.querySelector<HTMLInputElement>("input.project-title-input")!;
    expect(input.value).toBe("Writing");
    input.value = "Essays";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    expect(renameProject).toHaveBeenCalledWith("project-1", "Essays");
  });

  it("cancels title edit on Escape", async () => {
    await tick();
    container.querySelector<HTMLElement>(".project-title-button")!.click();
    await tick();
    container.querySelector<HTMLInputElement>("input.project-title-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(container.querySelector("input.project-title-input")).toBeNull();
    expect(renameProject).not.toHaveBeenCalled();
  });

  it("renders only reference titles and descriptions and removes references", async () => {
    fetchReferences.mockResolvedValue({ items: [{ id: "ref-1", title: "Wiki section", description: "Useful background", path: "/private/wiki/section.md" }] });
    window.dispatchEvent(new Event("chat-projects-changed"));
    dispose?.(); dispose = render(() => <ChatProject />, container);
    await tick();
    expect(container.textContent).toContain("Wiki section");
    expect(container.textContent).toContain("Useful background");
    expect(container.innerHTML).not.toContain("/private/wiki/section.md");
    fetchReferences.mockResolvedValue({ items: [] });
    container.querySelector<HTMLButtonElement>('button[aria-label="Remove reference Wiki section"]')!.click();
    await tick();
    const confirmButton = Array.from(document.querySelectorAll("button")).find((btn) => btn.textContent === "Remove");
    expect(confirmButton).toBeTruthy();
    confirmButton!.click();
    await tick();
    expect(deleteReference).toHaveBeenCalledWith("project-1", "ref-1");
    expect(container.textContent).not.toContain("Wiki section");
  });

  const cardButton = (heading: string, label: string) =>
    Array.from(container.querySelector(`#${heading}`)!.closest(".project-card")!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === label
    )!;
  const modalButton = (label: string) =>
    Array.from(document.querySelectorAll(".ui-modal button")).find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement;
  const editorTextarea = () => document.querySelector<HTMLTextAreaElement>(".ui-modal textarea")!;
  const typeInEditor = (value: string) => {
    editorTextarea().value = value;
    editorTextarea().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const pressSave = (init: KeyboardEventInit) =>
    editorTextarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));

  it("renders notes as static markdown and edits them in a modal with Ctrl+Enter", async () => {
    fetchNotes.mockResolvedValue({ text: "# Learnings\n\n- Shared project learning" });
    dispose?.(); dispose = render(() => <ChatProject />, container);
    await tick();
    const card = container.querySelector("#notes-heading")!.closest(".project-card")!;
    expect(card.querySelector("textarea")).toBeNull();
    expect(card.querySelector(".project-markdown h1")?.textContent).toBe("Learnings");
    expect(card.querySelector(".project-markdown li")?.textContent).toBe("Shared project learning");
    cardButton("notes-heading", "Edit").click();
    await tick();
    expect(editorTextarea().value).toBe("# Learnings\n\n- Shared project learning");
    expect(document.querySelector(".ui-modal h2")?.textContent).toBe("Edit notes");
    typeInEditor("- Another agent can use this");
    await tick();
    pressSave({ ctrlKey: true });
    await tick();
    await tick();
    expect(saveNotes).toHaveBeenCalledWith("project-1", "- Another agent can use this");
    expect(document.querySelector(".ui-modal")).toBeNull();
  });

  it("keeps the notes modal open with the draft when save fails", async () => {
    await tick();
    cardButton("notes-heading", "Edit").click();
    await tick();
    saveNotes.mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
    typeInEditor("- New draft");
    await tick();
    modalButton("Save").click();
    await tick();
    await tick();
    expect(document.querySelector(".ui-modal__error")?.textContent).toContain("Unable to save notes");
    expect(editorTextarea().value).toBe("- New draft");
  });

  it("shows empty states with an Add affordance", async () => {
    fetchNotes.mockResolvedValue({ text: "" });
    fetchProject.mockResolvedValue({ id: "project-1", name: "Writing", instructions: "" });
    dispose?.(); dispose = render(() => <ChatProject />, container);
    await tick();
    expect(container.textContent).toContain("No notes yet.");
    expect(container.textContent).toContain("No instructions yet.");
    expect(cardButton("notes-heading", "Add")).toBeTruthy();
    expect(cardButton("instructions-heading", "Add")).toBeTruthy();
  });

  it("keeps project actions available after reference removal fails", async () => {
    fetchReferences.mockResolvedValue({ items: [{ id: "ref-1", title: "Wiki", description: "Context" }] });
    dispose?.(); dispose = render(() => <ChatProject />, container);
    await tick();
    deleteReference.mockRejectedValueOnce(new Error("Unavailable"));
    container.querySelector<HTMLButtonElement>('button[aria-label="Remove reference Wiki"]')!.click();
    await tick();
    const confirmButton = Array.from(document.querySelectorAll("button")).find((btn) => btn.textContent === "Remove");
    confirmButton!.click();
    await tick();
    expect(container.querySelector(".project-error")?.textContent).toContain("Unable to remove reference");
    expect(container.textContent).toContain("Context");
  });

  it("requires an explicit accessible agent choice and starts a fresh project chat", async () => {
    await tick();
    const newChatButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("New chat"));
    expect(newChatButton).toBeTruthy();
    newChatButton!.click();
    await tick();
    const agentRows = document.querySelectorAll(".agent-picker-row");
    expect(agentRows.length).toBe(2);
    expect(document.body.textContent).toContain("Writer");
    expect(document.body.textContent).toContain("Researcher");
    (agentRows[1] as HTMLButtonElement).click();
    expect(startNewChat).toHaveBeenCalledWith("agent-2");
    expect(navigate).toHaveBeenCalledWith("/chat/agent-2?project=project-1");
  });

  it("uploads and deletes files, displaying upload failures without blocking chat", async () => {
    await tick();
    fetchFiles.mockResolvedValue({ items: [{ id: "file-1", name: "notes.txt", size: 5, mimeType: "text/plain" }] });
    const input = container.querySelector<HTMLInputElement>("#project-file-upload")!;
    const file = new File(["Notes"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(uploadFile).toHaveBeenCalledWith("project-1", file);
    expect(container.textContent).toContain("notes.txt");
    fetchFiles.mockResolvedValue({ items: [] });
    container.querySelector<HTMLButtonElement>('button[aria-label="Delete notes.txt"]')!.click();
    await tick();
    const confirmButton = Array.from(document.querySelectorAll("button")).find((btn) => btn.textContent === "Delete");
    confirmButton!.click();
    await tick();
    expect(deleteFile).toHaveBeenCalledWith("project-1", "file-1");
    expect(container.textContent).not.toContain("notes.txt");
    uploadFile.mockRejectedValueOnce(new Error("Upload timed out"));
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(container.querySelector(".project-error")?.textContent).toBe("Upload timed out");
    expect(input.disabled).toBe(false);
  });

  it("renders instructions as markdown and saves from the modal with Cmd+Enter", async () => {
    fetchProject.mockResolvedValue({ id: "project-1", name: "Writing", instructions: "# Rules\n\nBe **concise**." });
    dispose?.(); dispose = render(() => <ChatProject />, container);
    await tick();
    const card = container.querySelector("#instructions-heading")!.closest(".project-card")!;
    expect(card.querySelector(".project-markdown strong")?.textContent).toBe("concise");
    cardButton("instructions-heading", "Edit").click();
    await tick();
    expect(document.querySelector(".ui-modal h2")?.textContent).toBe("Edit instructions");
    expect(editorTextarea().value).toBe("# Rules\n\nBe **concise**.");
    typeInEditor("Cite useful sources.");
    await tick();
    pressSave({ metaKey: true });
    await tick();
    await tick();
    expect(saveInstructions).toHaveBeenCalledWith("project-1", "Cite useful sources.");
    expect(document.querySelector(".ui-modal")).toBeNull();
  });

  it("discards the draft on Esc and Cancel without calling the API", async () => {
    await tick();
    cardButton("instructions-heading", "Edit").click();
    await tick();
    typeInEditor("discard me");
    await tick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(document.querySelector(".ui-modal")).toBeNull();
    cardButton("instructions-heading", "Edit").click();
    await tick();
    expect(editorTextarea().value).toBe("Be concise.");
    modalButton("Cancel").click();
    await tick();
    expect(document.querySelector(".ui-modal")).toBeNull();
    expect(saveInstructions).not.toHaveBeenCalled();
  });

  it("keeps the instructions modal open when save fails", async () => {
    await tick();
    cardButton("instructions-heading", "Edit").click();
    await tick();
    saveInstructions.mockRejectedValueOnce(new Error("Unavailable"));
    modalButton("Save").click();
    await tick();
    await tick();
    expect(document.querySelector(".ui-modal__error")?.textContent).toContain("Unable to save instructions");
  });

  it("renders 'Project not found.' and link to /agents when fetchChatProject rejects (404) without throwing", async () => {
    dispose?.();
    container.remove();
    fetchProject.mockRejectedValueOnce(new Error("Not found"));
    container = document.createElement("div");
    document.body.append(container);
    
    expect(() => {
      dispose = render(() => <ChatProject />, container);
    }).not.toThrow();
    
    await tick();
    await tick();
    
    expect(container.textContent).toContain("Project not found.");
    const link = container.querySelector('a[href="/agents"]');
    expect(link).toBeTruthy();
    expect(link?.textContent).toContain("Back to agents");
  });
});
