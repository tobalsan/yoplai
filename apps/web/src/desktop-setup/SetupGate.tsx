import { Show, createContext, createEffect, createResource, useContext, type JSX } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import type { DesktopSetupState } from "@yoplai/shared/types";
import { capabilities } from "../lib/capabilities";
import { chatRouteSession, stripBase } from "../lib/path";
import { readSetup, saveSetup } from "./api";

const Setup = createContext<{
  state: () => DesktopSetupState | undefined;
  save: (update: Partial<DesktopSetupState>) => Promise<void>;
}>();
export const useSetup = () => useContext(Setup)!;

export function SetupGate(props: { children: JSX.Element }) {
  const location = useLocation();
  const navigate = useNavigate();
  const enabled = () => capabilities.desktopSetup === true && !capabilities.multiUser;
  const onSetup = () => stripBase(location.pathname) === "/setup";
  const [state, { mutate }] = createResource(enabled, () => readSetup().catch(() => undefined));
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
  const show = () => enabled()
    ? !state.loading && (onSetup() || state()?.wizardExited !== false || pendingChat())
    : !onSetup();
  return <Setup.Provider value={{ state, async save(update) { mutate(await saveSetup(update)); } }}>
    <Show when={show()}>{props.children}</Show>
  </Setup.Provider>;
}
