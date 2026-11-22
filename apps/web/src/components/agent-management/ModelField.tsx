import { createMemo } from "solid-js";
import type { ThinkLevel } from "@yoplai/shared/types";
import { modelKey, type Model } from "../../desktop-setup/api";
import { ModelPicker } from "../../desktop-setup/ModelPicker";
import type { ModelChoice } from "../../api/agent-management";
import { SearchPicker } from "../SearchPicker";

export function ModelField(props: {
  label?: string;
  models: Model[];
  value?: { provider?: string; model: string };
  disabled?: boolean;
  onChange: (choice: ModelChoice) => void;
}) {
  const index = createMemo(() => new Map(props.models.map((model) => [modelKey(model), model])));
  const selected = createMemo(() => {
    const value = props.value;
    if (!value) return undefined;
    const choice = { provider: value.provider ?? "", model: value.model };
    return index().get(modelKey(choice)) ?? { ...choice, name: value.model, ready: false, source: "", default: false, free: false };
  });
  return <ModelPicker grouped label={props.label} models={props.models} selected={selected()} disabled={props.disabled === true}
    onSelect={(key) => { const model = index().get(key); if (model) props.onChange({ provider: model.provider, model: model.model }); }} />;
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
