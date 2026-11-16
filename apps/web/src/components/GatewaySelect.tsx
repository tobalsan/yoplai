import { For, Show } from "solid-js";

/** The explicit gateway choice of a global page. It shows when a gateway is configured or already chosen. */
export function GatewaySelect(props: { value: string | undefined; names: string[]; onChange: (name: string | undefined) => void }) {
  return (
    <Show when={props.names.length > 0 || props.value !== undefined}>
      <label class="gateway-select">Gateway{" "}
        <select aria-label="Gateway" value={props.value ?? ""} onChange={(event) => props.onChange(event.currentTarget.value || undefined)}>
          <option value="">This computer</option>
          <For each={props.names}>{(name) => <option value={name}>{name}</option>}</For>
        </select>
      </label>
    </Show>
  );
}
