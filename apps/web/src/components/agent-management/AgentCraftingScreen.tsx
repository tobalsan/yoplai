import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { avatarFaceUrl } from "../../lib/default-avatar";
import { startCraftingScene } from "./crafting-scene";
import "./agent-crafting.css";

const LINES = [
  [
    "Warming up the alpha reactors",
    "Initiating multiphase capacitors",
    "Unpacking a fresh box of neurons",
    "Calibrating the curiosity dial",
    "Reading your purpose twice, just to be sure",
    "Untangling the token spaghetti",
    "Dusting off the thinking cap",
    "Spinning up the idea centrifuge",
  ],
  [
    "Dispatching star propellers into position",
    "Weaving the personality matrix",
    "Hand-stitching the instructions",
    "Aligning the helpfulness gyroscopes",
    "Folding the rules into tiny origami",
    "Distilling your purpose into pure intent",
    "Installing a sense of humor (beta)",
    "Teaching {name} its own name",
    "Tuning the opinion engine to calm-but-firm",
    "Charging the quantum to-do list",
  ],
  [
    "Applying a second coat of charm",
    "Sanding down the rough edges",
    "Tightening the last few bolts",
    "Teaching {name} to say hello",
    "Fluffing the cushions of the context window",
    "Checking under the hood one last time",
    "Brewing a fresh pot of first impressions",
    "Signing the certificate of awesomeness",
    "Polishing {name} until it sparkles",
    "Almost there, adjusting the bow tie",
  ],
];

const phaseStarts = [0, 7, 20];
const phaseLabels = ["Preparing", "Crafting", "Final touches"];
const phaseOf = (seconds: number) => seconds < 7 ? 0 : seconds < 20 ? 1 : 2;
const motionQuery = "(prefers-reduced-motion: reduce)";

export async function finishCrafting(markDone: (time: number) => void) {
  markDone(performance.now());
  if (!window.matchMedia?.(motionQuery).matches) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1250));
  }
}

function avatarTint(image: HTMLImageElement) {
  const sample = document.createElement("canvas");
  sample.width = sample.height = 24;
  const ctx = sample.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  try {
    ctx.drawImage(image, 0, 0, 24, 24);
    const data = ctx.getImageData(0, 0, 24, 24).data;
    let red = 0, green = 0, blue = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 220) continue;
      red += data[i]; green += data[i + 1]; blue += data[i + 2]; count++;
    }
    if (count) return `${red / count} ${green / count} ${blue / count}`;
  } catch {
    return undefined;
  }
}

export function AgentCraftingScreen(props: { name: string; face: number; file?: File; doneAt?: number }) {
  let dialog!: HTMLDialogElement;
  let canvas!: HTMLCanvasElement;
  const started = performance.now();
  const [seconds, setSeconds] = createSignal(0);
  const [tint, setTint] = createSignal<string>();
  const [imageUrl, setImageUrl] = createSignal<string>();
  const offsets = LINES.map((phrases) => Math.floor(Math.random() * phrases.length));
  const phase = createMemo(() => phaseOf(seconds()));
  const line = createMemo(() => {
    const index = phase();
    const phrases = LINES[index];
    return phrases[(offsets[index] + Math.floor((seconds() - phaseStarts[index]) / 2.7)) % phrases.length].replaceAll("{name}", () => props.name);
  });
  const done = () => props.doneAt !== undefined;
  const status = createMemo(() => done() ? "Opening your first chat" : line());
  const [outgoing, setOutgoing] = createSignal<string>();
  createEffect(on(status, (_, previous) => setOutgoing(previous)));
  const progress = (index: number) => done() ? 1 : Math.min(1, Math.max(0, index === 2
    ? 0.9 * (1 - Math.exp(-(seconds() - 20) / 14))
    : (seconds() - phaseStarts[index]) / (phaseStarts[index + 1] - phaseStarts[index])));

  onMount(() => {
    if (props.file && typeof URL.createObjectURL === "function") {
      const url = URL.createObjectURL(props.file);
      setImageUrl(url);
      onCleanup(() => URL.revokeObjectURL(url));
    }
    if (dialog.showModal) {
      dialog.showModal();
      onCleanup(() => dialog.close());
    } else dialog.open = true;
    const timer = setInterval(() => setSeconds(((props.doneAt ?? performance.now()) - started) / 1000), 100);
    onCleanup(() => clearInterval(timer));
    const motion = window.matchMedia?.(motionQuery);
    const [reduced, setReduced] = createSignal(motion?.matches ?? false);
    const updateMotion = () => setReduced(motion?.matches ?? false);
    motion?.addEventListener("change", updateMotion);
    onCleanup(() => motion?.removeEventListener("change", updateMotion));
    createEffect(() => {
      if (!reduced()) onCleanup(startCraftingScene(canvas, started, () => props.doneAt, tint));
    });
  });

  return <dialog ref={dialog} class="agent-crafting" aria-label="Agent creation" onCancel={(event) => event.preventDefault()}
    classList={{ "agent-crafting-done": done() }} style={{ "--craft-tint": tint() }}>
    <canvas ref={canvas} aria-hidden="true" />
    <div class="agent-crafting-avatar" aria-hidden="true">
      <img src={imageUrl() ?? avatarFaceUrl(props.face)} classList={{ "craft-upload": !!imageUrl() }} alt=""
        onLoad={(event) => setTint(avatarTint(event.currentTarget))} onError={() => setImageUrl(undefined)} />
    </div>
    <div class="agent-crafting-drag" aria-hidden="true" />
    <div class="agent-crafting-copy">
      <div role="status" aria-live="polite">
        <h1>{done() ? `${props.name} is ready.` : `Crafting ${props.name}`}</h1>
        <div class="agent-crafting-status">
          <Show when={outgoing()} keyed>{(text) =>
            <span class="agent-crafting-outgoing" aria-hidden="true">{text}</span>
          }</Show>
          <Show when={status()} keyed>{(text) =>
            <span class="agent-crafting-line">{text}<Show when={!done()}>
              <span class="agent-crafting-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
            </Show></span>
          }</Show>
        </div>
      </div>
      <div class="agent-crafting-phases">
        <For each={phaseLabels}>{(label, index) => <div classList={{ "craft-active": done() || index() <= phase() }}>
          <div class="agent-crafting-bar" aria-hidden="true"><i style={{ transform: `scaleX(${progress(index())})` }} /></div>
          <span>{label}</span>
        </div>}</For>
      </div>
    </div>
  </dialog>;
}
