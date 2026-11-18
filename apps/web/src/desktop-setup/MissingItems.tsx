import { Show, createResource, createSignal } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { fetchAgents } from "../api";
import { stripBase } from "../lib/path";
import { setupRepairHref } from "./repair";
import { useSetup } from "./SetupGate";

const dismissedKey = "yoplai:desktop-missing-dismissed";

export function MissingItems() {
  const location = useLocation();
  const setup = useSetup();
  const [dismissed, setDismissed] = createSignal(sessionStorage.getItem(dismissedKey) === "1");
  const [agents] = createResource(() => !dismissed(), () => fetchAgents().catch(() => undefined));
  const missingModels = () => setup.models()?.length === 0;
  const missingAgent = () => agents()?.every((agent) => !!agent.gateway) === true;
  const path = () => stripBase(location.pathname) + location.search;
  return <Show when={!dismissed() && (missingModels() || missingAgent())}>
    <aside class="setup-missing" aria-label="Missing setup items">
      <Show when={missingModels()}><A href={setupRepairHref("model", path())}>Model access</A></Show>
      <Show when={missingAgent()}><A href={setupRepairHref("agent", path())}>First agent</A></Show>
      <button type="button" aria-label="Close missing setup items" onClick={() => {
        sessionStorage.setItem(dismissedKey, "1");
        setDismissed(true);
      }}>×</button>
    </aside>
    <style>{`
      .setup-missing { display: flex; align-items: center; justify-content: center; gap: 1rem; padding: .3rem 1rem;
        background: var(--bg-surface); border-bottom: 1px solid var(--border-default); color: var(--text-primary); font-size: .85rem; }
      .desktop-window .setup-missing {
        position: fixed;
        inset: auto 16px 112px auto;
        z-index: 8;
        gap: .65rem;
        padding: .15rem .65rem;
        border: 1px solid var(--border-default);
        border-radius: 999px;
      }
      .setup-missing a { color: inherit; text-decoration: underline; }
      .setup-missing button { cursor: pointer; color: inherit; background: transparent; border: 0; font-size: 1.2rem; }
    `}</style>
  </Show>;
}
