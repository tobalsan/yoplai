import { createEffect, createMemo, createSignal } from "solid-js";
import { readMigratedLocal } from "./lib/local-storage";

export type ThemeChoice = "light" | "dark" | "system";
const storageKey = "yoplai-theme";
const systemTheme = window.matchMedia?.("(prefers-color-scheme: light)");
const [systemLight, setSystemLight] = createSignal(systemTheme?.matches ?? false);

function parseChoice(value: string | null): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

const [themeChoice, setChoice] = createSignal(parseChoice(readMigratedLocal(storageKey)));
const theme = createMemo(() => {
  const choice = themeChoice();
  return choice === "system" ? systemLight() ? "light" : "dark" : choice;
});

export { theme, themeChoice };

export function setThemeChoice(choice: ThemeChoice) {
  setChoice(choice);
  try { localStorage.setItem(storageKey, choice); } catch { /* The current tab keeps the choice. */ }
}

const onSystemTheme = (event: MediaQueryListEvent) => setSystemLight(event.matches);
if (systemTheme?.addEventListener) systemTheme.addEventListener("change", onSystemTheme);
else systemTheme?.addListener?.(onSystemTheme);

function onStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== window.localStorage) return;
  if (event.key === storageKey || event.key === null) setChoice(parseChoice(event.newValue));
}
window.addEventListener("storage", onStorage);

import.meta.hot?.dispose(() => {
  if (systemTheme?.removeEventListener) systemTheme.removeEventListener("change", onSystemTheme);
  else systemTheme?.removeListener?.(onSystemTheme);
  window.removeEventListener("storage", onStorage);
});

createEffect(() => {
  const resolved = theme();
  document.documentElement.dataset.theme = resolved;
  document.cookie = `yoplai-theme=${resolved}; Path=/; SameSite=Lax; Max-Age=31536000`;
});
