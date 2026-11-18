// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
});

it.each([["Electron/45", false, true], ["Chrome/146", false, false], ["Electron/45", true, false]])(
  "fades the light theme with %s and reduced motion %s: %s", async (userAgent, reducedMotion, fades) => {
    vi.resetModules();
    vi.stubGlobal("navigator", { userAgent });
    vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
    document.body.innerHTML = '<style>html, body { background: #f5f5f5 }</style><div id="root"></div>';
    const root = document.getElementById("root")!;
    const animation = Promise.withResolvers<void>();
    root.animate = vi.fn().mockReturnValue({ finished: animation.promise });
    await import("../../web/src/lib/desktop-window.js");
    if (fades) {
      expect(root.animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: 200 }));
      expect(window.getComputedStyle(document.documentElement).backgroundColor).toBe("rgb(0, 0, 0)");
      expect(window.getComputedStyle(document.body).backgroundColor).toBe("rgb(0, 0, 0)");
    } else {
      expect(root.animate).not.toHaveBeenCalled();
    }
    animation.resolve();
    await animation.promise;
    expect(window.getComputedStyle(document.body).backgroundColor).toBe("rgb(245, 245, 245)");
  },
);
