export function isDesktopWindow(): boolean {
  return /\bElectron\//.test(globalThis.navigator?.userAgent ?? "");
}

function fadeInDesktopWindow(): void {
  if (!isDesktopWindow() || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const root = document.getElementById("root");
  if (!root || !root.animate) return;
  const surfaces = [document.documentElement, document.body];
  const colors = surfaces.map((element) => element.style.backgroundColor);
  for (const element of surfaces) element.style.backgroundColor = "#000";
  const restore = () => surfaces.forEach((element, index) => { element.style.backgroundColor = colors[index]; });
  void root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease" }).finished.then(restore, restore);
}

fadeInDesktopWindow();
