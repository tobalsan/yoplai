export function isDesktopWindow(): boolean {
  return /\bElectron\//.test(globalThis.navigator?.userAgent ?? "");
}

export function fadeInDesktopWindow(root: HTMLElement): void {
  const html = document.documentElement;
  if (!html.hasAttribute("data-desktop-first-screen")) return;
  const observer = new MutationObserver(showFirstScreen);

  function showFirstScreen(): void {
    if (!root.innerText.trim()) return;
    observer.disconnect();
    try {
      sessionStorage.setItem("yoplai:desktop-first-screen", "1");
    } catch {
      // The fade still works if the browser blocks storage.
    }
    const restore = () => html.removeAttribute("data-desktop-first-screen");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !root.animate) {
      restore();
      return;
    }
    const background = root.style.backgroundColor;
    root.style.backgroundColor = "var(--bg-base)";
    const finish = () => {
      root.style.backgroundColor = background;
      restore();
    };
    void root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease" }).finished.then(finish, finish);
  }

  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
  showFirstScreen();
}

const root = globalThis.document?.getElementById("root");
if (root) fadeInDesktopWindow(root);
