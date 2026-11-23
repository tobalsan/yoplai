const tau = Math.PI * 2;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const orbits = [
  { radius: 0.86, flatten: 0.30, tilt: -0.32, speed: 1.25, at: 0.3 },
  { radius: 1.10, flatten: 0.26, tilt: 0.38, speed: -0.9, at: 7 },
  { radius: 1.36, flatten: 0.22, tilt: 1.18, speed: 0.7, at: 20 },
];
const seeds = (count: number) => Array.from({ length: count }, () => ({
  angle: Math.random() * tau, offset: Math.random(), size: Math.random(),
}));

export function startCraftingScene(canvas: HTMLCanvasElement, started: number, doneAt: () => number | undefined, tint: () => string | undefined) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const streaks = seeds(64), sparks = seeds(14), shards = seeds(26);
  let width = 0, height = 0, size = 0;
  let ink = "white";
  let frame: number;
  const resize = () => {
    const ratio = Math.min(devicePixelRatio, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    size = Math.min(220, Math.max(96, Math.min(width * 0.15, height * 0.2)));
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ink = getComputedStyle(canvas).color;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  const theme = new MutationObserver(() => { ink = getComputedStyle(canvas).color; });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.addEventListener("resize", resize);
  resize();
  const star = (x: number, y: number, radius: number, rotation: number) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rotation); ctx.beginPath();
    ctx.moveTo(radius, 0);
    for (let i = 1; i <= 4; i++) {
      const angle = i * tau / 4;
      ctx.quadraticCurveTo(0, 0, Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    ctx.fill(); ctx.restore();
  };
  const draw = (now: number) => {
    const t = (now - started) / 1000;
    const finish = doneAt();
    const u = finish === undefined ? -1 : Math.max(0, (now - finish) / 1000);
    const wait = finish === undefined ? t : (finish - started) / 1000;
    const phase = wait < 7 ? 0 : wait < 20 ? 1 : 2;
    const edge = Math.hypot(width, height) * 0.52;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2, height * 0.38);
    ctx.strokeStyle = ctx.fillStyle = ink;
    ctx.lineCap = "round";
    const rush = u < 0 ? 0 : u * 1.55;
    for (const [index, streak] of streaks.entries()) {
      if (index >= [26, 44, 64][phase]) break;
      const age = ((wait * 0.48 + streak.offset) % 1) + rush;
      if (age >= 1) continue;
      const radius = size * 0.29 + edge * (1 - age ** 2);
      const angle = streak.angle + age ** 2 * 0.8;
      const tail = radius + (3 + 16 * age) * (0.45 + streak.size);
      ctx.globalAlpha = Math.min(1, age * 5, (1 - age) * 15) * (0.24 + age * 0.5);
      ctx.lineWidth = 0.8 + streak.size;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle - 0.016) * tail, Math.sin(angle - 0.016) * tail);
      ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      ctx.stroke();
    }
    for (const orbit of orbits) {
      const reveal = clamp((wait - orbit.at) / 1.1);
      const collapse = u < 0 ? 1 : 1 - clamp(u / 0.5) ** 2;
      if (!reveal || !collapse) continue;
      const radius = orbit.radius * size * collapse;
      const tilt = orbit.tilt + 0.12 * Math.sin(t * 0.35 + orbit.radius * 4);
      const start = orbit.radius * 5, span = reveal * tau;
      ctx.save(); ctx.rotate(tilt);
      ctx.globalAlpha = 0.28 * collapse; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(0, 0, radius, radius * orbit.flatten, 0, start, start + span); ctx.stroke();
      for (let i = 0; i < 2; i++) {
        const angle = ((t * orbit.speed + i * Math.PI) % tau + tau) % tau;
        if (angle > span) continue;
        const x = radius * Math.cos(start + angle), y = radius * orbit.flatten * Math.sin(start + angle);
        ctx.globalAlpha = (i ? 0.48 : 0.94) * collapse;
        ctx.beginPath(); ctx.arc(x, y, i ? 2.2 : 3.6, 0, tau); ctx.fill();
      }
      ctx.restore();
    }
    if (phase === 2 && u < 0) {
      for (const spark of sparks) {
        const age = (t * 0.43 + spark.offset) % 1;
        if (age > 0.38) continue;
        ctx.globalAlpha = Math.sin(age / 0.38 * Math.PI) * 0.88;
        const radius = size * (0.55 + spark.size * 0.35);
        star(Math.cos(spark.angle) * radius, Math.sin(spark.angle) * radius, 3 + 8 * spark.size, age);
      }
    }
    if (u >= 0.35) {
      const age = u - 0.35;
      ctx.globalAlpha = 0.6 * (1 - clamp(age / 0.82)); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, size * 0.45 + edge * (1 - (1 - clamp(age)) ** 3), 0, tau); ctx.stroke();
      const shardTint = tint();
      shards.forEach((shard, index) => {
        const distance = (size * 0.26 + (220 + 340 * shard.size) * age) / (1 + age);
        ctx.globalAlpha = 1 - clamp(age / (0.55 + shard.offset * 0.4));
        ctx.fillStyle = index % 3 === 0 && shardTint ? `rgb(${shardTint})` : ink;
        star(Math.cos(shard.angle) * distance, Math.sin(shard.angle) * distance + 35 * age ** 2,
          (4 + 6 * shard.size) * (1 - age * 0.55), shard.angle + age * 3);
      });
    }
    ctx.restore();
    if (u < 1.25) frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", resize);
    theme.disconnect();
    ctx.clearRect(0, 0, width, height);
  };
}
