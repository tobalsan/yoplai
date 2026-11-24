import { useLocation } from "@solidjs/router";
import { Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js";
import "./SidebarAccountMenu.css";

export function SidebarAccountMenu(props: { class?: string; triggerClass: string; trigger: JSX.Element; children: JSX.Element }) {
  const location = useLocation();
  const [open, setOpen] = createSignal(false);
  let menu: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;

  createEffect(on(() => [location.pathname, location.search], () => setOpen(false)));
  createEffect(() => {
    if (!open()) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menu?.contains(target) && !trigger?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger?.focus();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    onCleanup(() => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    });
  });

  const items = () => Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);

  function moveFocus(event: KeyboardEvent) {
    const choices = items();
    if (!choices.length) return;
    const current = choices.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (current + 1) % choices.length; break;
      case "ArrowUp": next = current <= 0 ? choices.length - 1 : current - 1; break;
      case "Home": next = 0; break;
      case "End": next = choices.length - 1; break;
      default: return;
    }
    event.preventDefault();
    choices[next]?.focus();
  }

  return (
    <div class={`sidebar-account-menu ${props.class ?? ""}`}>
      <button
        ref={trigger}
        class={props.triggerClass}
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
          const choices = items();
          (event.key === "ArrowDown" ? choices[0] : choices.at(-1))?.focus();
        }}
      >
        {props.trigger}
      </button>
      <Show when={open()}>
        <div ref={menu} class="account-menu" role="menu" onKeyDown={moveFocus} onClick={() => setOpen(false)}>
          {props.children}
        </div>
      </Show>
    </div>
  );
}
