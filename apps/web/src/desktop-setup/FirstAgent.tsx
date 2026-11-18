import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { errorText, modelKey, request, type Model } from "./api";

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

type Draft = { requestId: string; name: string; purpose: string; avatar: number; model: { provider: string; model: string } };

export function FirstAgent(props: { models: Model[]; onCreated: (id: string) => Promise<void>; onBusy: (busy: boolean) => void }) {
  const [name, setName] = createSignal(randomName());
  const [purpose, setPurpose] = createSignal("");
  const [avatar, setAvatar] = createSignal(Math.floor(Math.random() * 10) + 1);
  const defaultModel = [...props.models].sort((a, b) => rank(a.source) - rank(b.source)).find((model) => model.default);
  const [selected, setSelected] = createSignal(defaultModel ? modelKey(defaultModel) : "");
  const [creating, setCreating] = createSignal("");
  const [error, setError] = createSignal("");
  const [retry, setRetry] = createSignal<Draft>();
  const model = createMemo(() => props.models.find((row) => modelKey(row) === selected()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const change = () => { setRetry(undefined); setError(""); };
  const create = async (draft: Draft) => {
    if (creating()) return;
    props.onBusy(true);
    setError("");
    setRetry(undefined);
    setCreating("Creating your agent…");
    timer = setTimeout(() => setCreating("Writing its instructions…"), 650);
    try {
      const result = await request<{ id: string }>("agents", "POST", draft);
      await props.onCreated(result.id);
    } catch (cause) {
      setError(errorText(cause));
      setRetry(draft);
    } finally {
      clearTimeout(timer);
      setCreating("");
      props.onBusy(false);
    }
  };
  return <form onSubmit={(event) => {
    event.preventDefault();
    const option = model();
    if (!option) return;
    if (retry()) { void create(retry()!); return; }
    const chosenName = name().trim() || randomName();
    setName(chosenName);
    void create({ requestId: crypto.randomUUID(), name: chosenName, purpose: purpose(), avatar: avatar(), model: { provider: option.provider, model: option.model } });
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
        <label>Model<select required value={selected()} disabled={!!creating()} onChange={(event) => { change(); setSelected(event.currentTarget.value); }}>
          <Show when={!defaultModel}><option value="">Select a model</option></Show>
          <For each={props.models}>{(option) => <option value={modelKey(option)} selected={selected() === modelKey(option)}>{option.name}{option.ready ? "     ● Ready" : ""}</option>}</For>
        </select></label>
      </div>
    </div>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <Show when={creating()}><p role="status">{creating()}</p></Show>
    <button class="setup-primary" type="submit" disabled={!model() || !!creating()}>{retry() ? "Retry" : "Create agent"}</button>
  </form>;
}
