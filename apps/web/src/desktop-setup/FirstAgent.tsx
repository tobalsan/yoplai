import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { AgentCraftingScreen, finishCrafting } from "../components/agent-management/AgentCraftingScreen";
import { ManagedModelPicker } from "./ManagedModelPicker";
import type { ModelChoice } from "../api/agent-management";
import { errorText, modelKey, request, resolveModelChoice, type Model } from "./api";

const names = ["Jarvis", "Samantha", "YoplaiBot", "AI Chief of Staff"];
const randomName = () => names[Math.floor(Math.random() * names.length)];
const suggestions = [
  ["Inbox helper", "Sort my inbox and draft my replies."],
  ["Research partner", "Compare options and summarize your findings."],
  ["Writing partner", "Draft and edit my writing."],
  ["Daily planner", "Plan my day and track my tasks."],
  ["Coding helper", "Help me write and review code."],
  ["Learning coach", "Explain new topics and help me practice."],
];
const rank = (source: string) => source === "owned" ? 0 : source === "environment" ? 2 : 1;

type Draft = { sessionId?: string; turnId?: string; requestId: string; name: string; purpose: string; avatar: number; model: ModelChoice };

const draftKey = "yoplai:desktop-setup-draft";
export const clearAgentDraft = () => sessionStorage.removeItem(draftKey);
export function readAgentDraft(): Draft | undefined {
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey) ?? "null") as Draft | null;
    if (draft && typeof draft.requestId === "string" && typeof draft.name === "string" &&
      typeof draft.purpose === "string" && Number.isInteger(draft.avatar) && draft.avatar >= 1 && draft.avatar <= 10 &&
      typeof draft.model?.provider === "string" && typeof draft.model.model === "string") return draft;
  } catch { return undefined; }
}

export function FirstAgent(props: { models: Model[]; onCreated: (id: string, sessionId: string, turnId: string) => Promise<void>; onBusy: (busy: boolean) => void; onAccessChanged: () => unknown }) {
  const saved = readAgentDraft();
  const [name, setName] = createSignal(saved?.name ?? randomName());
  const [purpose, setPurpose] = createSignal(saved?.purpose ?? "");
  const [avatar, setAvatar] = createSignal(saved?.avatar ?? Math.floor(Math.random() * 10) + 1);
  const defaultModel = [...props.models].sort((a, b) => rank(a.source) - rank(b.source)).find((model) => model.default);
  const initialModel = saved ? resolveModelChoice(props.models, saved.model) : defaultModel;
  const [selected, setSelected] = createSignal(initialModel ? modelKey(initialModel) : "");
  const [creating, setCreating] = createSignal<Draft>();
  const [doneAt, setDoneAt] = createSignal<number>();
  const [error, setError] = createSignal("");
  const [retry, setRetry] = createSignal<Draft | undefined>(saved);
  const model = createMemo(() => props.models.find((row) => modelKey(row) === selected()));
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const change = () => { setRetry(undefined); setError(""); };
  const create = async (draft: Draft) => {
    if (creating()) return;
    props.onBusy(true);
    setError("");
    setRetry(undefined);
    setDoneAt(undefined);
    setCreating(draft);
    try {
      const sessionId = draft.sessionId ?? crypto.randomUUID();
      const turnId = draft.turnId ?? crypto.randomUUID();
      draft = { ...draft, sessionId, turnId };
      sessionStorage.setItem(draftKey, JSON.stringify(draft));
      const result = await request<{ id: string }>("agents", "POST", { requestId: draft.requestId, name: draft.name, purpose: draft.purpose, avatar: draft.avatar, model: draft.model });
      if (disposed) return;
      await finishCrafting(setDoneAt);
      if (!disposed) await props.onCreated(result.id, sessionId, turnId);
    } catch (cause) {
      if (!disposed) { setError(errorText(cause)); setRetry(draft); }
    } finally {
      if (!disposed) { setCreating(undefined); props.onBusy(false); }
    }
  };
  return <form onSubmit={(event) => {
    event.preventDefault();
    const draft = retry();
    if (draft) { void create(draft); return; }
    const option = model();
    if (!option) return;
    const chosenName = name().trim() || randomName();
    setName(chosenName);
    void create({ requestId: crypto.randomUUID(), name: chosenName, purpose: purpose(), avatar: avatar(), model: { provider: option.provider, model: option.model, source: option.source } });
  }}>
    <div class="setup-agent-grid">
      <div class="setup-preview">
        <img src={`${import.meta.env.BASE_URL}avatars/default-${avatar()}.webp`} alt="Agent face" />
        <strong>{name().trim()}</strong>
        <p title={purpose()}>{purpose()}</p>
        <button type="button" class="setup-outline" disabled={!!creating()} onClick={() => {
          change(); setAvatar((old) => ((old - 1 + 1 + Math.floor(Math.random() * 9)) % 10) + 1);
        }}>Shuffle face</button>
      </div>
      <div class="setup-fields">
        <label>Name<input aria-required="true" maxlength={60} value={name()} disabled={!!creating()} onInput={(event) => { change(); setName(event.currentTarget.value); }} /></label>
        <div>
          <label>Purpose<input maxlength={280} value={purpose()} placeholder="Plan trips, compare options, or help with everyday work." disabled={!!creating()}
            onInput={(event) => { change(); setPurpose(event.currentTarget.value); }} /></label>
          <div class="setup-suggestions" role="group" aria-label="Purpose suggestions"><For each={suggestions}>{([title, text]) =>
            <button type="button" class="setup-outline" aria-pressed={purpose() === text} disabled={!!creating()} onClick={() => { change(); setPurpose(text); }}>{title}</button>
          }</For></div>
        </div>
        <ManagedModelPicker local models={props.models} selected={model()} unavailable={retry()?.model} disabled={!!creating()} onAccessChanged={props.onAccessChanged}
          onSelect={(value) => { change(); setSelected(value); }} />
      </div>
    </div>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <Show when={creating()}>{(draft) => <AgentCraftingScreen name={draft().name} face={draft().avatar} doneAt={doneAt()} />}</Show>
    <button class="setup-primary" type="submit" disabled={(!retry() && !model()) || !!creating()}>{retry() ? "Retry" : "Create agent"}</button>
  </form>;
}
