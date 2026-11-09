import { A, useNavigate, useParams } from "@solidjs/router";
import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js";
import { fetchAgents, fetchAgentSessions, startNewChat } from "../api";
import {
  deleteChatProjectFile,
  fetchChatProjectFiles,
  uploadChatProjectFile,
  deleteChatProject,
  fetchChatProject,
  renameChatProject,
  updateChatProjectInstructions,
  fetchChatProjectReferences,
  deleteChatProjectReference,
  fetchChatProjectNotes,
  updateChatProjectNotes,
} from "../api/chat-projects";
import { Modal } from "../components/ui/Modal";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Button } from "../components/ui/Button";
import { renderMarkdown } from "../lib/markdown";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - timestamp);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(timestamp).toLocaleDateString();
}

function getFileIcon(mimeType?: string): string {
  if (!mimeType) return "fa-file";
  if (mimeType.startsWith("image/")) return "fa-file-image";
  if (mimeType === "application/pdf") return "fa-file-pdf";
  if (mimeType.startsWith("text/") || mimeType.includes("json") || mimeType.includes("xml")) return "fa-file-lines";
  return "fa-file";
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ""
  );

export function ChatProject() {
  const params = useParams();
  const navigate = useNavigate();
  const [project, { refetch }] = createResource(() => params.id, fetchChatProject);
  const [files, { refetch: refetchFiles }] = createResource(() => params.id, fetchChatProjectFiles);
  const [references, { refetch: refetchReferences }] = createResource(() => params.id, fetchChatProjectReferences);
  const [notes, { refetch: refetchNotes }] = createResource(() => params.id, fetchChatProjectNotes);
  const [uploading, setUploading] = createSignal(false);
  // Reading an errored Solid resource throws; route all render-time reads through these.
  const projectData = () => (project.error ? undefined : project());
  const fileItems = () => (files.error ? [] : files()?.items ?? []);
  const referenceItems = () => (references.error ? [] : references()?.items ?? []);
  const notesData = () => (notes.error ? undefined : notes());
  const sessionItems = () => (sessions.error ? [] : sessions() ?? []);
  const agentItems = () => (agents.error ? [] : agents() ?? []);
  const [uploadingName, setUploadingName] = createSignal("");
  const [dragging, setDragging] = createSignal(false);
  const [sessions, { refetch: refetchSessions }] = createResource(
    () => params.id,
    async () => (await fetchAgentSessions()).items
  );
  const refresh = () => {
    void refetch();
    void refetchSessions();
  };
  window.addEventListener("chat-projects-changed", refresh);
  onCleanup(() => window.removeEventListener("chat-projects-changed", refresh));
  const [agents] = createResource(fetchAgents);
  const [choosingAgent, setChoosingAgent] = createSignal(false);
  const [editing, setEditing] = createSignal<"instructions" | "notes" | null>(null);
  const [draft, setDraft] = createSignal("");
  const [savingEdit, setSavingEdit] = createSignal(false);
  const [editError, setEditError] = createSignal("");
  const [error, setError] = createSignal("");
  const [editingTitle, setEditingTitle] = createSignal(false);
  const [titleInput, setTitleInput] = createSignal("");
  const [deletingFile, setDeletingFile] = createSignal<string | null>(null);
  const [deletingReference, setDeletingReference] = createSignal<string | null>(null);
  const [deletingProj, setDeletingProj] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  let fileInputRef: HTMLInputElement | undefined;
  let menuTriggerRef: HTMLButtonElement | undefined;

  const chats = () =>
    sessionItems()
      .filter((session) => session.projectId === params.id)
      .sort((a, b) => Number(b.pinned != null) - Number(a.pinned != null) || b.lastActivity - a.lastActivity);

  const changed = () => window.dispatchEvent(new Event("chat-projects-changed"));

  createEffect(() => {
    if (!menuOpen()) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (menuTriggerRef && !menuTriggerRef.contains(event.target as Node)) {
        const menu = document.querySelector(".project-menu");
        if (menu && !menu.contains(event.target as Node)) {
          setMenuOpen(false);
        }
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuTriggerRef?.focus();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    onCleanup(() => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    });
  });

  createEffect(() => {
    if (!menuOpen() && menuTriggerRef && document.activeElement !== menuTriggerRef) {
      const wasMenuClick = menuTriggerRef.contains(document.activeElement as Node);
      if (wasMenuClick) {
        menuTriggerRef.focus();
      }
    }
  });

  const startRename = () => {
    setTitleInput(projectData()?.name ?? "");
    setEditingTitle(true);
    setMenuOpen(false);
  };

  const focusTitleInput = (el: HTMLInputElement) => {
    queueMicrotask(() => {
      el.focus();
      el.select();
    });
  };

  const saveRename = async () => {
    if (!editingTitle()) return;
    const trimmed = titleInput().trim();
    if (!projectData()) return;
    if (!trimmed || trimmed === projectData()!.name) {
      cancelRename();
      return;
    }
    setEditingTitle(false);
    setError("");
    try {
      await renameChatProject(projectData()!.id, trimmed);
      await refetch();
      changed();
    } catch {
      setEditingTitle(true);
      setError("Unable to rename project. Try again.");
    }
  };

  const cancelRename = () => {
    setEditingTitle(false);
    setTitleInput(projectData()?.name ?? "");
  };

  const openEditor = (kind: "instructions" | "notes") => {
    setDraft(kind === "instructions" ? projectData()?.instructions ?? "" : notesData()?.text ?? "");
    setEditError("");
    setEditing(kind);
  };

  const closeEditor = () => {
    if (savingEdit()) return;
    setEditing(null);
  };

  const saveEdit = async () => {
    const kind = editing();
    const current = projectData();
    if (!kind || !current || savingEdit()) return;
    setSavingEdit(true);
    setEditError("");
    try {
      if (kind === "instructions") {
        await updateChatProjectInstructions(current.id, draft());
        await refetch();
        changed();
      } else {
        await updateChatProjectNotes(current.id, draft());
        await refetchNotes();
      }
      setEditing(null);
    } catch {
      setEditError(`Unable to save ${kind}. Try again.`);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleEditorKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void saveEdit();
    }
  };

  const focusEditorAtEnd = (el: HTMLTextAreaElement) => {
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const uploadSingleFile = async (file: File) => {
    if (!projectData()) return;
    setUploadingName(file.name);
    setUploading(true);
    setError("");
    try {
      await uploadChatProjectFile(projectData()!.id, file);
      await refetchFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to upload file. Try again.");
    } finally {
      setUploading(false);
      setUploadingName("");
    }
  };

  const handleFileUpload = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await uploadSingleFile(file);
    input.value = "";
  };

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    for (const file of files) {
      await uploadSingleFile(file);
    }
  };

  const removeFile = async (fileId: string) => {
    if (!projectData()) return;
    setError("");
    try {
      await deleteChatProjectFile(projectData()!.id, fileId);
      await refetchFiles();
      setDeletingFile(null);
    } catch {
      setError("Unable to delete file. Try again.");
    }
  };

  const removeReference = async (refId: string) => {
    if (!projectData()) return;
    setError("");
    try {
      await deleteChatProjectReference(projectData()!.id, refId);
      await refetchReferences();
      setDeletingReference(null);
    } catch {
      setError("Unable to remove reference. Try again.");
    }
  };

  const confirmDeleteProject = async () => {
    if (!projectData()) return;
    try {
      await deleteChatProject(projectData()!.id);
      changed();
      navigate("/agents");
    } catch {
      setError("Unable to delete project. Try again.");
    }
  };

  return (
    <main class="project-page">
      <Show when={error()}>
        <div class="project-error" role="alert">
          {error()}
        </div>
      </Show>
      <Show when={project.error}>
        <div class="project-not-found">
          <p>Project not found.</p>
          <A href="/agents">Back to agents</A>
        </div>
      </Show>
      <Show when={!project.error && sessions.error}>
        <div class="project-error" role="alert">
          Unable to load project. Try again.
        </div>
      </Show>
      <Show when={projectData()}>{(item) => (
        <>
          <header class="project-header">
            <div class="project-title-row">
              <i class="fa-solid fa-folder project-title-icon" aria-hidden="true" />
              <Show when={!editingTitle()} fallback={
                <input
                  ref={focusTitleInput}
                  type="text"
                  class="project-title-input"
                  value={titleInput()}
                  onInput={(e) => setTitleInput(e.currentTarget.value)}
                  onBlur={() => void saveRename()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveRename();
                    if (e.key === "Escape") cancelRename();
                  }}
                  aria-label="Rename project"
                />
              }>
                <h1 class="project-title">
                  <button
                    type="button"
                    class="project-title-button"
                    onClick={startRename}
                    aria-label="Rename project"
                    title="Click to rename"
                  >
                    {item().name}
                    <i class="fa-solid fa-pencil project-title-pencil" aria-hidden="true" />
                  </button>
                </h1>
              </Show>
            </div>
            <div class="project-meta">
              <Show when={!sessions.loading && !sessions.error} fallback="—">
                {chats().length} {chats().length === 1 ? "chat" : "chats"}
              </Show>
              {" · "}
              <Show when={!files.loading && !files.error} fallback="—">
                {fileItems().length} {fileItems().length === 1 ? "file" : "files"}
              </Show>
            </div>
            <div class="project-header-actions">
              <Button variant="primary" icon="fa-solid fa-plus" onClick={() => setChoosingAgent(true)}>
                New chat
              </Button>
              <div class="project-menu-wrap">
                <Button
                  ref={menuTriggerRef}
                  variant="ghost"
                  onClick={() => setMenuOpen(!menuOpen())}
                  aria-label="Project menu"
                  aria-expanded={menuOpen()}
                  aria-haspopup="menu"
                >
                  <i class="fa-solid fa-ellipsis-vertical" aria-hidden="true" />
                </Button>
                <Show when={menuOpen()}>
                  <div class="project-menu" role="menu">
                    <button
                      type="button"
                      class="project-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        startRename();
                      }}
                    >
                      Rename…
                    </button>
                    <button
                      type="button"
                      class="project-menu-item project-menu-item--danger"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setDeletingProj(true);
                      }}
                    >
                      Delete project…
                    </button>
                  </div>
                </Show>
              </div>
            </div>
          </header>

          <div class="project-body">
            <section class="project-main" aria-labelledby="chats-heading">
              <h2 id="chats-heading" class="project-section-label">Chats</h2>
              <Show when={sessions.loading}>
                <p class="project-loading">Loading</p>
              </Show>
              <Show when={sessions.error}>
                <div class="project-inline-error" role="alert">
                  Unable to load chats. Try again.
                  <Button variant="ghost" onClick={() => void refetchSessions()}>
                    Retry
                  </Button>
                </div>
              </Show>
              <Show
                when={!sessions.loading && !sessions.error && chats().length > 0}
                fallback={
                  <Show when={!sessions.loading && !sessions.error}>
                    <div class="project-empty-state">
                    <i class="fa-solid fa-folder-open" aria-hidden="true" />
                    <p>No chats yet</p>
                    <p>Start one with New chat, or move chats here from their ⋯ menu in the sidebar.</p>
                    <Button variant="primary" icon="fa-solid fa-plus" onClick={() => setChoosingAgent(true)}>
                      New chat
                    </Button>
                    </div>
                  </Show>
                }
              >
                <ul class="project-chats">
                  <For each={chats()}>{(session) => {
                    const agent = () => agentItems().find((a) => a.id === session.agentId);
                    return (
                      <li>
                        <A href={`/chat/${encodeURIComponent(session.agentId)}?session=${encodeURIComponent(session.sessionId)}`} class="project-chat-row">
                          <span class="project-chat-avatar">
                            <Show when={session.avatar} fallback={session.agentId[0]?.toUpperCase()}>
                              {(avatar) => (
                                <Show when={avatar().startsWith("/") || /^https?:\/\//i.test(avatar())} fallback={avatar()}>
                                  <img src={avatar()} alt="" />
                                </Show>
                              )}
                            </Show>
                          </span>
                          <div class="project-chat-main">
                            <div class="project-chat-title">{session.title || session.firstUserMessage || "New chat"}</div>
                            <div class="project-chat-meta">
                              {agent()?.name || session.agentId} · {relativeTime(session.lastActivity)}
                              <Show when={session.pinned != null}>
                                {" "}· <i class="fa-solid fa-thumbtack" aria-hidden="true" /> Pinned
                              </Show>
                            </div>
                          </div>
                        </A>
                      </li>
                    );
                  }}</For>
                </ul>
              </Show>
            </section>

            <div class="project-rail">
              <section class="project-card" aria-labelledby="instructions-heading">
                <div class="project-card-header">
                  <h2 id="instructions-heading" class="project-card-label">Instructions</h2>
                  <span class="project-card-edit">
                    <Button variant="ghost" icon="fa-solid fa-pen" onClick={() => openEditor("instructions")}>
                      {projectData()?.instructions?.trim() ? "Edit" : "Add"}
                    </Button>
                  </span>
                </div>
                <div class="project-card-body">
                  <Show
                    when={projectData()?.instructions?.trim()}
                    fallback={<p class="project-card-empty">No instructions yet.</p>}
                  >
                    {(text) => <div class="project-markdown markdown-content" innerHTML={renderMarkdown(text())} />}
                  </Show>
                </div>
              </section>

              <section class="project-card" aria-labelledby="files-heading">
                <div class="project-card-header">
                  <h2 id="files-heading" class="project-card-label">Files</h2>
                  <Button
                    variant="ghost"
                    icon="fa-solid fa-arrow-up-from-bracket"
                    disabled={uploading()}
                    onClick={() => fileInputRef?.click()}
                  >
                    Upload
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    id="project-file-upload"
                    class="project-file-input"
                    onChange={handleFileUpload}
                    disabled={uploading()}
                    aria-label="Upload file"
                  />
                </div>
                <div
                  class="project-card-body"
                  classList={{ "project-card-body--dragging": dragging() }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                >
                  <Show when={uploading()}>
                    <div class="project-file-uploading">Uploading {uploadingName()}…</div>
                  </Show>
                  <Show when={files.error}>
                    <p role="alert">Unable to load files. Try again.</p>
                  </Show>
                  <Show when={!files.loading && !files.error && (fileItems().length) === 0 && !uploading()}>
                    <p class="project-empty-hint">No files yet. Upload sources every chat in this project should know.</p>
                  </Show>
                  <Show when={(fileItems().length) > 0}>
                    <ul class="project-file-list">
                      <For each={fileItems()}>{(file) => (
                        <li class="project-file-row">
                          <i class={`fa-solid ${getFileIcon(file.mimeType)} project-file-icon`} aria-hidden="true" />
                          <div class="project-file-main">
                            <div class="project-file-name" title={file.name}>{file.name}</div>
                            <div class="project-file-meta">
                              {formatBytes(file.size)}
                              <Show when={file.extractionError}>
                                {" "}· <span class="project-file-status project-file-error" title={`Text unavailable: ${file.extractionError}`}>Text unavailable: {file.extractionError}</span>
                              </Show>
                              <Show when={!file.extractionError && file.extractionNote}>
                                {" "}· <span class="project-file-status" title={file.extractionNote}>{file.extractionNote}</span>
                              </Show>
                            </div>
                          </div>
                          <button
                            type="button"
                            class="project-file-remove"
                            onClick={() => setDeletingFile(file.id)}
                            aria-label={`Delete ${file.name}`}
                          >
                            <i class="fa-solid fa-xmark" aria-hidden="true" />
                          </button>
                        </li>
                      )}</For>
                    </ul>
                  </Show>
                </div>
              </section>

              <section class="project-card" aria-labelledby="references-heading">
                <div class="project-card-header">
                  <h2 id="references-heading" class="project-card-label">References</h2>
                </div>
                <div class="project-card-body">
                  <Show when={references.error}>
                    <p role="alert">Unable to load references. Try again.</p>
                    <Button variant="ghost" onClick={() => void refetchReferences()}>
                      Retry
                    </Button>
                  </Show>
                  <Show when={!references.loading && !references.error && (referenceItems().length) === 0}>
                    <p class="project-empty-hint">Agents add references here when they find useful company knowledge.</p>
                  </Show>
                  <Show when={(referenceItems().length) > 0}>
                    <ul class="project-reference-list">
                      <For each={referenceItems()}>{(reference) => (
                        <li class="project-reference-row">
                          <div class="project-reference-main">
                            <div class="project-reference-title">{reference.title}</div>
                            <div class="project-reference-description">{reference.description}</div>
                          </div>
                          <button
                            type="button"
                            class="project-reference-remove"
                            onClick={() => setDeletingReference(reference.id)}
                            aria-label={`Remove reference ${reference.title}`}
                          >
                            <i class="fa-solid fa-xmark" aria-hidden="true" />
                          </button>
                        </li>
                      )}</For>
                    </ul>
                  </Show>
                </div>
              </section>

              <section class="project-card" aria-labelledby="notes-heading">
                <div class="project-card-header">
                  <div>
                    <h2 id="notes-heading" class="project-card-label">Notes</h2>
                    <span class="project-card-hint">Agents append here; you can edit.</span>
                  </div>
                  <Show when={!notes.error}>
                    <span class="project-card-edit">
                      <Button variant="ghost" icon="fa-solid fa-pen" disabled={notes.loading} onClick={() => openEditor("notes")}>
                        {notesData()?.text?.trim() ? "Edit" : "Add"}
                      </Button>
                    </span>
                  </Show>
                </div>
                <div class="project-card-body">
                  <Show when={notes.error}>
                    <p role="alert">Unable to load notes. Try again.</p>
                    <Button variant="ghost" onClick={() => void refetchNotes()}>
                      Retry
                    </Button>
                  </Show>
                  <Show when={!notes.error}>
                    <Show
                      when={notesData()?.text?.trim()}
                      fallback={<p class="project-card-empty">No notes yet.</p>}
                    >
                      {(text) => <div class="project-markdown markdown-content" innerHTML={renderMarkdown(text())} />}
                    </Show>
                  </Show>
                </div>
              </section>
            </div>
          </div>
        </>
      )}</Show>

      <Show when={editing()}>
        {(kind) => (
          <Modal
            title={kind() === "instructions" ? "Edit instructions" : "Edit notes"}
            size="lg"
            error={editError() || undefined}
            onClose={closeEditor}
            footer={
              <>
                <Button variant="secondary" onClick={closeEditor} disabled={savingEdit()}>
                  Cancel <kbd class="project-kbd">esc</kbd>
                </Button>
                <Button variant="primary" onClick={() => void saveEdit()} loading={savingEdit()} loadingLabel="Saving…">
                  Save <kbd class="project-kbd">{IS_MAC ? "⌘ ↵" : "Ctrl ↵"}</kbd>
                </Button>
              </>
            }
          >
            <textarea
              ref={focusEditorAtEnd}
              class="project-editor-textarea"
              aria-label={kind() === "instructions" ? "Instructions" : "Notes"}
              placeholder={kind() === "instructions" ? "What should agents know when working in this project?" : undefined}
              value={draft()}
              disabled={savingEdit()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={handleEditorKeyDown}
            />
          </Modal>
        )}
      </Show>

      <Show when={choosingAgent()}>
        <Modal
          title={`New chat in ${projectData()?.name ?? "this project"}`}
          onClose={() => setChoosingAgent(false)}
          footer={
            <Button variant="secondary" onClick={() => setChoosingAgent(false)}>
              Cancel
            </Button>
          }
        >
          <div class="agent-picker-subtitle">Who do you want to talk to?</div>
          <Show when={agents.loading}>
            <p class="agent-picker-loading">Loading agents</p>
          </Show>
          <Show when={agents.error}>
            <p role="alert">Unable to load agents. Try again.</p>
          </Show>
          <Show when={!agents.loading && !agents.error && agentItems().length === 0}>
            <p class="agent-picker-empty">No agents available.</p>
          </Show>
          <div class="agent-picker-list">
            <For each={agentItems()}>{(agent) => (
              <button
                type="button"
                class="agent-picker-row"
                onClick={() => {
                  if (!params.id) return;
                  startNewChat(agent.id);
                  navigate(`/chat/${encodeURIComponent(agent.id)}?project=${encodeURIComponent(params.id)}`);
                }}
              >
                <span class="agent-picker-avatar">
                  <Show when={agent.avatar} fallback={agent.id[0]?.toUpperCase()}>
                    {(avatar) => (
                      <Show when={avatar().startsWith("/") || /^https?:\/\//i.test(avatar())} fallback={avatar()}>
                        <img src={avatar()} alt="" />
                      </Show>
                    )}
                  </Show>
                </span>
                <div class="agent-picker-main">
                  <div class="agent-picker-name">{agent.name || agent.id}</div>
                  <Show when={agent.description}>
                    <div class="agent-picker-description">{agent.description}</div>
                  </Show>
                </div>
              </button>
            )}</For>
          </div>
        </Modal>
      </Show>

      <Show when={deletingFile()}>
        {(fileId) => {
          const file = () => fileItems().find((f) => f.id === fileId());
          return (
            <ConfirmDialog
              title={`Delete ${file()?.name ?? "this file"}?`}
              description="This file will be removed from all chats in this project."
              confirmLabel="Delete"
              danger
              onConfirm={() => removeFile(fileId())}
              onCancel={() => setDeletingFile(null)}
            />
          );
        }}
      </Show>

      <Show when={deletingReference()}>
        {(refId) => {
          const ref = () => referenceItems().find((r) => r.id === refId());
          return (
            <ConfirmDialog
              title={`Remove ${ref()?.title ?? "this reference"}?`}
              description="This reference will be removed from the project context."
              confirmLabel="Remove"
              danger
              onConfirm={() => removeReference(refId())}
              onCancel={() => setDeletingReference(null)}
            />
          );
        }}
      </Show>

      <Show when={deletingProj()}>
        <ConfirmDialog
          title={`Delete "${projectData()?.name}"?`}
          description="Its chats are kept and go back to Recent."
          confirmLabel="Delete project"
          danger
          onConfirm={() => confirmDeleteProject()}
          onCancel={() => setDeletingProj(false)}
          error={error()}
        />
      </Show>

      <style>{`
        .project-page {
          max-width: 1100px;
          margin: 0 auto;
          padding: 32px 40px;
          color: var(--text-primary);
        }

        @media (max-width: 900px) {
          .project-page {
            padding: 24px 20px;
          }
        }

        .project-error {
          margin: 0 0 16px;
          padding: 12px 14px;
          border-radius: 8px;
          background: color-mix(in srgb, var(--tone-error, #dc2626) 10%, transparent);
          color: var(--tone-error, #dc2626);
          font-size: 13px;
        }

        .project-header {
          margin-bottom: 32px;
        }

        .project-title-row {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 6px;
        }

        .project-title-icon {
          font-size: 20px;
          color: var(--text-secondary);
        }

        .project-title {
          margin: 0;
          font-size: 22px;
          font-weight: 650;
          letter-spacing: -0.01em;
        }

        .project-title-button {
          border: 1px solid transparent;
          border-radius: 6px;
          background: transparent;
          color: inherit;
          font: inherit;
          padding: 2px 6px;
          margin: 0 -7px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }

        .project-title-button:hover {
          background: var(--bg-raised);
        }

        .project-title-button:hover .project-title-pencil {
          opacity: 1;
        }

        .project-title-pencil {
          font-size: 14px;
          color: var(--text-tertiary);
          opacity: 0;
          transition: opacity 150ms;
        }

        .project-title-input {
          flex: 1;
          min-width: 0;
          border: 1px solid var(--border-default);
          border-radius: 6px;
          background: var(--bg-input, var(--bg-overlay));
          color: var(--text-primary);
          font-size: 22px;
          font-weight: 650;
          font-family: inherit;
          letter-spacing: -0.01em;
          line-height: inherit;
          padding: 2px 6px;
          margin: 0 -7px;
          outline: none;
        }

        .project-title-input:focus-visible {
          outline: 2px solid rgba(59, 130, 246, 0.6);
          outline-offset: 1px;
        }

        .project-meta {
          font-size: 13px;
          color: var(--text-secondary);
          margin-bottom: 16px;
        }

        .project-header-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .project-menu-wrap {
          position: relative;
        }

        .project-menu {
          position: absolute;
          top: 100%;
          right: 0;
          margin-top: 4px;
          min-width: 160px;
          background: var(--bg-surface);
          border: 1px solid var(--border-default);
          border-radius: 8px;
          padding: 4px;
          box-shadow: 0 4px 12px var(--shadow-md);
          z-index: 10;
        }

        .project-menu-item {
          display: block;
          width: 100%;
          padding: 8px 12px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: var(--text-primary);
          font-size: 13px;
          font-family: inherit;
          text-align: left;
          cursor: pointer;
          transition: background 150ms;
        }

        .project-menu-item:hover {
          background: var(--bg-raised);
        }

        .project-menu-item--danger {
          color: var(--tone-error, #dc2626);
        }

        .project-body {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 320px;
          gap: 32px;
        }

        @media (max-width: 900px) {
          .project-body {
            grid-template-columns: minmax(0, 1fr);
          }

        }

        .project-section-label {
          margin: 0 0 12px;
          font-size: 11px;
          font-weight: 700;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        .project-chats {
          list-style: none;
          margin: 0;
          padding: 0;
        }

        .project-chat-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border-radius: 8px;
          background: transparent;
          color: var(--text-primary);
          text-decoration: none;
          transition: background 150ms;
        }

        .project-chat-row:hover {
          background: var(--bg-raised);
        }

        .project-chat-avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          flex-shrink: 0;
          display: grid;
          place-items: center;
          background: var(--bg-raised);
          overflow: hidden;
          font-size: 13px;
          font-weight: 600;
          color: var(--text-secondary);
        }

        .project-chat-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .project-chat-main {
          flex: 1;
          min-width: 0;
        }

        .project-chat-title {
          font-size: 14px;
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .project-chat-meta {
          font-size: 12px;
          color: var(--text-secondary);
          margin-top: 2px;
        }

        .project-chat-meta i {
          font-size: 11px;
          color: var(--text-tertiary);
        }

        .project-empty-state {
          padding: 48px 32px;
          text-align: center;
          border: 1px solid var(--border-subtle);
          border-radius: 10px;
          background: var(--bg-surface);
        }

        .project-empty-state > i {
          font-size: 32px;
          color: var(--text-tertiary);
          margin-bottom: 12px;
        }

        .project-empty-state p {
          margin: 0 0 8px;
          color: var(--text-secondary);
          font-size: 14px;
          line-height: 1.5;
        }

        .project-empty-state p:last-of-type {
          margin-bottom: 20px;
        }

        .project-card {
          background: var(--bg-surface);
          border: 1px solid var(--border-default);
          border-radius: 10px;
          padding: 14px 16px;
          margin-bottom: 16px;
        }

        .project-card:last-child {
          margin-bottom: 0;
        }

        .project-card-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          margin-bottom: 12px;
        }

        .project-card-label {
          font-size: 11px;
          font-weight: 700;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        .project-card-hint {
          font-size: 12px;
          color: var(--text-tertiary);
        }

        .project-card-body {
          display: flex;
          flex-direction: column;
          gap: 8px;
          transition: border 150ms, background 150ms;
        }

        .project-card-body--dragging {
          border: 2px dashed var(--border-default);
          border-radius: 8px;
          padding: 8px;
          background: var(--bg-raised);
        }

        .project-file-input {
          display: none;
        }

        .project-file-uploading {
          padding: 8px 10px;
          border-radius: 6px;
          background: var(--bg-raised);
          color: var(--text-secondary);
          font-size: 12px;
        }

        .project-file-list,
        .project-reference-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .project-file-row,
        .project-reference-row {
          display: flex;
          gap: 10px;
          padding: 8px 10px;
          border-radius: 6px;
          background: transparent;
          transition: background 150ms;
        }

        .project-file-row {
          align-items: flex-start;
        }

        .project-reference-row {
          align-items: center;
        }

        .project-file-row:hover,
        .project-reference-row:hover {
          background: var(--bg-raised);
        }

        .project-file-row:hover .project-file-remove,
        .project-reference-row:hover .project-reference-remove {
          opacity: 1;
        }

        .project-file-icon {
          font-size: 14px;
          color: var(--text-tertiary);
          flex-shrink: 0;
          margin-top: 2px;
        }

        .project-file-main,
        .project-reference-main {
          flex: 1;
          min-width: 0;
        }

        .project-file-name {
          font-size: 13px;
          line-height: 1.35;
          white-space: normal;
          overflow-wrap: anywhere;
        }

        .project-reference-title {
          font-size: 13px;
          font-weight: 600;
        }

        .project-file-meta {
          display: flex;
          align-items: baseline;
          gap: 4px;
          font-size: 12px;
          color: var(--text-secondary);
          margin-top: 2px;
          white-space: nowrap;
        }

        .project-file-status {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .project-file-error {
          color: var(--tone-error, #dc2626);
        }

        .project-reference-description {
          font-size: 12px;
          color: var(--text-secondary);
          margin-top: 2px;
        }

        .project-file-remove,
        .project-reference-remove {
          padding: 4px 6px;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: var(--text-tertiary);
          cursor: pointer;
          opacity: 0;
          transition: opacity 150ms, background 150ms;
          flex-shrink: 0;
        }

        .project-file-remove:hover,
        .project-reference-remove:hover {
          background: color-mix(in srgb, var(--tone-error, #dc2626) 15%, transparent);
          color: var(--tone-error, #dc2626);
        }

        .project-file-remove:focus-visible,
        .project-reference-remove:focus-visible {
          opacity: 1;
        }

        .project-empty-hint {
          margin: 0;
          padding: 8px 0;
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.5;
        }

        .project-card-edit {
          opacity: 0;
          transition: opacity 150ms;
        }

        .project-card-edit .ui-button {
          padding: 3px 8px;
          font-size: 12px;
        }

        .project-card:hover .project-card-edit,
        .project-card:focus-within .project-card-edit {
          opacity: 1;
        }

        @media (hover: none) {
          .project-card-edit {
            opacity: 1;
          }
        }

        .project-card-empty {
          margin: 0;
          font-size: 13px;
          color: var(--text-tertiary);
        }

        .project-markdown {
          max-height: 240px;
          overflow-y: auto;
          font-size: 13px;
          line-height: 1.55;
          color: var(--text-primary);
          overflow-wrap: anywhere;
          scrollbar-width: thin;
          scrollbar-gutter: stable;
          scrollbar-color: transparent transparent;
          transition: scrollbar-color 150ms ease;
        }

        .project-card:hover .project-markdown,
        .project-markdown:focus-within {
          scrollbar-color: var(--scrollbar-thumb) transparent;
        }

        .project-markdown::-webkit-scrollbar {
          width: 6px;
        }

        .project-markdown::-webkit-scrollbar-track {
          background: transparent;
        }

        .project-markdown::-webkit-scrollbar-thumb {
          background: transparent;
          border-radius: 999px;
        }

        .project-card:hover .project-markdown::-webkit-scrollbar-thumb {
          background: var(--scrollbar-thumb);
        }

        .project-markdown h1,
        .project-markdown h2,
        .project-markdown h3,
        .project-markdown h4,
        .project-markdown h5,
        .project-markdown h6 {
          margin: 12px 0 4px;
          font-size: 13px;
          font-weight: 650;
          text-transform: none;
          letter-spacing: normal;
          color: var(--text-primary);
        }

        .project-markdown p,
        .project-markdown ul,
        .project-markdown ol {
          margin: 0 0 8px;
        }

        .project-markdown ul,
        .project-markdown ol {
          padding-left: 18px;
        }

        .project-markdown pre {
          overflow-x: auto;
        }

        .project-editor-textarea {
          width: 100%;
          height: 60vh;
          box-sizing: border-box;
          resize: none;
          border: 1px solid var(--border-default);
          border-radius: 6px;
          background: var(--bg-overlay);
          color: var(--text-primary);
          padding: 10px 12px;
          font-size: 13px;
          line-height: 1.55;
          font-family: inherit;
        }

        .project-editor-textarea:focus-visible {
          outline: 2px solid rgba(59, 130, 246, 0.6);
          outline-offset: 2px;
        }

        .project-kbd {
          padding: 0 5px;
          border: 1px solid currentColor;
          border-radius: 4px;
          font-family: inherit;
          font-size: 11px;
          line-height: 1.5;
          opacity: 0.65;
        }

        .project-not-found {
          padding: 80px 20px;
          text-align: center;
          color: var(--text-secondary);
          font-size: 14px;
        }

        .project-not-found a {
          color: var(--text-primary);
        }

        .project-loading,
        .agent-picker-loading,
        .agent-picker-empty {
          margin: 0;
          padding: 16px 0;
          font-size: 13px;
          color: var(--text-tertiary);
          text-align: center;
        }

        .project-inline-error {
          padding: 12px;
          border-radius: 8px;
          background: color-mix(in srgb, var(--tone-error, #dc2626) 10%, transparent);
          color: var(--tone-error, #dc2626);
          font-size: 13px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .agent-picker-subtitle {
          margin: -8px 0 12px;
          font-size: 13px;
          color: var(--text-secondary);
        }

        .agent-picker-list {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .agent-picker-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border: none;
          border-radius: 8px;
          background: transparent;
          color: var(--text-primary);
          font-family: inherit;
          text-align: left;
          cursor: pointer;
          transition: background 150ms;
        }

        .agent-picker-row:hover {
          background: var(--bg-raised);
        }

        .agent-picker-avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          flex-shrink: 0;
          display: grid;
          place-items: center;
          background: var(--bg-raised);
          overflow: hidden;
          font-size: 13px;
          font-weight: 600;
          color: var(--text-secondary);
        }

        .agent-picker-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .agent-picker-main {
          flex: 1;
          min-width: 0;
        }

        .agent-picker-name {
          font-size: 14px;
          font-weight: 600;
        }

        .agent-picker-description {
          font-size: 12px;
          color: var(--text-secondary);
          margin-top: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      `}</style>
    </main>
  );
}
