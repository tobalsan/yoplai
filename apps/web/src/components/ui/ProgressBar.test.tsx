// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { getByRole } from "@testing-library/dom";
import { ProgressBar } from "./ProgressBar";

let dispose: () => void;
afterEach(() => { dispose?.(); document.body.innerHTML = ""; });

it("announces a clamped, rounded percentage and the supplied tone", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const [percent, setPercent] = createSignal(-10);
  const [tone, setTone] = createSignal<"normal" | "warning" | "critical">("normal");
  dispose = render(() => <ProgressBar percent={percent()} tone={tone()} label="Weekly window" />, container);
  const bar = getByRole(container, "progressbar", { name: "Weekly window" });
  expect(bar.getAttribute("aria-valuemin")).toBe("0");
  expect(bar.getAttribute("aria-valuemax")).toBe("100");
  expect(bar.getAttribute("aria-valuenow")).toBe("0");
  expect(bar.getAttribute("data-tone")).toBe("normal");
  setPercent(125); setTone("critical");
  expect(bar.getAttribute("aria-valuenow")).toBe("100");
  expect(bar.getAttribute("data-tone")).toBe("critical");
  setPercent(75.6); setTone("warning");
  expect(bar.getAttribute("aria-valuenow")).toBe("76");
  expect(bar.getAttribute("data-tone")).toBe("warning");
});
