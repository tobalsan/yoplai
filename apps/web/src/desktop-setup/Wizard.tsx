import { For, Match, Show, Switch, createEffect, createResource, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { GatewayLinkPanel } from "../pages/RemoteGateways";
import { isDesktopWindow } from "../lib/desktop-window";
import { AgentMark, Wordmark } from "./Marks";
import { ModelAccess } from "./ModelAccess";
import { FirstAgent } from "./FirstAgent";
import { useSetup } from "./SetupGate";
import { errorText, readModels, type Model } from "./api";
import styles from "./wizard.css?inline";

const checkpoint = "yoplai:desktop-setup-step";
const steps = ["welcome", "choice", "model", "agent"] as const;

export default function Wizard() {
  const navigate = useNavigate();
  const setup = useSetup();
  const savedStep = sessionStorage.getItem(checkpoint);
  const [index, setIndex] = createSignal(Math.max(0, steps.findIndex((step) => step === savedStep)));
  createEffect(() => sessionStorage.setItem(checkpoint, steps[index()]));
  const [remote, setRemote] = createSignal(false);
  const [link, setLink] = createSignal(false);
  const [models, setModels] = createSignal<Model[]>([]);
  const [loaded, { refetch }] = createResource(() => index() === 3 && !models().length, async () => {
    try { return await readModels(); }
    catch (cause) { setError(errorText(cause)); return []; }
  });
  const agentModels = () => models().length ? models() : loaded() ?? [];
  const [busy, setBusy] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [error, setError] = createSignal("");

  const exit = async (destination: string, skip = false) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await setup.save({ wizardExited: true, exitedAt: new Date().toISOString(), ...(skip ? {
        skipped: [...new Set([...(setup.state()?.skipped ?? []), steps[index()]])],
      } : {}) });
      sessionStorage.removeItem(checkpoint);
      navigate(destination, { replace: true });
    } catch (cause) {
      setError(errorText(cause));
      throw cause;
    } finally { setBusy(false); }
  };
  const back = () => {
    setError("");
    if (link()) setLink(false);
    else setIndex(index() - 1);
  };

  return <main class="setup-wizard" classList={{ "setup-window": isDesktopWindow() }}>
    <style>{styles}</style>
    <header class="setup-brand"><Wordmark /></header>
    <div class={`setup-stage setup-${link() ? "link" : steps[index()]}`}>
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
          <GatewayLinkPanel onLinked={() => exit("/agents")} />
        </Match>
        <Match when={index() === 2}>
          <AgentMark />
          <h1>Give your agents a model.</h1>
          <p class="setup-subtitle">Turn on one source or more.</p>
          <ModelAccess onContinue={(list) => { setModels(list); setIndex(3); }} />
        </Match>
        <Match when={index() === 3}>
          <h1>Create your first agent.</h1>
          <Show when={agentModels().length} fallback={<Show when={loaded.loading} fallback={
            <button class="setup-outline" onClick={() => { setError(""); void refetch(); }}>Reload models</button>
          }><p role="status">Loading models…</p></Show>}>
            <FirstAgent models={agentModels()} onBusy={setCreating} onCreated={(id) => exit(`/chat/${encodeURIComponent(id)}`)} />
          </Show>
        </Match>
      </Switch>
      <Show when={error()}><p role="alert">{error()}</p></Show>
    </div>
    <footer class="setup-footer">
      <span><Show when={index() > 0}><button disabled={busy() || creating()} onClick={back}>Back</button></Show></span>
      <div class="setup-dots" aria-hidden="true"><For each={steps}>{(_, i) => <span classList={{ current: i() === index() }} />}</For></div>
      <button disabled={busy() || creating()} onClick={() => void exit("/agents", true).catch(() => undefined)}>Skip</button>
    </footer>
  </main>;
}
