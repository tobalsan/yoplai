import { useLocation } from "@solidjs/router";
import { For, Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js";
import { setThemeChoice, themeChoice, type ThemeChoice } from "../theme";
import "./SidebarAccountMenu.css";

const themes = [
  { choice: "light", label: "Light" },
  { choice: "dark", label: "Dark" },
  { choice: "system", label: "System" },
] as const;

function ThemeIcon(props: { choice: ThemeChoice }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <Show when={props.choice === "light"}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m-14.2 0 1.4-1.4M17.7 6.3l1.4-1.4" />
      </Show>
      <Show when={props.choice === "dark"}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
      </Show>
      <Show when={props.choice === "system"}>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8m-4-4v4" />
      </Show>
    </svg>
  );
}

export function SidebarAccountMenu(props: {
  avatar: JSX.Element;
  name: string;
  detail?: string | null;
  children: JSX.Element;
  logout?: JSX.Element;
}) {
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

  const items = () => Array.from(
    menu?.querySelectorAll<HTMLElement>(':is([role="menuitem"], [role="menuitemradio"]):not(:disabled)') ?? [],
  );

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
    <div class="sidebar-account-menu">
      <button
        ref={trigger}
        class="sidebar-account-toggle"
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
        {props.avatar}
        <div class="sidebar-account-body">
          <div class="sidebar-account-name">{props.name}</div>
          <div class="sidebar-account-detail">{props.detail}</div>
        </div>
        <i class="fa-solid fa-chevron-up sidebar-account-chevron" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div ref={menu} class="account-menu" role="menu" onKeyDown={moveFocus} onClick={() => setOpen(false)}>
          {props.children}
          <hr class="account-menu-separator" />
          <div role="group" aria-label="Theme">
            <div class="account-menu-heading" aria-hidden="true">Theme</div>
            <For each={themes}>{({ choice, label }) => (
              <button
                type="button"
                class="account-menu-item"
                role="menuitemradio"
                aria-checked={themeChoice() === choice}
                onClick={(event) => {
                  event.stopPropagation();
                  setThemeChoice(choice);
                }}
              >
                <ThemeIcon choice={choice} />
                {label}
                <Show when={themeChoice() === choice}>
                  <i class="fa-solid fa-check account-menu-check" aria-hidden="true" />
                </Show>
              </button>
            )}</For>
          </div>
          <Show when={props.logout}>
            <hr class="account-menu-separator" />
            {props.logout}
          </Show>
        </div>
      </Show>
    </div>
  );
}
