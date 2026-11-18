import { createSignal, onCleanup, onMount } from "solid-js";

const radius = 35;
export const eyeHalfGap = radius * .29;
export const eyeRx = radius * .184;
export const eyeRy = radius * .316;
const travel = radius - Math.hypot(eyeHalfGap, 0) - eyeRy - 1;
export const eyeOffset = (x: number, y: number) => {
  const scale = Math.max(1, Math.abs(x), Math.abs(y));
  x /= scale;
  y /= scale;
  const denominator = Math.max(1 / scale, Math.hypot(x, y));
  return { x: travel * x / denominator, y: travel * y / denominator };
};

export function AgentMark(props: { side?: boolean }) {
  let svg!: SVGSVGElement;
  const rest = () => props.side ? eyeOffset(-1, .5) : eyeOffset(0, .16);
  const [offset, setOffset] = createSignal(rest());
  onMount(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let target = rest();
    let frame = 0;
    const draw = () => {
      frame = 0;
      const current = offset();
      const dx = target.x - current.x;
      const dy = target.y - current.y;
      if (Math.hypot(dx, dy) < .05) setOffset(target);
      else {
        setOffset({ x: current.x + dx * .18, y: current.y + dy * .18 });
        frame = requestAnimationFrame(draw);
      }
    };
    const move = (event: MouseEvent) => {
      if (motion?.matches) return;
      const box = svg.getBoundingClientRect();
      target = eyeOffset((event.clientX - box.left - box.width / 2) / 160, (event.clientY - box.top - box.height / 2) / 160);
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const leave = () => {
      target = rest();
      if (!motion?.matches && !frame) frame = requestAnimationFrame(draw);
    };
    const change = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      target = rest();
      setOffset(target);
    };
    window.addEventListener("mousemove", move);
    document.documentElement.addEventListener("mouseleave", leave);
    window.addEventListener("blur", leave);
    motion?.addEventListener("change", change);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", move);
      document.documentElement.removeEventListener("mouseleave", leave);
      window.removeEventListener("blur", leave);
      motion?.removeEventListener("change", change);
    });
  });
  return <svg ref={svg} class="setup-mark" viewBox="-35 -35 70 70" aria-hidden="true">
    <circle r={radius} fill="white" />
    <g transform={`translate(${offset().x} ${offset().y})`} fill="black">
      <ellipse cx={-eyeHalfGap} rx={eyeRx} ry={eyeRy} />
      <ellipse cx={eyeHalfGap} rx={eyeRx} ry={eyeRy} />
    </g>
  </svg>;
}

export function Wordmark() {
  return <svg viewBox="0 -4 1165 246" role="img" aria-label="Yoplai" fill="white">
    <path fill-rule="evenodd" d="M0 0H79L118 69L157 0H236L153 135V238H83V135Z M197.5 119A123 123 0 1 0 443.5 119A123 123 0 1 0 197.5 119Z M269.5 119A51 51 0 1 0 371.5 119A51 51 0 1 0 269.5 119Z M451 0H548A83.5 83.5 0 0 1 548 167H521V238H451Z M521 67H545A18.5 18.5 0 0 1 545 104H521Z M640 0H710V169H767V238H640Z M852 0H926L1005 238H934L922 198H856L844 238H773Z M889 87L907 143H871Z M1008 0H1078V238H1008Z" />
    <circle cx="1130" cy="203" r="35" />
  </svg>;
}
