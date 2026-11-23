import { createMemo } from "solid-js";
import type { ModelSource, ThinkLevel } from "@yoplai/shared/types";
import { modelKey, resolveModelChoice, type Model } from "../../desktop-setup/api";
import { ManagedModelPicker } from "../../desktop-setup/ManagedModelPicker";
import type { ModelChoice } from "../../api/agent-management";
import type { Agent } from "../../api/types";
import { SearchPicker } from "../SearchPicker";

export function ModelField(props: {
  label?: string;
  models: Model[];
  value?: { provider?: string; model: string; source?: ModelSource };
  authMode?: Agent["authMode"];
  disabled?: boolean;
  local?: boolean;
  onAccessChanged?: () => unknown;
  onChange: (choice: ModelChoice) => void;
}) {
  const index = createMemo(() => new Map(props.models.map((model) => [modelKey(model), model])));
  const selected = createMemo(() => props.value && resolveModelChoice(props.models, props.value, props.authMode));
  return <ManagedModelPicker label={props.label} models={props.models} selected={selected()} unavailable={props.value} disabled={props.disabled === true}
    local={props.local} onAccessChanged={props.onAccessChanged}
    onSelect={(key) => { const model = index().get(key); if (model) props.onChange({ provider: model.provider, model: model.model, source: model.source }); }} />;
}

const reasoning: ReadonlyArray<readonly [ThinkLevel | "", string]> = [
  ["", "Default"], ["off", "Off"], ["minimal", "Minimal"], ["low", "Low"], ["medium", "Medium"],
  ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"],
];

export function ReasoningField(props: { value: ThinkLevel | null; disabled?: boolean; onChange: (value: ThinkLevel | null) => void }) {
  const value = () => props.value ?? "";
  const label = () => reasoning.find(([key]) => key === value())?.[1] ?? "Default";
  return <SearchPicker label="Reasoning" searchLabel="Search reasoning levels" placeholder="Default" disabled={props.disabled}
    selected={value()} selectionLabel={label()} summary={<span>{label()}</span>}
    groups={(query) => [{
      id: "reasoning",
      rows: reasoning.filter(([, label]) => label.toLowerCase().includes(query.trim().toLowerCase()))
        .map(([key, label]) => ({ id: key || "default", value: key, content: label })),
    }]}
    onSelect={(key) => props.onChange(reasoning.find(([value]) => value === key)?.[0] || null)} />;
}
