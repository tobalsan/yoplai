import { For, Show, createMemo, createSignal, createUniqueId, type JSX } from "solid-js";
import type { ModelSource } from "@yoplai/shared/types";
import { SearchPicker } from "../components/SearchPicker";
import { modelKey, type Access, type Model } from "./api";
import { ModelSourceIcon } from "./ModelSourceIcon";
import "./ModelPicker.css";

const rail = [
  { group: "Yoplai", ids: ["chatgpt", "claude", "keys"] },
  { group: "Device", ids: ["pi", "codex", "claude-code", "opencode"] },
  { group: "", ids: ["environment"] },
] as const;
type Tab = typeof rail[number]["ids"][number];
const labels: Record<Tab, string> = {
  chatgpt: "ChatGPT", claude: "Claude", keys: "API keys", pi: "Pi CLI",
  codex: "Codex CLI", "claude-code": "Claude Code", opencode: "OpenCode CLI", environment: "Environment",
};
const brands = new Map(Object.entries({
  openai: "OpenAI", "openai-codex": "ChatGPT", openrouter: "OpenRouter", anthropic: "Anthropic",
  google: "Google", "google-vertex": "Google", deepseek: "DeepSeek", xai: "xAI", zai: "Z.ai",
  opencode: "OpenCode", "opencode-go": "OpenCode", "github-copilot": "GitHub Copilot", "amazon-bedrock": "Amazon Bedrock",
}));
const family = (id: string) => brands.get(id) ?? id.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const searchText = (model: Model) => normalize(`${family(model.provider)} ${model.provider} ${model.name} ${model.model}`);
const matchesSearch = (text: string, tokens: string[]) => tokens.every((token) => text.includes(token) || text.replaceAll(" ", "").includes(token));

function tabFor(provider: string, source: ModelSource, credentialType: Model["credentialType"]): Tab {
  if (source !== "owned") return source;
  if (credentialType === "oauth" && provider === "openai-codex") return "chatgpt";
  if (credentialType === "oauth" && provider === "anthropic") return "claude";
  return "keys";
}

function displayName(model: Model) {
  const name = model.free ? model.name.replace(/\s+\(free\)$/i, "") : model.name;
  const prefix = `${family(model.provider)}: `;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function accountType(model: Model) {
  if (model.credentialType === "api_key") return "API key";
  if (model.source === "owned") return "Subscription";
  return `${model.provider === "anthropic" ? "Claude" : family(model.provider)} subscription`;
}

function ModelSummary(props: { name: string; detail?: string; tab?: Tab; model?: Model }) {
  return <>
    <Show when={props.tab}>{(tab) => <ModelSourceIcon source={tab()} />}</Show>
    <span class="model-picker-name" title={props.name}>
      <strong>{props.name}</strong>
      <Show when={props.detail}><small>{props.detail}</small></Show>
    </span>
    <Show when={props.model?.free}><span class="model-picker-tag">Free</span></Show>
    <Show when={props.model?.ready}><span class="model-picker-ready" role="img" aria-label="Ready" title="Ready" /></Show>
  </>;
}

type AccessActions = {
  data: Access;
  open: (addKey?: boolean) => void;
  signOut: (provider: string) => Promise<void>;
};

export function ModelPicker(props: {
  label?: string;
  models: Model[];
  selected?: Model;
  unavailable?: { model: string; source?: ModelSource };
  disabled: boolean;
  access?: AccessActions;
  onSelect: (value: string) => void;
}) {
  const id = createUniqueId();
  const [requestedTab, setRequestedTab] = createSignal<Tab>();
  const [error, setError] = createSignal("");
  const [signingOut, setSigningOut] = createSignal(false);
  const selectedTab = () => props.selected && tabFor(props.selected.provider, props.selected.source, props.selected.credentialType);
  const catalog = createMemo(() => props.models.map((model) => ({
    model, tab: tabFor(model.provider, model.source, model.credentialType),
    text: searchText(model),
  })));
  const owned = (tab: Tab) => props.access?.data.owned.filter(({ providerId, type }) =>
    tabFor(providerId, "owned", type === "oauth" ? "oauth" : "api_key") === tab) ?? [];
  const status = (tab?: Tab) => props.access?.data.external.find((item) => item.source === tab && item.detected && item.enabled);
  const tabs = createMemo(() => rail.flatMap(({ ids }) => [...ids]).filter((tab) =>
    catalog().some((row) => row.tab === tab) || owned(tab).length > 0 || status(tab)));
  const tab = createMemo(() => {
    const requested = requestedTab();
    return requested && tabs().includes(requested) ? requested : tabs()[0];
  });
  const tabModels = createMemo(() => catalog().filter((row) => row.tab === tab()));
  const detail = () => {
    const current = tab();
    if (current === "chatgpt" || current === "claude") return props.access ? "Subscription · signed in with Yoplai" : "Subscription";
    if (current === "keys" && props.access) {
      const count = owned("keys").filter(({ type }) => type === "api_key").length;
      if (count) return `${count} ${count === 1 ? "key" : "keys"} · added in Yoplai`;
    }
    const types = [...new Set(tabModels().map(({ model }) => accountType(model)))];
    const meta = status(current);
    return [meta?.version, meta?.path].filter(Boolean).join(" · ") || types.join(" · ");
  };
  const selectedDetail = () => {
    const model = props.selected;
    const current = selectedTab();
    if (model && current) return `${current === "keys" ? family(model.provider) : labels[current]} · ${accountType(model)}`;
    const source = props.unavailable?.source;
    return source ? `${source === "owned" ? "Yoplai" : labels[source]} · Unavailable` : "Source not set";
  };
  const name = () => props.selected ? displayName(props.selected) : props.unavailable?.model;
  const summaryTab = () => selectedTab() ?? (props.unavailable?.source === "owned" ? "keys" : props.unavailable?.source);
  const openTab = () => {
    setError("");
    setRequestedTab(selectedTab() ?? summaryTab());
  };
  const signOut = async (provider: string) => {
    if (signingOut() || !props.access) return;
    setSigningOut(true);
    setError("");
    try { await props.access.signOut(provider); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-out failed. Try again."); }
    finally { setSigningOut(false); }
  };
  const selectTab = (value: Tab, reset: () => void) => {
    setRequestedTab(value);
    reset();
  };
  const tabKey = (event: KeyboardEvent, value: Tab, reset: () => void) => {
    const items = tabs();
    const index = items.indexOf(value);
    const next = event.key === "Home" ? items[0] : event.key === "End" ? items.at(-1)
      : event.key === "ArrowDown" ? items[(index + 1) % items.length]
      : event.key === "ArrowUp" ? items[(index - 1 + items.length) % items.length] : undefined;
    if (!next) return;
    event.preventDefault();
    selectTab(next, reset);
    document.getElementById(`${id}-${next}`)?.focus();
  };
  const renderPanel = ({ search, results, reset, close }: { search: JSX.Element; results: JSX.Element; reset: () => void; close: () => void }) => <>
    <div class="model-picker-rail">
      <div role="tablist" aria-label="Model sources" aria-orientation="vertical">
        <For each={rail}>{({ group, ids }) => <Show when={ids.some((source) => tabs().includes(source))}>
          <div class="model-picker-rail-group" role={group ? "group" : "presentation"} aria-label={group || undefined}>
            <Show when={group}><span aria-hidden="true">{group}</span></Show>
            <For each={ids.filter((source) => tabs().includes(source))}>{(source) => <button type="button" role="tab" id={`${id}-${source}`}
              title={status(source)?.warningRequired ? `${labels[source]} · Anthropic terms` : labels[source]} aria-label={labels[source]}
              aria-selected={tab() === source} aria-controls={`${id}-models`} tabindex={tab() === source ? 0 : -1}
              onClick={() => selectTab(source, reset)} onKeyDown={(event) => tabKey(event, source, reset)}>
              <ModelSourceIcon source={source} />
              <Show when={status(source)?.warningRequired}><span class="model-picker-warning-dot" /></Show>
            </button>}</For>
          </div>
        </Show>}</For>
      </div>
      <Show when={props.access}><button type="button" class="model-picker-add" title="Add model access" aria-label="Add model access" onClick={() => { close(); props.access?.open(); }}>
        <i class="fa-solid fa-plus" aria-hidden="true" />
      </button></Show>
    </div>
    <div class="model-picker-pane" id={`${id}-models`} role={tab() ? "tabpanel" : undefined} aria-labelledby={tab() ? `${id}-${tab()}` : undefined}>
      <Show when={tab()}>{(current) => <>
        <header class="model-picker-header">
          <div>
            <div class="model-picker-heading"><strong>{labels[current()]}</strong>
              <Show when={current() === "claude"}><span class="model-picker-tag">Experimental</span></Show>
              <Show when={status(current())?.warningRequired}><span class="model-picker-tag">Anthropic terms</span></Show>
            </div>
            <Show when={detail()}><small>{detail()}</small></Show>
          </div>
          <Show when={current() === "chatgpt" || current() === "claude" ? owned(current())[0] : undefined}>{(credential) =>
            <button type="button" disabled={signingOut()} onClick={() => void signOut(credential().providerId)}>Sign out</button>
          }</Show>
          <Show when={current() === "keys" && props.access}><button type="button" onClick={() => { close(); props.access?.open(true); }}>Add a key</button></Show>
        </header>
      </>}</Show>
      <Show when={error()}><p class="model-picker-error" role="alert">{error()}</p></Show>
      {search}
      {results}
    </div>
  </>;

  return <SearchPicker label={props.label ?? "Model"} searchLabel="Search models" placeholder="Select a model" disabled={props.disabled}
    selected={props.selected && modelKey(props.selected)} selectionLabel={name() ? `${name()}, ${selectedDetail()}` : undefined}
    summary={name() ? <ModelSummary name={name()!} detail={selectedDetail()} tab={summaryTab()} model={props.selected} /> : undefined}
    onOpen={openTab} onSelect={props.onSelect} panel={{ minWidth: 380, class: "model-picker-panel", layout: renderPanel }}
    groups={(query) => {
      const tokens = normalize(query).split(" ").filter(Boolean);
      const visible = tabModels().filter((entry) => matchesSearch(entry.text, tokens));
      const byProvider = tab() === "keys" || new Set(tabModels().map(({ model }) => model.provider)).size > 1;
      const groups = new Map<string, Model[]>();
      for (const { model } of visible) {
        const provider = byProvider ? model.provider : "";
        const rows = groups.get(provider) ?? [];
        rows.push(model);
        groups.set(provider, rows);
      }
      return [...groups].map(([provider, models]) => ({
        id: provider, label: provider ? family(provider) : undefined,
        rows: models.map((model) => ({ id: modelKey(model), value: modelKey(model), content: <ModelSummary name={displayName(model)} model={model} /> })),
      }));
    }} />;
}
