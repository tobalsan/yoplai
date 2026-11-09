// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const {
  fetchChatProjectMock,
  fetchChatProjectFilesMock,
  fetchChatProjectReferencesMock,
  fetchChatProjectNotesMock,
  fetchAgentSessionsMock,
  fetchAgentsMock,
} = vi.hoisted(() => ({
  fetchChatProjectMock: vi.fn(),
  fetchChatProjectFilesMock: vi.fn(),
  fetchChatProjectReferencesMock: vi.fn(),
  fetchChatProjectNotesMock: vi.fn(),
  fetchAgentSessionsMock: vi.fn(),
  fetchAgentsMock: vi.fn(),
}));

vi.mock("../api/chat-projects", () => ({
  fetchChatProject: fetchChatProjectMock,
  fetchChatProjectFiles: fetchChatProjectFilesMock,
  fetchChatProjectReferences: fetchChatProjectReferencesMock,
  fetchChatProjectNotes: fetchChatProjectNotesMock,
  uploadChatProjectFile: vi.fn(),
  deleteChatProjectFile: vi.fn(),
  deleteChatProject: vi.fn(),
  renameChatProject: vi.fn(),
  updateChatProjectInstructions: vi.fn(),
  deleteChatProjectReference: vi.fn(),
  updateChatProjectNotes: vi.fn(),
}));

vi.mock("../api", () => ({
  fetchAgentSessions: fetchAgentSessionsMock,
  fetchAgents: fetchAgentsMock,
  startNewChat: vi.fn(),
}));

vi.mock("@solidjs/router", () => ({
  A: (props: any) => <a {...props} />,
  useParams: () => ({ id: "test-project" }),
  useNavigate: () => vi.fn(),
}));

let root: HTMLDivElement;
let dispose: () => void;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  fetchChatProjectMock.mockResolvedValue({
    id: "test-project",
    name: "Test Project",
    instructions: "",
  });
  fetchChatProjectFilesMock.mockResolvedValue({ items: [] });
  fetchChatProjectReferencesMock.mockResolvedValue({ items: [] });
  fetchChatProjectNotesMock.mockResolvedValue({ text: "" });
  fetchAgentSessionsMock.mockResolvedValue({ items: [] });
  fetchAgentsMock.mockResolvedValue([]);

  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  dispose?.();
  root.remove();
  vi.clearAllMocks();
});

describe("ChatProject file upload", () => {
  it("shows the extraction failure reason and full status in a tooltip", async () => {
    fetchChatProjectFilesMock.mockResolvedValue({ items: [{
      id: "encrypted", name: "protected.pdf", size: 100, mimeType: "application/pdf",
      extractionError: "PDF is password-protected",
      extractionNote: "Partial text: 30 of 45 scanned pages read",
    }] });
    const { ChatProject } = await import("./ChatProject");
    dispose = render(() => <ChatProject />, root);
    await tick();

    const status = root.querySelector<HTMLElement>(".project-file-error");
    expect(status?.textContent).toBe("Text unavailable: PDF is password-protected");
    expect(status?.title).toBe("Text unavailable: PDF is password-protected");
    expect(root.textContent).not.toContain("Partial text:");
  });

  it("shows partial extraction as a neutral note with a full tooltip", async () => {
    fetchChatProjectFilesMock.mockResolvedValue({ items: [{
      id: "partial", name: "mixed.pdf", size: 200, mimeType: "application/pdf",
      extractionNote: "Partial text: 30 of 45 scanned pages read",
    }] });
    const { ChatProject } = await import("./ChatProject");
    dispose = render(() => <ChatProject />, root);
    await tick();

    const status = root.querySelector<HTMLElement>(".project-file-status");
    expect(status?.textContent).toBe("Partial text: 30 of 45 scanned pages read");
    expect(status?.title).toBe("Partial text: 30 of 45 scanned pages read");
    expect(status?.classList.contains("project-file-error")).toBe(false);
    expect(root.textContent).not.toContain("Text unavailable");
  });

  it("shows the full file name in a tooltip on the name", async () => {
    fetchChatProjectFilesMock.mockResolvedValue({ items: [{
      id: "long", name: "2609_AOO_INTEGRATEUR_reponse_candidature_lot1_version_finale_v3.docx", size: 300,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }] });
    const { ChatProject } = await import("./ChatProject");
    dispose = render(() => <ChatProject />, root);
    await tick();

    const name = root.querySelector<HTMLElement>(".project-file-name");
    expect(name?.title).toBe("2609_AOO_INTEGRATEUR_reponse_candidature_lot1_version_finale_v3.docx");
  });

  it("clicking Upload button triggers file input click", async () => {
    const { ChatProject } = await import("./ChatProject");
    dispose = render(() => <ChatProject />, root);
    await tick();

    const fileInput = document.getElementById("project-file-upload") as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const clickSpy = vi.spyOn(fileInput, "click");

    const uploadButton = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Upload")
    );
    expect(uploadButton).toBeTruthy();

    uploadButton!.click();
    await tick();

    expect(clickSpy).toHaveBeenCalled();
  });
});
