import { A, useLocation } from "@solidjs/router";
import { Show, createEffect, createResource, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { fetchMainAgentOptions, fetchMainAgentPreference } from "../api/main-agent";
import { chatShare } from "../api/chat-shares";
import type { Agent } from "../api/types";
import { capabilities } from "../lib/capabilities";
import { showToast } from "../lib/toast";
import { MainAgentPicker } from "./MainAgentPicker";

export function ChatSettingsMenu(props: {
  agentId: string;
  settingsAgentId?: string | null;
  sessionId?: string | null;
  projectId?: string;
  onPick: (agentId: string) => void;
}) {
  const location = useLocation();
  const [open, setOpen] = createSignal(false);
  const [preference, { mutate: setPreference }] = createResource(() => !props.projectId && props.agentId, () => fetchMainAgentPreference().catch(() => null));
  const isMain = () => preference()?.accessible === true && preference()?.mainAgentId === props.agentId;
  const [agents, setAgents] = createSignal<Agent[] | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [sharing, setSharing] = createSignal(false);
  const canShare = () => capabilities.multiUser && !!props.sessionId;
  const scope = () => `${props.agentId}\n${props.sessionId ?? ""}`;
  const [share, { mutate: setShare }] = createResource(
    () => open() && canShare() ? scope() : null,
    () => chatShare(props.agentId, props.sessionId!).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : "Could not load sharing. Try again.", "error");
      return null;
    })
  );
  let root: HTMLDivElement | undefined;
  let button: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const shareAction = async (revoke: boolean) => {
    if (sharing() || !props.sessionId) return;
    const currentScope = scope();
    setSharing(true);
    try {
      const result = !revoke && share()?.token ? share() : await chatShare(props.agentId, props.sessionId, revoke ? "DELETE" : "PUT");
      if (currentScope !== scope()) return;
      if (!result) throw new Error("This chat is not available for sharing.");
      setShare(result);
      if (revoke) showToast("Share link revoked", "success");
      else {
        const base = import.meta.env.BASE_URL.replace(/\/+$/, "");
        await navigator.clipboard.writeText(`${window.location.origin}${base}/shared/${result.token}`);
        showToast("Share link copied", "success");
      }
      setOpen(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not change sharing. Try again.", "error");
    } finally {
      setSharing(false);
    }
  };
  const close = () => { setOpen(false); button?.focus(); };
  const openPicker = async () => {
    if (loading()) return;
    setLoading(true);
    try {
      const options = await fetchMainAgentOptions(capabilities.forkedAgents === true);
      setPreference(options.preference);
      if (options.agents.length) { setAgents(options.agents); setOpen(false); }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not load agents. Try again.", "error");
    } finally {
      setLoading(false);
    }
  };
  createEffect(() => {
    if (!open()) return;
    const outside = (event: MouseEvent) => { if (!root?.contains(event.target as Node)) setOpen(false); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key === "Tab") setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", keydown, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", keydown, true);
    });
  });
  const menuKeydown = (event: KeyboardEvent) => {
    const items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus();
    }
  };
  return <>
    <Show when={!props.projectId || props.settingsAgentId || canShare()}>
      <div ref={root} class="chat-settings">
        <button ref={button} type="button" class="agent-settings-btn" aria-label="Chat settings" title="Chat settings" aria-haspopup="menu" aria-expanded={open()} onClick={() => setOpen(!open())} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); menu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(); }
        }}><i class="fa-solid fa-gear" aria-hidden="true" /></button>
        <Show when={open()}>
          <div ref={menu} class="chat-settings-menu" role="menu" onKeyDown={menuKeydown}>
            <Show when={!props.projectId}>
              <button type="button" role="menuitem" disabled={loading()} onClick={() => void openPicker()}>Default agent…<Show when={isMain()}><span class="chat-settings-current"> current</span></Show></button>
            </Show>
            <Show when={props.settingsAgentId}>{(id) => <A role="menuitem" href={`/agents/${encodeURIComponent(id())}/edit`} state={{ backTo: `${location.pathname}${location.search}` }} onClick={() => setOpen(false)}>Agent settings</A>}</Show>
            <Show when={canShare()}>
              <button type="button" role="menuitem" disabled={sharing() || share.loading || !share()} onClick={() => void shareAction(false)}>{share()?.shared ? "Copy link" : "Share link"}</button>
              <Show when={share()?.shared}><button type="button" role="menuitem" disabled={sharing() || share.loading} onClick={() => void shareAction(true)}>Revoke link</button></Show>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
    <Show when={agents()}>{(choices) => <Portal>
      <MainAgentPicker agents={choices()} initialAgentId={props.agentId} recordDismissal={false} onClose={() => { setAgents(null); button?.focus(); }} onPick={(agent) => {
        setPreference({ mainAgentId: agent.id, accessible: true, pickerDismissedAt: null });
        setAgents(null);
        props.onPick(agent.id);
      }} />
    </Portal>}</Show>
    <style>{`
      .chat-settings { position: relative; }
      .chat-settings-menu { position: absolute; top: calc(100% + 8px); right: 0; z-index: 30; min-width: 208px; padding: 4px; border: 1px solid var(--surface-2); border-radius: 12px; background: var(--bg-raised); }
      .chat-settings-menu > button, .chat-settings-menu > a { display: flex; align-items: center; gap: 8px; width: 100%; padding: 12px; border: none; border-radius: 8px; background: transparent; color: var(--text-primary); font: inherit; font-size: 13px; text-decoration: none; text-align: left; cursor: pointer; }
      .chat-settings-menu > :hover, .chat-settings-menu > :focus-visible { background: var(--surface-1); outline: 2px solid var(--tone-user); outline-offset: -2px; }
      .chat-settings-menu > :disabled { opacity: .5; cursor: wait; }
      .chat-settings-current { margin-left: auto; color: var(--text-secondary); font-size: 12px; }
    `}</style>
  </>;
}
