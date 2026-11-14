import { For, Show, type JSX } from "solid-js";
import type { WsDeviceApprovalRequest } from "@yoplai/shared";
import type { DeviceApprovalItem } from "./createChatSession";

type ApprovalArguments = { command?: unknown; path?: unknown; content?: unknown; edits?: unknown };

function text(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

const ACTIONS: Record<string, string> = {
  device_bash: "run a command",
  device_write: "write a file",
  device_edit: "edit a file",
  device_read: "read a file",
};

function title(request: WsDeviceApprovalRequest, agentName: string): string {
  return `${agentName} wants to ${ACTIONS[request.tool] ?? "use a tool"} on this device`;
}

function Detail(props: { request: WsDeviceApprovalRequest }): JSX.Element {
  const args = (): ApprovalArguments =>
    props.request.arguments && typeof props.request.arguments === "object" ? (props.request.arguments as ApprovalArguments) : {};
  const block = (label: string, value: unknown) => (
    <div>
      <div style={{ "font-size": "12px", opacity: 0.7 }}>{label}</div>
      <pre style={{ margin: "4px 0 0", "max-height": "200px", overflow: "auto", "white-space": "pre-wrap", "word-break": "break-all" }}>
        {text(value)}
      </pre>
    </div>
  );
  return (
    <Show
      when={props.request.tool !== "device_bash"}
      fallback={block("Command", args().command)}
    >
      {block("Path", args().path)}
      <Show when={args().content !== undefined}>{block("Content", args().content)}</Show>
      <Show when={args().edits !== undefined}>{block("Edits", args().edits)}</Show>
    </Show>
  );
}

/** Shows each device call of the open chat that waits for the user. Arguments show as text. */
export function DeviceApprovalCards(props: {
  agentName: string;
  items: DeviceApprovalItem[];
  onAnswer: (approvalId: string, approve: boolean) => void;
}) {
  return (
    <For each={props.items}>
      {(item) => (
        <Show
          when={item.state !== "timeout"}
          fallback={<p role="status">A device call got no answer in time.</p>}
        >
          <section
            aria-label={title(item.request, props.agentName)}
            style={{ border: "1px solid var(--accent)", "border-radius": "8px", padding: "12px", margin: "12px auto", "max-width": "var(--transcript-width, 720px)" }}
          >
            <strong>{title(item.request, props.agentName)}</strong>
            <Detail request={item.request} />
            <div style={{ display: "flex", gap: "8px", "margin-top": "8px" }}>
              <button type="button" disabled={item.state === "answered"} onClick={() => props.onAnswer(item.request.approvalId, true)}>
                Approve
              </button>
              <button type="button" disabled={item.state === "answered"} onClick={() => props.onAnswer(item.request.approvalId, false)}>
                Refuse
              </button>
            </div>
          </section>
        </Show>
      )}
    </For>
  );
}
