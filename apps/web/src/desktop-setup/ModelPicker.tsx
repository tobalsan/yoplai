import { Show, createMemo } from "solid-js";
import { SearchPicker, type PickerRow } from "../components/SearchPicker";
import { modelKey, type Model } from "./api";

const brands = new Map(Object.entries({
  openai: "OpenAI", "openai-codex": "OpenAI", openrouter: "OpenRouter", anthropic: "Anthropic",
  google: "Google", "google-vertex": "Google", deepseek: "DeepSeek", xai: "xAI", zai: "Z.ai",
  opencode: "OpenCode", "opencode-go": "OpenCode", "github-copilot": "GitHub Copilot", "amazon-bedrock": "Amazon Bedrock",
}));
const family = (id: string) => brands.get(id) ?? id.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const displayName = (model: Model) => {
  const name = model.free ? model.name.replace(/\s+\(free\)$/i, "") : model.name;
  const prefix = `${family(model.provider)}: `;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
};

function ModelSummary(props: { model: Model; provider?: boolean }) {
  return <>
    <span class="setup-picker-name" title={displayName(props.model)}>
      <strong>{displayName(props.model)}</strong>
      <Show when={props.provider}><small>{family(props.model.provider)}</small></Show>
    </span>
    <Show when={props.model.free}><span class="setup-picker-free">Free</span></Show>
    <Show when={props.model.ready}><span class="setup-picker-ready" role="img" aria-label="Ready" title="Ready" /></Show>
  </>;
}

export function ModelPicker(props: { label?: string; models: Model[]; selected?: Model; suggested?: Model; grouped?: boolean; disabled: boolean; onSelect: (value: string) => void }) {
  const catalog = createMemo(() => props.models.map((model) => ({
    model, family: family(model.provider), text: normalize(`${family(model.provider)} ${model.provider} ${model.name} ${model.model}`),
  })));
  const suggested = createMemo(() => [
    ...(props.suggested ? [props.suggested] : []),
    ...props.models.filter((model) => model.ready && model !== props.suggested),
  ].slice(0, 5));
  const row = (model: Model, group: string, showProvider = false): PickerRow => ({
    id: JSON.stringify([group, modelKey(model)]), value: modelKey(model), content: <ModelSummary model={model} provider={showProvider} />,
  });
  return <SearchPicker label={props.label ?? "Model"} searchLabel="Search models" placeholder="Select a model" disabled={props.disabled}
    selected={props.selected && modelKey(props.selected)}
    selectionLabel={props.selected && [displayName(props.selected), family(props.selected.provider),
      props.selected.free && "Free", props.selected.ready && "Ready"].filter(Boolean).join(" ")}
    summary={<Show when={props.selected}>{(model) => <ModelSummary model={model()} provider />}</Show>}
    onSelect={props.onSelect}
    groups={(query, expanded) => {
      const tokens = normalize(query).split(" ").filter(Boolean);
      const searching = !!query.trim();
      const families = new Map<string, Model[]>();
      for (const entry of catalog()) {
        if (!tokens.every((token) => entry.text.includes(token) || entry.text.replaceAll(" ", "").includes(token))) continue;
        const models = families.get(entry.family) ?? [];
        models.push(entry.model);
        families.set(entry.family, models);
      }
      const groups = [...families.entries()].sort(([a], [b]) => a.localeCompare(b));
      return [
        ...(!props.grouped && !searching && suggested().length ? [{ id: "suggested", label: "Suggested", rows: suggested().map((model) => row(model, "suggested", true)) }] : []),
        ...groups.map(([name, models]) => searching || props.grouped ? { id: name, label: name, rows: models.map((model) => row(model, name)) } : {
          id: name,
          rows: [{
            id: name, expand: name,
            content: <>
              <i class={`fa-solid fa-chevron-${expanded === name ? "down" : "right"} search-picker-chevron`} aria-hidden="true" />
              <span class="setup-picker-name">{name}</span>
              <span class="setup-picker-count" aria-label={`${models.length} models`}>{models.length}</span>
              <span class="setup-picker-action">{expanded === name ? "Collapse" : "Expand"}</span>
            </>,
          }, ...(expanded === name ? models.map((model) => row(model, name)) : [])],
        }),
      ];
    }} />;
}
