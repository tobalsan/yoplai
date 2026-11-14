import { createEffect, createResource, createSignal, on, onCleanup, onMount, Show } from "solid-js";
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
 * It shows a mode only after the gateway confirmed it. `refreshKey` changes when the page
 * gets a new approval request. The control then reads the settings again.
 */
export function DeviceSettingsControl(props: {
  agentId: string;
  gateway: string;
  sessionId: string | null | undefined;
  refreshKey: number;
}) {
  const [open, setOpen] = createSignal(false);
  const [settings, setSettings] = createSignal<DeviceSettings>();
  const [readFailed, setReadFailed] = createSignal(false);
  const [folder, setFolder] = createSignal("");
  const [error, setError] = createSignal("");
  const [links, { refetch: refetchLinks }] = createResource(() => fetchDeviceLinks().catch(() => null));
  const [fullBackground, { mutate: setFullBackground }] = createResource(
    () => props.agentId,
    (agentId) => fetchFullBackground(agentId).catch(() => undefined)
  );
  let root: HTMLDivElement | undefined;
  // One counter for reads and writes. A response applies only if no newer request started after it.
  let requestCount = 0;

  const link = () => links.latest?.find((item) => item.name === props.gateway);
  const linkUnknown = () => !links.loading && link() === undefined;
  const offline = () => link()?.connected === false;
  const ready = () => typeof props.sessionId === "string" && props.sessionId !== "";
  const confirmed = () => ready() && settings() !== undefined;
  const label = () => {
    if (offline()) return "Device: offline";
    if (linkUnknown()) return "Device: unknown";
    if (readFailed()) return "Device: error";
    const current = settings();
    return current ? `Device: ${MODE_LABELS[current.mode]}` : "Device: …";
  };

  const apply = (next: DeviceSettings) => {
    setSettings(next);
    setReadFailed(false);
    setFolder(next.workspaceFolder ?? "");
  };

  const sameScope = (agentId: string, sessionId: string) => agentId === props.agentId && sessionId === props.sessionId;

  const read = () => {
    const agentId = props.agentId;
    const sessionId = props.sessionId;
    if (!sessionId) return;
    const thisRequest = ++requestCount;
    const current = () => thisRequest === requestCount && sameScope(agentId, sessionId);
    fetchDeviceSettings(agentId, sessionId).then(
      (next) => {
        if (current()) apply(next);
      },
      () => {
        // The mode is unknown until a read succeeds.
        if (!current()) return;
        setSettings(undefined);
        setReadFailed(true);
      }
    );
  };

  createEffect(
    on(
      () => [props.agentId, props.sessionId] as const,
      () => {
        requestCount++;
        setSettings(undefined);
        setReadFailed(false);
        setFolder("");
        setError("");
        read();
      }
    )
  );
  createEffect(on(() => props.refreshKey, read, { defer: true }));

  onMount(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => {
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", onVisible);
    });
  });

  createEffect(() => {
    if (!open()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: Event) => {
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    });
  });

  const change = async (body: { workspaceFolder?: string | null; full?: boolean }) => {
    const agentId = props.agentId;
    const sessionId = props.sessionId;
    if (!sessionId) return;
    const thisRequest = ++requestCount;
    setError("");
    try {
      const next = await saveDeviceSettings(agentId, sessionId, body);
      if (thisRequest === requestCount && sameScope(agentId, sessionId)) apply(next);
    } catch (e) {
      if (thisRequest === requestCount && sameScope(agentId, sessionId)) {
        setError(e instanceof Error ? e.message : "The settings did not save.");
      }
    }
    // A read that started during the write is now out of date. Read one time again.
    if (sameScope(agentId, sessionId)) read();
  };

  const changeFullBackground = async (value: boolean) => {
    const agentId = props.agentId;
    setError("");
    try {
      const next = await saveFullBackground(agentId, value);
      if (agentId === props.agentId) setFullBackground(next);
    } catch (e) {
      if (agentId === props.agentId) setError(e instanceof Error ? e.message : "The settings did not save.");
    }
  };

  const toggle = () => {
    if (!open()) {
      void refetchLinks();
      read();
    }
    setOpen(!open());
  };

  return (
    <div class="device-control" ref={root}>
      <button
        type="button"
        class="device-control-button"
        classList={{ warning: settings()?.mode === "full" && !offline() }}
        aria-expanded={open()}
        title="Device access of this chat"
        onClick={toggle}
      >
        {label()}
      </button>
      <Show when={open()}>
        <div role="group" aria-label="Device access" class="device-panel">
          <strong>Device access</strong>
          <Show when={offline()}>
            <p>The remote agent cannot reach this device now.</p>
          </Show>
          <Show when={linkUnknown()}>
            <p>The page cannot read the state of this device link.</p>
          </Show>
          <Show when={!ready()}>
            <p>Send a first message, then set the folder.</p>
          </Show>
          <Show when={readFailed()}>
            <p role="alert">The device settings did not load.</p>
            <button type="button" class="device-button" onClick={read}>
              Try again
            </button>
          </Show>
          <label class="device-field">
            Workspace folder
            <input
              type="text"
              value={folder()}
              disabled={!confirmed()}
              onInput={(e) => setFolder(e.currentTarget.value)}
              placeholder="/Users/you/project"
            />
          </label>
          <p class="device-help">File writes in this folder pass with no prompt.</p>
          <div class="device-actions">
            <button type="button" class="device-button primary" disabled={!confirmed() || folder().trim() === ""} onClick={() => void change({ workspaceFolder: folder().trim() })}>
              Save
            </button>
            <button type="button" class="device-button" disabled={!confirmed() || !settings()?.workspaceFolder} onClick={() => void change({ workspaceFolder: null })}>
              Remove
            </button>
          </div>
          <label class="device-switch-row">
            <input
              type="checkbox"
              role="switch"
              class="device-switch"
              checked={settings()?.full ?? false}
              disabled={!confirmed()}
              onChange={(e) => void change({ full: e.currentTarget.checked })}
            />
            Full access
          </label>
          <p class="device-help warning">Each call then passes with no prompt, also commands.</p>
          <strong>Scheduled jobs</strong>
          <label class="device-switch-row">
            <input
              type="checkbox"
              role="switch"
              class="device-switch"
              checked={fullBackground() ?? false}
              disabled={fullBackground() === undefined}
              onChange={(e) => void changeFullBackground(e.currentTarget.checked)}
            />
            Scheduled jobs of this agent get full access on this device
          </label>
          <p class="device-help">Without it, a job that needs approval gets a refusal.</p>
          <Show when={error()}>
            <p role="alert" class="device-error">{error()}</p>
          </Show>
        </div>
      </Show>
    </div>
  );
}
