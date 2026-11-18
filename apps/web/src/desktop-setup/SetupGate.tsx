import { Show, createContext, createEffect, createResource, useContext, type JSX } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import type { DesktopSetupState } from "@yoplai/shared/types";
import { capabilities } from "../lib/capabilities";
import { chatRouteSession, stripBase } from "../lib/path";
import { readModels, readSetup, saveSetup, type Model } from "./api";

const Setup = createContext<{
  state: () => DesktopSetupState | undefined;
  models: () => Model[] | undefined;
  save: (update: Partial<DesktopSetupState>, when?: () => boolean) => Promise<void>;
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
  let saving = Promise.resolve();
  const show = () => enabled()
    ? !state.loading && !!state() && (onSetup() || state()?.wizardExited === true || pendingChat())
    : !onSetup();
  return <Setup.Provider value={{ state: () => enabled() ? state() : undefined, models: () => exited() ? models() : undefined,
    save(update, when) {
      const result = saving.then(async () => {
        if (enabled() && (!when || when())) mutate(await saveSetup(update));
      });
      saving = result.catch(() => undefined);
      return result;
    },
  }}>
    <Show when={enabled() && !state.loading && !state()}>
      <main><p role="alert">Yoplai could not read the setup state.</p>
        <button onClick={() => void refetch()}>Retry</button>
      </main>
    </Show>
    <Show when={show()}>{props.children}</Show>
  </Setup.Provider>;
}
