import { Button } from "./Button";
import { createSignal, createEffect, onCleanup, Show, createUniqueId, type JSX } from "solid-js";

type ConfirmDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  error?: string;
  dismissible?: boolean;
  children?: JSX.Element;
};

export function ConfirmDialog(props: ConfirmDialogProps) {
  const [confirming, setConfirming] = createSignal(false);
  let cancelRef: HTMLButtonElement | undefined;
  let dialogRef: HTMLDivElement | undefined;
  const dismissible = () => (props.dismissible ?? true) && !confirming();
  const titleId = createUniqueId();
  const descId = createUniqueId();
  let previousActiveElement: Element | null = null;

  const getFocusableElements = (): HTMLElement[] => {
    if (!dialogRef) return [];
    return Array.from(
      dialogRef.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )
    );
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (dismissible()) {
        event.preventDefault();
        props.onCancel();
      }
      return;
    }

    if (event.key === "Tab") {
      const focusable = getFocusableElements();
      if (focusable.length === 0) return;
      if (focusable.length === 1) {
        event.preventDefault();
        return;
      }

      const firstFocusable = focusable[0];
      const lastFocusable = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey) {
        if (activeElement === firstFocusable) {
          event.preventDefault();
          lastFocusable.focus();
        }
      } else {
        if (activeElement === lastFocusable) {
          event.preventDefault();
          firstFocusable.focus();
        }
      }
    }
  };

  createEffect(() => {
    previousActiveElement = document.activeElement;
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previousActiveElement instanceof HTMLElement) {
        previousActiveElement.focus();
      }
    });
    queueMicrotask(() => cancelRef?.focus());
  });

  const handleConfirm = async () => {
    if (confirming()) return;
    setConfirming(true);
    try {
      await props.onConfirm();
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div
      class="ui-confirm-backdrop"
      onMouseDown={(event) => {
        if (dismissible() && event.target === event.currentTarget) {
          props.onCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        class="ui-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <h3 id={titleId}>{props.title}</h3>
        <p id={descId}>{props.description}</p>
        {props.children}
        <Show when={props.error}>
          {(message) => <p class="ui-confirm-error" role="alert">{message()}</p>}
        </Show>
        <div class="ui-confirm-actions">
          <Button
            variant="secondary"
            ref={cancelRef}
            disabled={confirming()}
            onClick={props.onCancel}
          >
            Cancel
          </Button>
          <Button
            variant={props.danger ? "danger" : "primary"}
            disabled={confirming()}
            onClick={() => void handleConfirm()}
          >
            {confirming() ? "…" : props.confirmLabel}
          </Button>
        </div>
      </div>
      <style>{`
        .ui-confirm-backdrop {
          position: fixed;
          inset: 0;
          z-index: 1200;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(0, 0, 0, 0.45);
        }

        .ui-confirm-dialog {
          width: min(420px, 100%);
          border: 1px solid var(--border-default);
          border-radius: 10px;
          background: var(--bg-surface);
          color: var(--text-primary);
          padding: 18px 20px;
          box-shadow: 0 24px 70px rgba(0, 0, 0, 0.38);
        }

        .ui-confirm-dialog h3 {
          margin: 0 0 8px;
          font-size: 15px;
          font-weight: 650;
          color: var(--text-primary);
        }

        .ui-confirm-dialog p {
          margin: 0 0 16px;
          font-size: 13px;
          line-height: 1.55;
          color: var(--text-secondary);
        }

        .ui-confirm-error {
          color: var(--tone-error, #dc2626) !important;
        }

        .ui-confirm-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 20px;
        }
      `}</style>
    </div>
  );
}
