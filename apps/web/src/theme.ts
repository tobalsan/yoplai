import { createEffect, createSignal } from "solid-js";

export type Theme = "light" | "dark";

function getInitialTheme(): Theme {
  const stored = localStorage.getItem("yoplai-theme");
  if (stored === "light" || stored === "dark") return stored;
  const legacy = localStorage.getItem("aihub-theme");
  if (legacy === "light" || legacy === "dark") {
    localStorage.setItem("yoplai-theme", legacy);
    return legacy;
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

const [theme, setTheme] = createSignal<Theme>(getInitialTheme());

export { theme };

export function toggleTheme() {
  setTheme((t) => (t === "dark" ? "light" : "dark"));
}

createEffect(() => {
  const t = theme();
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("yoplai-theme", t);
});
