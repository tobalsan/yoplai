import { useLocation } from "@solidjs/router";
import { createEffect, createResource, onCleanup } from "solid-js";
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import {
  fetchOnboarding,
  saveOnboarding,
  type OnboardingStatus,
} from "../api/onboarding";
import { capabilities, capabilitiesReady } from "../lib/capabilities";
import { stripBase } from "../lib/path";
import { TOUR_STEPS } from "./steps";
import { setTourStep, tourStep } from "./state";

const TARGET_WAIT_MS = 5000;

function waitForTarget(
  find: (() => Element | null) | null,
  onFound: (el: Element | null) => void
): () => void {
  if (!find) {
    onFound(null);
    return () => undefined;
  }
  let settleTimer: number | undefined;
  const found = (el: Element) => {
    // Wait until the target stops moving (e.g. chat composer re-centering)
    // so the popover appears once, in place.
    let last = "";
    let stable = 0;
    let ticks = 0;
    settleTimer = window.setInterval(() => {
      const now = JSON.stringify(el.getBoundingClientRect());
      stable = now === last ? stable + 1 : 0;
      last = now;
      if (stable >= 3 || ++ticks >= 30) {
        window.clearInterval(settleTimer);
        onFound(el);
      }
    }, 100);
  };
  const initial = find();
  if (initial) {
    found(initial);
    return () => window.clearInterval(settleTimer);
  }
  const observer = new MutationObserver(() => {
    const el = find();
    if (el) {
      observer.disconnect();
      window.clearTimeout(timer);
      found(el);
    }
  });
  const timer = window.setTimeout(() => {
    stop();
    onFound(null);
  }, TARGET_WAIT_MS);
  function stop() {
    window.clearInterval(settleTimer);
    observer.disconnect();
    window.clearTimeout(timer);
  }
  observer.observe(document.body, { childList: true, subtree: true });
  return stop;
}

function fillComposer(text: string): void {
  const composer = document.querySelector<HTMLTextAreaElement>(
    '[data-tour="composer"]'
  );
  if (!composer) return;
  composer.value = text;
  // ChatView listens to `input` to sync its signal; do not send the message.
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  composer.focus();
}

async function finish(status: OnboardingStatus): Promise<void> {
  setTourStep(null);
  try {
    await saveOnboarding(status);
  } catch {
    // Flag not saved; the tour may reappear next login.
  }
}

export function OnboardingTour() {
  const location = useLocation();
  const eligible = () =>
    capabilitiesReady() &&
    capabilities.multiUser === true &&
    Boolean(capabilities.user) &&
    !stripBase(location.pathname).startsWith("/login");
  const [state] = createResource(eligible, (ok) =>
    ok ? fetchOnboarding().catch(() => null) : null
  );

  // Start once per page load; later skips/finishes must not re-trigger it
  // from the stale fetched state.
  let autoStarted = false;
  createEffect(() => {
    const s = state();
    if (autoStarted || !s?.supported) return;
    autoStarted = true;
    // Server flag wins over a stale cached step (other tab/user finished it).
    if (s.status !== null) setTourStep(null);
    else if (tourStep() === null) setTourStep(0);
  });

  createEffect(() => {
    const index = tourStep();
    const path = stripBase(location.pathname);
    if (index === null || !state()?.supported) return;
    const step = TOUR_STEPS[index];
    if (!step || !step.route.test(path)) return;

    let active: Driver | undefined;
    let detachClick: (() => void) | undefined;
    let settle: number | undefined;
    const advance = () => {
      if (index + 1 >= TOUR_STEPS.length) void finish("done");
      else setTourStep(index + 1);
    };
    const stopWaiting = waitForTarget(
      step.target
        ? () => {
            // Retry until the page renders what prepare needs (e.g. tabs).
            step.prepare?.(document);
            return step.target!(document);
          }
        : null,
      (el) => {
        const clickOnly = step.advance === "click" && el !== null;
        // Expected target missing (e.g. no edit access): end gracefully
        // instead of advancing onto a route the user can't reach.
        const lost = step.target !== null && el === null;
        active = driver({
          allowClose: true,
          overlayClickBehavior: "close",
          stagePadding: 6,
          onDestroyStarted: () => void finish("skipped"),
        });
        if (clickOnly) {
          const onClick = () => advance();
          const onKey = (e: KeyboardEvent) => {
            const t = e.target as Element | null;
            if (e.key === "Enter" && !e.shiftKey && t?.closest('[data-tour="composer"]')) advance();
          };
          el.addEventListener("click", onClick, { once: true, capture: true });
          if (step.advanceOnEnter) document.addEventListener("keydown", onKey, true);
          detachClick = () => {
            el.removeEventListener("click", onClick, true);
            document.removeEventListener("keydown", onKey, true);
          };
        }
        active.highlight({
          element: el ?? undefined,
          popover: {
            side: step.side,
            align: step.side ? "start" : undefined,
            title: lost
              ? "That's the tour"
              : step.title.replace("{brand}", capabilities.branding?.name || "Yoplai"),
            description: lost
              ? "This part isn't available for you. Explore at your own pace; restart the tour anytime from the sidebar."
              : step.description,
            showButtons: clickOnly ? [] : ["next"],
            nextBtnText: lost ? "Finish" : (step.nextLabel ?? "Next"),
            onNextClick: () =>
              lost || step.advance === "done" ? void finish(lost ? "skipped" : "done") : advance(),
            onCloseClick: () => void finish("skipped"),
            onPopoverRender: (popover) => {
              // driver.js hides the footer when no buttons; keep Skip visible.
              popover.footer.style.display = "flex";
              if (clickOnly) popover.footerButtons.style.display = "none";
              if (step.suggestion && !lost) {
                const use = document.createElement("button");
                use.type = "button";
                use.textContent = "Use this";
                use.onclick = () => {
                  fillComposer(step.suggestion!);
                  advance();
                };
                popover.footerButtons.prepend(use);
              }
              if (step.advance !== "done" && !lost) {
                const skip = document.createElement("button");
                skip.type = "button";
                skip.className = "tour-skip";
                skip.textContent = step.skipLabel ?? "Skip tour";
                skip.onclick = () => void finish("skipped");
                popover.footer.prepend(skip);
              }
            },
          },
        });
        // Targets can shift after first paint (e.g. chat empty state
        // re-centers the composer); re-position while the layout settles.
        if (el) {
          let last = JSON.stringify(el.getBoundingClientRect());
          let ticks = 0;
          settle = window.setInterval(() => {
            const now = JSON.stringify(el.getBoundingClientRect());
            if (now !== last) {
              last = now;
              active?.refresh();
            }
            if (++ticks >= 30) window.clearInterval(settle);
          }, 100);
        }
      }
    );
    onCleanup(() => {
      window.clearInterval(settle);
      stopWaiting();
      detachClick?.();
      active?.destroy();
    });
  });

  return (
    <style>{`
      [data-tour="agent-edit"].driver-active-element { opacity: 1 !important; }
      .driver-popover .tour-skip { background: none; border: none; color: #87867f; cursor: pointer; font-size: 12px; padding: 0 8px 0 0; text-decoration: underline; }
    `}</style>
  );
}
