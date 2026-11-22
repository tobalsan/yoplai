import { Show, createSignal, type Accessor } from "solid-js";
import { Portal } from "solid-js/web";
import { ConfirmDialog } from "../ui/ConfirmDialog";

export function createDiscardPrompt(dirty: Accessor<boolean>, title: string) {
  const [action, setAction] = createSignal<(() => void) | undefined>();
  const request = (proceed: () => void) => {
    if (!dirty()) proceed();
    else if (!action()) setAction(() => proceed);
  };
  const Dialog = () => <Show when={action()}>
    <Portal>
      <ConfirmDialog title={title} cancelLabel="Keep editing" confirmLabel="Discard" danger
        onCancel={() => setAction(undefined)}
        onConfirm={() => {
          const proceed = action();
          setAction(undefined);
          proceed?.();
        }} />
    </Portal>
  </Show>;
  return { request, pending: action, Dialog };
}
