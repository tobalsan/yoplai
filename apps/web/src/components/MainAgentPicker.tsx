import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import type { Agent } from "../api/types";
import { saveMainAgentPreference } from "../api/main-agent";
import { fetchAgentSessions } from "../api/chat";
import { showToast } from "../lib/toast";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { defaultAvatarUrl } from "../lib/default-avatar";

function Avatar(props: { agent: Agent }) {
  return (
    <Show when={props.agent.avatar} fallback={<img src={defaultAvatarUrl(props.agent.id)} alt="" />}>
      {(avatar) => /^\p{Emoji}/u.test(avatar()) && avatar().length <= 4
        ? <span>{avatar()}</span>
        : <img src={avatar()} alt="" />}
    </Show>
  );
}

export function MainAgentPicker(props: {
  agents: Agent[];
  initialAgentId?: string;
  recordDismissal?: boolean;
  beforePick?: (proceed: () => void) => void;
  onPick: (agent: Agent) => void;
  onClose: () => void;
}) {
  const [focusedId, setFocusedId] = createSignal(props.initialAgentId ?? props.agents[0].id);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [sessions] = createResource(() => !props.initialAgentId, () => fetchAgentSessions().catch(() => ({ items: [] })));
  let interacted = false;
  createEffect(() => {
    if (props.initialAgentId || interacted) return;
    const recent = sessions()?.items
      .filter((session) => props.agents.some((agent) => agent.id === session.agentId))
      .sort((a, b) => b.lastActivity - a.lastActivity)[0];
    if (recent) setFocusedId(recent.agentId);
  });
  createEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    onCleanup(() => { document.body.style.overflow = overflow; });
  });
  const index = createMemo(() => Math.max(0, props.agents.findIndex((agent) => agent.id === focusedId())));
  const focused = () => props.agents[index()];
  // Signed distance from the focused agent, wrapping around when there are more than two agents.
  const slotOffset = (slot: number) => {
    const count = props.agents.length;
    if (count <= 2) return slot - index();
    const forward = (slot - index() + count) % count;
    return forward > count / 2 ? forward - count : forward;
  };
  let confirmButton: HTMLButtonElement | undefined;
  onMount(() => {
    const frame = requestAnimationFrame(() => confirmButton?.focus());
    onCleanup(() => cancelAnimationFrame(frame));
  });
  const focus = (agent: Agent) => { if (!saving()) { interacted = true; setFocusedId(agent.id); } };
  const move = (offset: number) => focus(props.agents[(index() + offset + props.agents.length) % props.agents.length]);

  const dismiss = async () => {
    if (saving()) return;
    setSaving(true);
    setError("");
    try {
      if (props.recordDismissal !== false) {
        await saveMainAgentPreference({ pickerDismissedAt: new Date().toISOString() });
      }
      props.onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save your preference. Try again.");
    } finally {
      setSaving(false);
    }
  };
  const saveChoice = async (agent: Agent) => {
    if (saving()) return;
    setSaving(true);
    setError("");
    try {
      await saveMainAgentPreference({ mainAgentId: agent.id });
      showToast(`${agent.name} is your main agent`, "success");
      props.onPick(agent);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save your main agent. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const choose = () => {
    const agent = focused();
    const proceed = () => void saveChoice(agent);
    if (props.beforePick) props.beforePick(proceed);
    else proceed();
  };

  return (
    <div class="main-agent-picker" onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        move(event.key === "ArrowLeft" ? -1 : 1);
      }
    }}>
      <Modal title="Pick your main agent" onClose={() => void dismiss()} dismissible={false} size="lg" initialFocus={confirmButton} error={error()}>
        <button type="button" class="main-agent-close" aria-label="Close main agent picker" onClick={() => void dismiss()} disabled={saving()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
        </button>
        <p class="main-agent-intro">Which agent do you talk the most to?</p>
        <p class="main-agent-reassurance">Just a preference. Every agent stays available, you can change it anytime.</p>
        <div class="main-agent-stage">
          <div class="main-agent-pedestal" aria-hidden="true" />
          <For each={props.agents}>{(agent, i) => {
            const offset = () => slotOffset(i());
            const depth = () => Math.min(Math.abs(offset()), 3);
            let last: number | undefined;
            const style = () => {
              const current = offset();
              const jump = last !== undefined && Math.abs(current - last) > 2;
              last = current;
              return { "--x": `calc(${Math.sign(current)} * var(--step-${depth()}))`, transition: jump ? "none" : undefined };
            };
            return (
              <button type="button" class="main-agent-slot" data-depth={depth()} style={style()}
                aria-label={offset() === 0 ? `${agent.name}, selected` : `Focus ${agent.name}`}
                aria-hidden={depth() > 2 ? "true" : undefined}
                tabIndex={depth() === 1 ? undefined : -1}
                onClick={() => focus(agent)} disabled={saving()}>
                <span class="main-agent-avatar"><Avatar agent={agent} /></span>
                <span class="main-agent-slot-name">{agent.name}</span>
              </button>
            );
          }}</For>
        </div>
        <div class="main-agent-focus" aria-live="polite" aria-atomic="true">
          <Show when={focused()} keyed>{(agent) => (
            <div class="main-agent-copy">
              <h3>{agent.name}</h3>
              <p>{agent.description ?? agent.role ?? "Ready when you are."}</p>
            </div>
          )}</Show>
        </div>
        <div class="main-agent-navigation">
          <button type="button" aria-label="Previous agent" onClick={() => move(-1)} disabled={saving()}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></button>
          <span>{index() + 1} of {props.agents.length}</span>
          <button type="button" aria-label="Next agent" onClick={() => move(1)} disabled={saving()}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button>
        </div>
        <div class="main-agent-confirm"><Button ref={confirmButton} variant="primary" loading={saving()} loadingLabel="Saving…" disabled={saving()} onClick={() => void choose()}>Make {focused().name} my main agent</Button></div>
        <button type="button" class="main-agent-later" onClick={() => void dismiss()} disabled={saving()}>I will decide later</button>
      </Modal>
      <style>{`
        .main-agent-picker .ui-modal-overlay { background: color-mix(in srgb, var(--bg-base) 78%, transparent); backdrop-filter: blur(8px); padding: 24px; }
        .main-agent-picker .ui-modal { position: relative; width: min(960px, 100%); border: 0; border-radius: 16px; background: var(--bg-surface); box-shadow: 0 32px 96px var(--shadow-md); animation: main-agent-arrive 240ms cubic-bezier(.23,1,.32,1); }
        .main-agent-picker .ui-modal__header { padding: 48px 64px 0; border: 0; text-align: center; }
        .main-agent-picker .ui-modal__header h2 { font-size: clamp(26px, 4vw, 36px); font-weight: 650; letter-spacing: -.03em; line-height: 1.15; text-wrap: balance; }
        .main-agent-picker .ui-modal__body { padding: 12px 48px 32px; gap: 0; text-align: center; }
        .main-agent-intro { color: var(--text-secondary); font-size: 15px; line-height: 1.6; text-wrap: pretty; }
        .main-agent-close { position: absolute; top: 12px; right: 12px; width: 44px; height: 44px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; }
        .main-agent-stage { --avatar: 160px; --step-0: 0px; --step-1: 190px; --step-2: 290px; --step-3: 360px; --ease-slide: cubic-bezier(.22,1,.36,1); position: relative; height: calc(var(--avatar) + 72px); margin-top: 32px; overflow: hidden; mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent); }
        .main-agent-pedestal { position: absolute; left: 50%; bottom: 30px; width: calc(var(--avatar) * 1.25); height: 24px; transform: translateX(-50%); border-radius: 50%; background: var(--bg-raised); }
        .main-agent-slot { position: absolute; left: 50%; bottom: 0; width: var(--avatar); margin-left: calc(var(--avatar) / -2); display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 0 0 4px; border: 0; border-radius: 12px; background: transparent; color: var(--text-secondary); font: inherit; cursor: pointer; transform: translateX(var(--x)); transition: transform 560ms var(--ease-slide), opacity 420ms var(--ease-slide); will-change: transform; }
        .main-agent-avatar { display: grid; place-items: center; width: var(--avatar); height: var(--avatar); border-radius: 50%; overflow: hidden; background: var(--bg-raised); font-size: calc(var(--avatar) * .55); font-weight: 600; color: var(--tone-user); transform-origin: 50% 100%; transition: transform 620ms cubic-bezier(.34,1.4,.64,1), opacity 420ms var(--ease-slide), filter 420ms var(--ease-slide); }
        .main-agent-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .main-agent-slot-name { max-width: 100%; overflow-wrap: anywhere; font-size: 13px; line-height: 1.3; transition: opacity 320ms var(--ease-slide); }
        .main-agent-slot[data-depth="0"] { z-index: 3; cursor: default; }
        .main-agent-slot[data-depth="0"] .main-agent-avatar { transform: translateY(-20px); }
        .main-agent-slot[data-depth="0"] .main-agent-slot-name { opacity: 0; }
        .main-agent-slot[data-depth="1"] { z-index: 2; }
        .main-agent-slot[data-depth="1"] .main-agent-avatar { transform: scale(.5); opacity: .6; filter: saturate(.7); }
        .main-agent-slot[data-depth="1"] .main-agent-slot-name { opacity: .7; }
        .main-agent-slot[data-depth="1"]:hover .main-agent-avatar { transform: scale(.54) translateY(-8px); opacity: 1; filter: none; }
        .main-agent-slot[data-depth="2"] { z-index: 1; pointer-events: none; }
        .main-agent-slot[data-depth="2"] .main-agent-avatar { transform: scale(.32); opacity: .25; filter: saturate(.4) blur(1px); }
        .main-agent-slot[data-depth="2"] .main-agent-slot-name, .main-agent-slot[data-depth="3"] .main-agent-slot-name { opacity: 0; }
        .main-agent-slot[data-depth="3"] { opacity: 0; pointer-events: none; }
        .main-agent-slot[data-depth="3"] .main-agent-avatar { transform: scale(.2); }
        .main-agent-focus { min-width: 0; }
        .main-agent-copy { animation: main-agent-copy 360ms var(--ease-slide, ease-out); }
        .main-agent-focus h3 { margin: 20px 0 8px; font-size: 28px; font-weight: 650; line-height: 1.2; letter-spacing: -.02em; overflow-wrap: anywhere; }
        .main-agent-focus > p { min-height: 48px; color: var(--text-secondary); font-size: 14px; line-height: 1.6; text-wrap: pretty; }
        .main-agent-navigation { display: flex; align-items: center; justify-content: center; gap: 16px; margin: 20px 0 24px; }
        .main-agent-navigation button { width: 44px; height: 44px; display: grid; place-items: center; border: 1px solid var(--border-default); border-radius: 50%; background: transparent; color: var(--text-primary); cursor: pointer; }
        .main-agent-navigation span { min-width: 48px; color: var(--text-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
        .main-agent-confirm { display: flex; justify-content: center; }
        .main-agent-confirm .ui-button { justify-content: center; min-height: 48px; padding: 12px 24px; font-size: 15px; border-radius: 8px; }
        .main-agent-reassurance { margin: 4px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
        .main-agent-later { min-height: 44px; align-self: center; margin-top: 12px; padding: 8px 12px; border: 0; background: transparent; color: var(--text-secondary); font: inherit; font-size: 13px; text-decoration: underline; text-underline-offset: 4px; cursor: pointer; }
        .main-agent-picker button:focus-visible { outline: 2px solid var(--tone-user); outline-offset: 4px; }
        .main-agent-close:hover, .main-agent-navigation button:hover { background: var(--bg-raised); color: var(--text-primary); }
        .main-agent-picker button:not(.main-agent-slot):active:not(:disabled) { transform: scale(.97); }
        .main-agent-picker button:disabled { cursor: wait; opacity: .5; }
        @keyframes main-agent-copy { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @keyframes main-agent-arrive { from { opacity: 0; transform: translateY(12px) scale(.98); } to { opacity: 1; transform: none; } }
        @media (max-width: 600px) {
          .main-agent-picker .ui-modal-overlay { padding: 12px; }
          .main-agent-picker .ui-modal { max-height: calc(100dvh - 24px); }
          .main-agent-picker .ui-modal__header { padding: 56px 24px 0; }
          .main-agent-picker .ui-modal__body { padding: 12px 20px 20px; }
          .main-agent-stage { --avatar: 120px; --step-1: 104px; --step-2: 156px; --step-3: 200px; margin-top: 20px; }
          .main-agent-slot-name { font-size: 11px; }
          .main-agent-focus h3 { font-size: 24px; }
          .main-agent-focus > p { font-size: 13px; }
          .main-agent-navigation { margin: 12px 0 20px; }
          .main-agent-confirm .ui-button { width: 100%; padding: 12px; }
        }
        @media (prefers-reduced-motion: reduce) { .main-agent-picker .ui-modal, .main-agent-copy { animation: none; } .main-agent-slot, .main-agent-avatar, .main-agent-slot-name { transition: none; } }
      `}</style>
    </div>
  );
}
