import { For, Match, Show, Switch, createEffect, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { GatewayLinkPanel, readPendingSetupLink } from "../pages/RemoteGateways";
import { isDesktopWindow } from "../lib/desktop-window";
import { AgentMark, Wordmark } from "./Marks";
import { ModelAccess } from "./ModelAccess";
import { FirstAgent, clearAgentDraft, readAgentDraft } from "./FirstAgent";
import { useSetup } from "./SetupGate";
import { localReturn } from "./repair";
import type { DesktopSetupState } from "@yoplai/shared/types";
import { errorText, readModels, type Model } from "./api";
import styles from "./wizard.css?inline";

const checkpoint = "yoplai:desktop-setup-step";
const steps = ["welcome", "choice", "model", "agent"] as const;

export default function Wizard() {
  const navigate = useNavigate();
  const setup = useSetup();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const restart = query.get("restart") === "1";
  const repairStep = query.get("step");
  const returnPath = !restart && localReturn(query.get("return"));
  const savedStep = restart ? "welcome" : repairStep === "model" || repairStep === "agent"
    ? repairStep : sessionStorage.getItem(checkpoint);
  const [resetting, setResetting] = createSignal(restart);
  const [index, setIndex] = createSignal(Math.max(0, steps.findIndex((step) => step === savedStep)));
  createEffect(() => sessionStorage.setItem(checkpoint, steps[index()]));
  const resume = savedStep === "choice" && !!readPendingSetupLink();
  const [remote, setRemote] = createSignal(resume);
  const [link, setLink] = createSignal(resume);
  const [models, setModels] = createSignal<Model[]>([]);
  const [loaded, { refetch }] = createResource(() => index() === 3 && !models().length, async () => {
    try { return await readModels(); }
    catch (cause) { setError(errorText(cause)); return []; }
  });
  const agentModels = () => models().length ? models() : loaded() ?? [];
  const [busy, setBusy] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [error, setError] = createSignal("");
  const [leavingLink, setLeavingLink] = createSignal(false);
  let leaveLink: (() => Promise<boolean>) | undefined;
  const closeLink = async () => {
    if (!leaveLink || leavingLink()) return false;
    setLeavingLink(true);
    try {
      if (!await leaveLink()) return false;
      setLink(false);
      return true;
    } finally { setLeavingLink(false); }
  };

  const resetWizard = async () => {
    setResetting(true);
    setError("");
    try {
      await setup.save({ wizardExited: false });
      clearAgentDraft();
      navigate("/setup", { replace: true });
      setResetting(false);
    } catch (cause) { setError(errorText(cause)); }
  };
  onMount(() => { if (restart) void resetWizard(); });

  const exit = async (destination: string, skip = false, update?: Partial<DesktopSetupState>) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await setup.save({ wizardExited: true, exitedAt: new Date().toISOString(), ...update, ...(skip ? {
        skipped: [...new Set([...(setup.state()?.skipped ?? []), steps[index()]])],
      } : {}) });
      clearAgentDraft();
      sessionStorage.removeItem(checkpoint);
      navigate(destination, { replace: true });
    } catch (cause) {
      setError(errorText(cause));
      throw cause;
    } finally { setBusy(false); }
  };
  const createFirstChat = (agentId: string, sessionId: string, turnId: string) => {
    const firstChat = { agentId, sessionId, turnId };
    return exit(`/chat/${encodeURIComponent(agentId)}?session=${sessionId}`, false, { firstChat, completed: false });
  };
  const back = () => {
    setError("");
    if (link()) void closeLink();
    else setIndex(index() - 1);
  };

  const skip = async () => {
    if (link() && !await closeLink()) return;
    await exit("/agents", true).catch(() => undefined);
  };

  const [moreContent, setMoreContent] = createSignal(false);
  let viewport: HTMLDivElement | undefined;
  let stage: HTMLDivElement | undefined;
  const checkScroll = () => {
    if (viewport) setMoreContent(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 1);
  };
  createEffect(() => {
    if (resetting()) return;
    const observer = new ResizeObserver(checkScroll);
    if (viewport && stage) { observer.observe(viewport); observer.observe(stage); }
    checkScroll();
    onCleanup(() => observer.disconnect());
  });
  createEffect(() => {
    index();
    link();
    if (viewport) viewport.scrollTop = 0;
  });

  return <main class="setup-wizard" classList={{ "setup-window": isDesktopWindow() }}>
    <style>{styles}</style>
    <header class="setup-brand"><Wordmark /></header>
    <Show when={!resetting()} fallback={<div class="setup-stage">
      <Show when={error()} fallback={<p role="status">Opening setup…</p>}>
        <p role="alert">{error()}</p>
        <button class="setup-outline" onClick={() => void resetWizard()}>Retry</button>
      </Show>
    </div>}>
    <div class="setup-content" classList={{ "setup-content-more": moreContent() }}>
    <div class="setup-viewport" ref={viewport} onScroll={checkScroll}>
    <div ref={stage} class={`setup-stage setup-${link() ? "link" : steps[index()]}`}>
      <Switch>
        <Match when={index() === 0}>
          <AgentMark />
          <h1>All your agents. One app.</h1>
          <p class="setup-subtitle">Local agents and remote agents, in one place.</p>
          <button class="setup-primary" onClick={() => setIndex(1)}>Get started</button>
        </Match>
        <Match when={index() === 1 && !link()}>
          <AgentMark side />
          <h1>Where do your agents run?</h1>
          <div class="setup-choices" role="group" aria-label="Agent location">
            <button aria-label="Run agents on this Mac" aria-pressed={!remote()} onClick={() => setRemote(false)}><strong>Run agents on this Mac</strong><span>Agents work on this computer.</span></button>
            <button aria-label="Connect to a Yoplai server" aria-pressed={remote()} onClick={() => setRemote(true)}><strong>Connect to a Yoplai server</strong><span>Use agents that run on a server.</span></button>
          </div>
          <button class="setup-primary" onClick={() => remote() ? setLink(true) : setIndex(2)}>Continue</button>
        </Match>
        <Match when={index() === 1 && link()}>
          <h1>Connect to a Yoplai server</h1>
          <GatewayLinkPanel registerLeave={(leave) => { leaveLink = leave; }} onLinked={() => exit("/agents")} />
        </Match>
        <Match when={index() === 2}>
          <AgentMark />
          <h1>Choose a model provider</h1>
          <p class="setup-subtitle">Turn on one source or more</p>
          <ModelAccess onContinue={(list) => {
            if (returnPath && repairStep === "model") void exit(returnPath).catch(() => undefined);
            else { setModels(list); setIndex(3); }
          }} />
        </Match>
        <Match when={index() === 3}>
          <h1>Create your first agent.</h1>
          <Show when={readAgentDraft() || agentModels().length} fallback={<Show when={loaded.loading} fallback={
            <button class="setup-outline" onClick={() => { setError(""); void refetch(); }}>Reload models</button>
          }><p role="status">Loading models…</p></Show>}>
            <FirstAgent models={agentModels()} onBusy={setCreating} onCreated={createFirstChat} />
          </Show>
        </Match>
      </Switch>
      <Show when={error()}><p role="alert">{error()}</p></Show>
    </div>
    </div>
    </div>
    <footer class="setup-footer">
      <span><Show when={index() > 0}><button disabled={busy() || creating() || leavingLink()} onClick={back}>Back</button></Show></span>
      <div class="setup-dots" role="img" aria-label={`Step ${index() + 1} of ${steps.length}`}><For each={steps}>{(_, i) => <span classList={{ current: i() === index() }} />}</For></div>
      <button disabled={busy() || creating() || leavingLink()} onClick={() => void skip()}>Skip</button>
    </footer>
    </Show>
  </main>;
}
