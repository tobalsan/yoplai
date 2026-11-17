import { Show } from "solid-js";

export function RemoteAgentMark(props: { gateway?: string }) {
  return (
    <Show when={props.gateway}>
      <span
        title={`Remote agent on ${props.gateway}`}
        style={{ "font-size": "10px", opacity: 0.7, "white-space": "nowrap", "margin-left": "6px", "font-weight": "400" }}
      >
        @{props.gateway}
      </span>
    </Show>
  );
}
