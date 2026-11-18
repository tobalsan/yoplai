import { Show, createContext, createEffect, createResource, createSignal, useContext, type JSX } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import type { DesktopSetupState } from "@yoplai/shared/types";
import { capabilities } from "../lib/capabilities";
import { chatRouteSession, stripBase } from "../lib/path";
import { readModels, readSetup, saveSetup, type Model } from "./api";

const Setup = createContext<{
  state: () => DesktopSetupState | undefined;
  models: () => Model[] | undefined;
  save: (update: Partial<DesktopSetupState>, when?: () => boolean) => Promise<void>;
  refresh: () => Promise<void>;
}>();
export const useOptionalSetup = () => useContext(Setup);
export const useSetup = () => useOptionalSetup()!;

export function SetupGate(props: { children: JSX.Element }) {
  const location = useLocation();
  const navigate = useNavigate();
  const enabled = () => capabilities.desktopSetup === true && !capabilities.multiUser;
  const onSetup = () => stripBase(location.pathname) === "/setup";
  const [state, { mutate, refetch }] = createResource(enabled, () => readSetup().catch(() => undefined));
  const pendingChat = () => {
    const chat = state()?.firstChat;
    if (!chat || state()?.completed) return false;
    const route = chatRouteSession(location.pathname, location.search);
    return route.agentId === chat.agentId && route.sessionId === chat.sessionId;
  };
  createEffect(() => {
    if (!enabled()) {
      if (onSetup()) navigate("/", { replace: true });
    } else if (!onSetup() && !state.loading && state()?.wizardExited === false && !pendingChat()) {
      navigate("/setup", { replace: true });
    }
  });
  const exited = () => enabled() && !onSetup() && state()?.wizardExited === true;
  const [models] = createResource(exited, () => readModels().catch(() => undefined));
  let pending = Promise.resolve();
  const enqueue = (action: () => Promise<void>) => {
    const result = pending.then(async () => { if (enabled()) await action(); });
    pending = result.catch(() => undefined);
    return result;
  };
  const [refreshError, setRefreshError] = createSignal(false);
  const refresh = () => enqueue(async () => {
    try {
      mutate(await readSetup());
      setRefreshError(false);
    } catch {
      setRefreshError(true);
    }
  });
  const show = () => enabled()
    ? !state.loading && !!state() && (onSetup() || state()?.wizardExited === true || pendingChat())
    : !onSetup();
  return <Setup.Provider value={{ state: () => enabled() ? state() : undefined, models: () => exited() ? models() : undefined,
    save: (update, when) => enqueue(async () => {
      if (!when || when()) mutate(await saveSetup(update));
    }),
    refresh,
  }}>
    <Show when={enabled() && !state.loading && !state()}>
      <main><p role="alert">Yoplai could not read the setup state.</p>
        <button onClick={() => void refetch()}>Retry</button>
      </main>
    </Show>
    <Show when={enabled() && refreshError()}>
      <div><p role="alert">Yoplai could not refresh the setup state.</p>
        <button onClick={() => void refresh()}>Retry setup refresh</button>
      </div>
    </Show>
    <Show when={show()}>{props.children}</Show>
  </Setup.Provider>;
}
