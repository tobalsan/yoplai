import { createEffect, createResource, createSignal, on, Show } from "solid-js";
import {
  fetchDeviceLinks,
  fetchDeviceSettings,
  fetchFullBackground,
  saveDeviceSettings,
  saveFullBackground,
  type DeviceMode,
  type DeviceSettings,
} from "../../api/device";

const MODE_LABELS: Record<DeviceMode, string> = { ask: "Ask", workspace: "Workspace", full: "Full" };

/**
 * Header control for a chat with a remote agent. It shows the device mode of the chat
 * and opens a panel for the workspace folder, the Full switch, and the scheduled jobs.
 */
export function DeviceSettingsControl(props: { agentId: string; gateway: string; sessionId: string | null | undefined }) {
  const [open, setOpen] = createSignal(false);
  const [settings, setSettings] = createSignal<DeviceSettings>();
  const [folder, setFolder] = createSignal("");
  const [error, setError] = createSignal("");
  const [links, { refetch: refetchLinks }] = createResource(() => fetchDeviceLinks().catch(() => []));
  const [fullBackground, { mutate: setFullBackground }] = createResource(
    () => props.agentId,
    (agentId) => fetchFullBackground(agentId).catch(() => undefined)
  );

  const online = () => links()?.find((link) => link.name === props.gateway)?.connected ?? true;
  const mode = (): DeviceMode => settings()?.mode ?? "ask";
  const ready = () => typeof props.sessionId === "string" && props.sessionId !== "";

  const apply = (next: DeviceSettings) => {
    setSettings(next);
    setFolder(next.workspaceFolder ?? "");
  };

  createEffect(
    on(
      () => [props.agentId, props.sessionId] as const,
      ([agentId, sessionId]) => {
        setSettings(undefined);
        setFolder("");
        setError("");
        if (!sessionId) return;
        fetchDeviceSettings(agentId, sessionId).then(
          (next) => {
            if (agentId === props.agentId && sessionId === props.sessionId) apply(next);
          },
          () => undefined
        );
      }
    )
  );

  const change = async (body: { workspaceFolder?: string | null; full?: boolean }) => {
    const sessionId = props.sessionId;
    if (!sessionId) return;
    setError("");
    try {
      apply(await saveDeviceSettings(props.agentId, sessionId, body));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The settings did not save.");
    }
  };

  const changeFullBackground = async (value: boolean) => {
    setError("");
    try {
      setFullBackground(await saveFullBackground(props.agentId, value));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The settings did not save.");
    }
  };

  const toggle = () => {
    if (!open()) void refetchLinks();
    setOpen(!open());
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        aria-expanded={open()}
        title="Device access of this chat"
        onClick={toggle}
        style={mode() === "full" && online() ? { color: "#b45309", "border-color": "#f59e0b", "font-weight": "600" } : {}}
      >
        {online() ? MODE_LABELS[mode()] : "Device offline"}
      </button>
      <Show when={open()}>
        <div
          role="group"
          aria-label="Device access"
          style={{ position: "absolute", right: 0, top: "100%", "z-index": 20, width: "320px", padding: "12px", background: "var(--bg-surface)", border: "1px solid var(--surface-2)", "border-radius": "8px", display: "flex", "flex-direction": "column", gap: "10px" }}
        >
          <Show when={!online()}>
            <p>The remote agent cannot reach this device now.</p>
          </Show>
          <Show when={!ready()}>
            <p>Send a first message, then set the folder.</p>
          </Show>
          <label>
            Workspace folder
            <input
              type="text"
              value={folder()}
              disabled={!ready()}
              onInput={(e) => setFolder(e.currentTarget.value)}
              placeholder="/Users/you/project"
              style={{ width: "100%" }}
            />
          </label>
          <p style={{ margin: 0, "font-size": "12px", opacity: 0.7 }}>File writes in this folder pass with no prompt.</p>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" disabled={!ready() || folder().trim() === ""} onClick={() => void change({ workspaceFolder: folder().trim() })}>
              Save
            </button>
            <button type="button" disabled={!ready() || !settings()?.workspaceFolder} onClick={() => void change({ workspaceFolder: null })}>
              Remove
            </button>
          </div>
          <label>
            <input
              type="checkbox"
              role="switch"
              checked={settings()?.full ?? false}
              disabled={!ready()}
              onChange={(e) => void change({ full: e.currentTarget.checked })}
            />{" "}
            Full access
          </label>
          <p style={{ margin: 0, "font-size": "12px", color: "#b45309" }}>
            Each call then passes with no prompt, also commands.
          </p>
          <strong>Scheduled jobs</strong>
          <label>
            <input
              type="checkbox"
              role="switch"
              checked={fullBackground() ?? false}
              disabled={fullBackground() === undefined}
              onChange={(e) => void changeFullBackground(e.currentTarget.checked)}
            />{" "}
            Scheduled jobs of this agent get full access on this device
          </label>
          <p style={{ margin: 0, "font-size": "12px", opacity: 0.7 }}>
            Without it, a scheduled job gets a refusal for each call that needs approval, because nobody can answer.
          </p>
          <Show when={error()}>
            <p role="alert" style={{ margin: 0, color: "#b91c1c" }}>{error()}</p>
          </Show>
        </div>
      </Show>
    </div>
  );
}
