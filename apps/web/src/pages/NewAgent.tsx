import { A, useBeforeLeave, useNavigate } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { createAgent, fetchAgentModels, fetchCreationGateways, type CreationGateway, type ModelChoice } from "../api/agent-management";
import { startNewChat } from "../api/chat";
import { qualifiedAgentId } from "../api/gateway";
import { AgentCraftingScreen, finishCrafting } from "../components/agent-management/AgentCraftingScreen";
import { AvatarField, preventFileNavigation, type AvatarDraft } from "../components/agent-management/AvatarField";
import { ModelField } from "../components/agent-management/ModelField";
import { createDiscardPrompt } from "../components/agent-management/discard";
import { Button } from "../components/ui/Button";
import { resolveModelChoice } from "../desktop-setup/api";

const initialFace = 1;

function createRequestId() {
  // LAN HTTP origins have getRandomValues but may lack randomUUID.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // UUID version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // UUID variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function NewAgent() {
  const navigate = useNavigate();
  const [gateways] = createResource(fetchCreationGateways);
  const [chosen, setChosen] = createSignal<CreationGateway>();
  const gateway = createMemo(() => chosen() ?? gateways()?.[0]);
  const [chooseFolder, setChooseFolder] = createSignal(false);
  const [folderPath, setFolderPath] = createSignal("");
  const customFolder = () => gateway()?.name && chooseFolder() ? folderPath().trim() : undefined;
  const [models, { refetch: retryModels }] = createResource(gateway, (target) => fetchAgentModels(target.name));
  const [model, setModel] = createSignal<ModelChoice>();
  createEffect(() => {
    if (models.state !== "ready") return;
    const current = model();
    if (current && !resolveModelChoice(models() ?? [], current)) setModel(undefined);
  });
  const [name, setName] = createSignal("");
  const [purpose, setPurpose] = createSignal("");
  const [avatar, setAvatar] = createSignal<AvatarDraft>({ face: initialFace });
  const [saving, setSaving] = createSignal(false);
  const [doneAt, setDoneAt] = createSignal<number>();
  const [error, setError] = createSignal("");
  let finished = false;
  let disposed = false;
  let requestId: string | undefined;
  onCleanup(() => { disposed = true; });

  const dirty = () => !finished && !!(name() || purpose() || model() || avatar().file || avatar().face !== initialFace || chosen() || chooseFolder());
  const discard = createDiscardPrompt(dirty, "Discard this new agent?");
  useBeforeLeave((event) => {
    if (saving() && !finished) { event.preventDefault(); return; }
    if (!dirty()) return;
    event.preventDefault();
    discard.request(() => { finished = true; event.retry(true); });
  });
  const leave = () => {
    if (!saving()) discard.request(() => { finished = true; navigate("/agents"); });
  };
  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || discard.pending()) return;
      event.preventDefault();
      leave();
    };
    window.addEventListener("keydown", keydown);
    onCleanup(() => window.removeEventListener("keydown", keydown));
  });
  preventFileNavigation();

  const ready = () => !!gateway() && !!name().trim() && !!model() && models.state === "ready" && customFolder() !== "" && !saving();
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const selected = model();
    const destination = gateway();
    if (!selected || !destination || !ready()) return;
    const folder = customFolder();
    if (folder && !folder.startsWith("/") && !folder.startsWith("~")) {
      setError("Enter an absolute folder path or start with ~/.");
      return;
    }
    setDoneAt(undefined);
    setSaving(true);
    setError("");
    try {
      requestId ??= createRequestId();
      const result = await createAgent({ name: name().trim(), purpose: purpose().trim(), requestId, model: selected, avatar: avatar().face, folder }, destination.name, avatar().file);
      if (disposed) return;
      await finishCrafting(setDoneAt);
      if (disposed) return;
      const agentId = qualifiedAgentId(result.id, destination.name);
      finished = true;
      startNewChat(agentId);
      navigate(`/chat/${encodeURIComponent(agentId)}`);
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Could not create the agent.");
    } finally {
      if (!disposed) setSaving(false);
    }
  };

  return <main class="new-agent-page">
    <A class="agent-form-back" href="/agents"><i class="fa-solid fa-arrow-left" aria-hidden="true" /> Agents</A>
    <h1>{name().trim() || "New agent"}</h1>
    <form class="agent-edit-fields" onSubmit={submit}>
      <Show when={gateways()?.some((target) => target.name !== undefined)}>
        <fieldset class="agent-gateway-target" disabled={saving()}>
          <legend> Create on </legend>
          <div class="agent-gateway-options">
            <For each={gateways()}>{(target) => <label>
              <input type="radio" name="creation-gateway" checked={gateway() === target} onChange={() => {
                setChosen(target);
                setError("");
                if (!target.name) {
                  setChooseFolder(false);
                  setFolderPath("");
                }
              }} />
              <span>{target.label}</span>
            </label>}</For>
          </div>
          <Show when={gateway()?.name}>
            <div class="agent-folder-option">
              <label class="agent-folder-choice">
                <input type="checkbox" checked={chooseFolder()} onChange={(event) => setChooseFolder(event.currentTarget.checked)} />
                Choose folder
              </label>
              <Show when={chooseFolder()}>
                <label class="agent-form-field">Agent folder
                  <input name="folder" placeholder="~/agent-name" spellcheck={false} value={folderPath()}
                    onInput={(event) => setFolderPath(event.currentTarget.value)} />
                </label>
              </Show>
            </div>
          </Show>
        </fieldset>
      </Show>
      <AvatarField value={avatar()} onChange={setAvatar} disabled={saving()} />
      <label class="agent-form-field">Name
        <input name="name" required maxLength={60} placeholder="Name your agent" value={name()} disabled={saving()}
          onInput={(event) => setName(event.currentTarget.value)} />
      </label>
      <label class="agent-form-field">
        <span>Purpose <span class="agent-field-hint">· Keep it brief. It will be used to generate the system instructions.</span></span>
        <input name="purpose" maxLength={280} placeholder="Plan trips, compare options, or help with writing." value={purpose()} disabled={saving()}
          onInput={(event) => setPurpose(event.currentTarget.value)} />
      </label>
      <ModelField models={models.error ? [] : models.latest ?? []} value={model()} disabled={models.state !== "ready" || saving()}
        local={!!gateway() && !gateway()?.name} onAccessChanged={retryModels} onChange={setModel} />
      <Show when={models.error}><p class="agent-form-error" role="alert">Could not load models. <button type="button" onClick={() => void retryModels()}>Retry</button></p></Show>
      <Show when={gateways()?.length === 0}><p class="agent-form-error" role="alert">No connected gateway allows agent creation.</p></Show>
      <Show when={error()}><p class="agent-form-error" role="alert">{error()}</p></Show>
      <footer class="agent-form-actions">
        <Button onClick={leave} disabled={saving()}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!ready()} loading={saving()} loadingLabel="Creating…">Create agent</Button>
      </footer>
    </form>
    <discard.Dialog />
    <Show when={saving()}>
      <AgentCraftingScreen name={name().trim()} face={avatar().face} file={avatar().file} doneAt={doneAt()} />
    </Show>
  </main>;
}
