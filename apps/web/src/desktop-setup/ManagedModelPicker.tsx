import { Show, createResource, createSignal, onMount, type ComponentProps } from "solid-js";
import { Portal } from "solid-js/web";
import { isDesktopWindow } from "../lib/desktop-window";
import { readAccess, signOutProvider } from "./api";
import { ModelPicker } from "./ModelPicker";
import { ModelAccess } from "./ModelAccess";
import { useOptionalSetup } from "./SetupGate";
import styles from "./wizard.css?inline";

export function ManagedModelPicker(props: Omit<ComponentProps<typeof ModelPicker>, "access"> & {
  local?: boolean;
  onAccessChanged?: () => unknown;
}) {
  const localAccess = () => props.local === true && isDesktopWindow();
  const [access, { refetch }] = createResource(localAccess, () => readAccess().catch(() => undefined));
  const [screen, setScreen] = createSignal<"access" | "key">();
  const setup = useOptionalSetup();
  const refresh = async () => {
    await Promise.all([refetch(), props.onAccessChanged?.(), setup?.refreshModels()]);
  };
  const refreshInBackground = () => { void refresh().catch(() => undefined); };
  const actions = () => {
    const data = localAccess() && access.state === "ready" && access();
    if (data) return {
      data,
      open: (addKey?: boolean) => setScreen(addKey ? "key" : "access"),
      signOut: async (provider: string) => {
        await signOutProvider(provider);
        await refresh();
      },
    };
  };
  return <>
    <ModelPicker models={props.models} selected={props.selected} unavailable={props.unavailable} disabled={props.disabled}
      onSelect={props.onSelect} access={actions()} />
    <Show when={localAccess() && screen()} keyed>{(mode) => <Portal>
      <AccessDialog addKey={mode === "key"} onClose={() => { setScreen(undefined); refreshInBackground(); }}
        onDetachedActionSettled={refreshInBackground} />
    </Portal>}</Show>
  </>;
}

function AccessDialog(props: { addKey: boolean; onClose: () => void; onDetachedActionSettled: () => void }) {
  let dialog!: HTMLDialogElement;
  onMount(() => dialog.showModal());
  const close = () => { dialog.close(); props.onClose(); };
  return <dialog ref={dialog} class="setup-wizard setup-window model-access-dialog" aria-label="Model access"
    onCancel={(event) => { event.preventDefault(); close(); }}
    onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}>
    <style>{styles}</style>
    <header>
      <h2>Model access</h2>
      <button type="button" aria-label="Close model access" onClick={close}><i class="fa-solid fa-xmark" aria-hidden="true" /></button>
    </header>
    <ModelAccess onContinue={close} editing addKey={props.addKey} onDetachedActionSettled={props.onDetachedActionSettled} />
  </dialog>;
}
