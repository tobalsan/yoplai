import { expect, it } from "vitest";
import { eyeHalfGap, eyeOffset, eyeRx, eyeRy } from "./Marks";

it("keeps both eyes inside the circle for near and far pointer positions", () => {
  let farthest = 0;
  for (let direction = 0; direction < 360; direction += 5) {
    const angle = direction * Math.PI / 180;
    for (const distance of [0, .2, 1, 30, Number.MAX_VALUE]) {
      const offset = eyeOffset(distance * Math.cos(angle), distance * Math.sin(angle));
      for (const side of [-1, 1]) {
        for (let point = 0; point < Math.PI * 2; point += .08) {
          farthest = Math.max(farthest, Math.hypot(offset.x + side * eyeHalfGap + eyeRx * Math.cos(point), offset.y + eyeRy * Math.sin(point)));
        }
      }
    }
  }
  expect(farthest).toBeLessThan(35);
});
