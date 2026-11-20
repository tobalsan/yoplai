import { describe, expect, it } from "vitest";
import { LogBuffer } from "./log-buffer.js";

describe("LogBuffer", () => {
  it("keeps only the last lines", () => {
    const buffer = new LogBuffer(3);
    for (const line of ["1", "2", "3", "4", "5"]) buffer.push(line);
    expect(buffer.tail()).toEqual(["3", "4", "5"]);
  });
});
