import { For, Show, type JSX } from "solid-js";
import type { WsDeviceApprovalRequest } from "@yoplai/shared";
import type { DeviceApprovalItem } from "./createChatSession";

type ApprovalArguments = { command?: unknown; path?: unknown; content?: unknown; edits?: unknown };

// Control characters (but not new line and tab), format, surrogate, private, unassigned, and line separator characters,
// default-ignorable characters (variation selectors, tag characters, U+034F, U+2061), and the backslash.
const HIDDEN = /(?![\n\t])[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\\]/gu;
const CUT_MARK = "… (cut)";

/** The agent selects these texts. Each hidden character shows as an escape such as \u202E. A backslash shows as two. */
function escapeHidden(value: string): string {
  return value.replace(HIDDEN, (char) => {
    if (char === "\\") return "\\\\";
    const code = (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    return code.length > 4 ? `\\u{${code}}` : `\\u${code}`;
  });
}

function text(value: unknown): string {
  if (typeof value === "string") return escapeHidden(value);
  try {
    return escapeHidden(JSON.stringify(value, null, 2) ?? "");
  } catch {
    return escapeHidden(String(value));
  }
}

const ACTIONS: Record<string, string> = {
  device_bash: "run a command",
  device_write: "write a file",
  device_edit: "edit a file",
  device_read: "read a file",
};

function title(request: WsDeviceApprovalRequest): string {
  return `A remote agent wants to ${ACTIONS[request.tool] ?? "use a tool"} on this device`;
}

function argumentsOf(request: WsDeviceApprovalRequest): ApprovalArguments {
  return request.arguments && typeof request.arguments === "object" ? (request.arguments as ApprovalArguments) : {};
}

function isCutCommand(request: WsDeviceApprovalRequest): boolean {
  return request.tool === "device_bash" && text(argumentsOf(request).command).includes(CUT_MARK);
}

function Block(props: { label: string; value: unknown; limited: boolean }): JSX.Element {
  const shown = () => text(props.value);
  return (
    <div class="device-approval-block">
      <div class="device-approval-label">{props.label}</div>
      <pre class="device-approval-text">{shown()}</pre>
      <Show when={props.limited && shown().includes(CUT_MARK)}>
        <p class="device-approval-warning">This card does not show all of the text. The call uses the full text.</p>
      </Show>
    </div>
  );
}

function Detail(props: { request: WsDeviceApprovalRequest }): JSX.Element {
  const args = () => argumentsOf(props.request);
  return (
    <Show when={props.request.tool !== "device_bash"} fallback={<Block label="Command" value={args().command} limited={false} />}>
      <Block label="Path" value={args().path} limited={true} />
      <Show when={args().content !== undefined}>
        <Block label="Content" value={args().content} limited={true} />
      </Show>
      <Show when={args().edits !== undefined}>
        <Block label="Edits" value={args().edits} limited={true} />
      </Show>
    </Show>
  );
}

/** Shows each device call of the open chat that waits for the user. Arguments show as escaped text. */
export function DeviceApprovalCards(props: {
  agentName: string;
  items: DeviceApprovalItem[];
  connectionLost: boolean;
  onAnswer: (approvalId: string, approve: boolean) => void;
}) {
  return (
    <For each={props.items}>
      {(item) => (
        <Show when={item.state !== "timeout"} fallback={<p role="status" class="device-approval-timeout">A device call got no answer in time.</p>}>
          <section class="device-approval" aria-label={title(item.request)}>
            <strong>{title(item.request)}</strong>
            <div class="device-approval-agent">
              Agent: <span>{escapeHidden(props.agentName)}</span>
            </div>
            <Detail request={item.request} />
            <Show when={isCutCommand(item.request)}>
              <p class="device-approval-warning">This command is longer than the card shows. If you approve, the full command runs.</p>
            </Show>
            <Show when={props.connectionLost}>
              <p class="device-approval-warning">The connection is lost. You cannot answer until it returns.</p>
            </Show>
            <div class="device-approval-actions">
              <button
                type="button"
                class="device-button primary"
                disabled={item.state === "answered" || props.connectionLost}
                onClick={() => props.onAnswer(item.request.approvalId, true)}
              >
                Approve
              </button>
              <button
                type="button"
                class="device-button"
                disabled={item.state === "answered" || props.connectionLost}
                onClick={() => props.onAnswer(item.request.approvalId, false)}
              >
                Refuse
              </button>
            </div>
          </section>
        </Show>
      )}
    </For>
  );
}
