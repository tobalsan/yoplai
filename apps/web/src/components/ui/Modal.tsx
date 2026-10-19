import { JSX, Show, createEffect, onCleanup, createUniqueId } from "solid-js";

type ModalProps = {
  title: string;
  titleHidden?: boolean;
  onClose: () => void;
  children: JSX.Element;
  footer?: JSX.Element;
  size?: "sm" | "md" | "lg";
  initialFocus?: HTMLElement;
  dismissible?: boolean;
  error?: string;
};

export function Modal(props: ModalProps) {
  let panelRef: HTMLElement | undefined;
  const dismissible = () => props.dismissible ?? true;
  const titleId = createUniqueId();
  let previousActiveElement: Element | null = null;

  const getFocusableElements = (): HTMLElement[] => {
    if (!panelRef) return [];
    return Array.from(
      panelRef.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => element.tabIndex >= 0);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (dismissible()) {
        event.preventDefault();
        props.onClose();
      }
      return;
    }

    if (event.key === "Tab") {
      const focusable = getFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef?.focus();
        return;
      }
      if (focusable.length === 1 || document.activeElement === panelRef) {
        event.preventDefault();
        focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
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

    queueMicrotask(() => {
      if (props.initialFocus) {
        props.initialFocus.focus();
      } else {
        const focusable = getFocusableElements();
        focusable[0]?.focus();
      }
    });
  });

  return (
    <div
      class="ui-modal-overlay"
      onMouseDown={(event) => {
        if (dismissible() && event.target === event.currentTarget) {
          props.onClose();
        }
      }}
    >
      <section
        ref={panelRef}
        class="ui-modal"
        classList={{ "ui-modal--sm": props.size === "sm", "ui-modal--lg": props.size === "lg" }}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header class="ui-modal__header" classList={{ "ui-modal__header--hidden": props.titleHidden }}>
          <h2 id={titleId}>{props.title}</h2>
        </header>
        <div class="ui-modal__body">
          <Show when={props.error}>
            <div class="ui-modal__error" role="alert">{props.error}</div>
          </Show>
          {props.children}
        </div>
        <Show when={props.footer}>
          <footer class="ui-modal__footer">{props.footer}</footer>
        </Show>
      </section>
      <style>{`
        .ui-modal-overlay {
          position: fixed;
          inset: 0;
          z-index: 1200;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(0, 0, 0, 0.45);
        }

        .ui-modal {
          width: min(480px, 100%);
          max-height: calc(100vh - 48px);
          overflow-y: auto;
          border: 1px solid var(--border-default);
          border-radius: 10px;
          background: var(--bg-surface);
          color: var(--text-primary);
          box-shadow: 0 24px 70px rgba(0, 0, 0, 0.38);
        }

        .ui-modal--sm {
          width: min(400px, 100%);
        }

        .ui-modal--lg {
          width: min(720px, 100%);
        }

        .ui-modal__header {
          padding: 16px 18px 10px;
          border-bottom: 1px solid var(--border-subtle);
        }

        .ui-modal__header h2 {
          margin: 0;
          font-size: 16px;
          font-weight: 650;
        }

        .ui-modal__header--hidden {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          overflow: hidden;
          clip-path: inset(50%);
          white-space: nowrap;
        }

        .ui-modal__body {
          padding: 16px 18px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .ui-modal__footer {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          padding: 12px 18px 16px;
        }

        .ui-modal__error {
          margin-bottom: 12px;
          padding: 10px 12px;
          border-radius: 6px;
          background: color-mix(in srgb, var(--tone-error, #dc2626) 10%, transparent);
          color: var(--tone-error, #dc2626);
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}
