import { For, Show } from "solid-js";
import { setThemeChoice, themeChoice, type ThemeChoice } from "../theme";

const choices = ["light", "dark", "system"] as const;
const labels = { light: "Light", dark: "Dark", system: "System" };

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

export function SidebarTheme(props: { collapsed: boolean }) {
  const radios: HTMLButtonElement[] = [];
  const nextChoice = () => choices[(choices.indexOf(themeChoice()) + 1) % choices.length];
  const cycleLabel = () => `Theme: ${labels[themeChoice()]}. Switch to ${labels[nextChoice()]}.`;

  function handleKey(event: KeyboardEvent, from: number) {
    let to: number;
    switch (event.key) {
      case "Home": to = 0; break;
      case "End": to = choices.length - 1; break;
      case "ArrowLeft":
      case "ArrowUp": to = (from + choices.length - 1) % choices.length; break;
      case "ArrowRight":
      case "ArrowDown": to = (from + 1) % choices.length; break;
      default: return;
    }
    event.preventDefault();
    setThemeChoice(choices[to]);
    radios[to]?.focus();
  }

  return (
    <Show when={!props.collapsed} fallback={
      <button class="sidebar-theme-cycle" type="button" aria-label={cycleLabel()} title={cycleLabel()} onClick={() => setThemeChoice(nextChoice())}>
        <ThemeIcon choice={themeChoice()} />
      </button>
    }>
      <div class="sidebar-theme-segments" role="radiogroup" aria-label="Theme">
        <For each={choices}>{(choice, index) => (
          <button
            ref={(button) => { radios[index()] = button; }}
            type="button"
            role="radio"
            aria-checked={themeChoice() === choice}
            tabIndex={themeChoice() === choice ? 0 : -1}
            aria-label={labels[choice]}
            title={labels[choice]}
            onClick={() => setThemeChoice(choice)}
            onKeyDown={(event) => handleKey(event, index())}
          >
            <ThemeIcon choice={choice} />
          </button>
        )}</For>
      </div>
    </Show>
  );
}
