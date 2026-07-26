import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTAINER_EVENT_PREFIX,
  CONTAINER_OUTPUT_END,
  CONTAINER_OUTPUT_START,
} from "@yoplai/shared";
import {
  ContainerProtocolDecoder,
  getMeaningfulStderr,
  parseProtocolOutput,
} from "./protocol.js";

describe("container protocol", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts legacy AIHUB markers from pre-rename container images and warns once", () => {
    // Spelled out literally (not imported from the LEGACY_CONTAINER_* constants)
    // so that changing those constants' values can't silently break decoding of
    // the actual wire bytes a pre-rename container image emits.
    const legacyEventPrefix = "---AIHUB_EVENT---";
    const legacyOutputStart = "---AIHUB_OUTPUT_START---";
    const legacyOutputEnd = "---AIHUB_OUTPUT_END---";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const legacyDecoder = new ContainerProtocolDecoder();
    const event = { type: "assistant_text", text: "hi", timestamp: 1 };

    const legacyFrames = legacyDecoder.write(
      `${legacyEventPrefix}${JSON.stringify(event)}\n`
    );

    legacyDecoder.write(
      `${legacyOutputStart}\n${JSON.stringify({
        text: "done",
      })}\n${legacyOutputEnd}\n`
    );

    const newDecoder = new ContainerProtocolDecoder();
    const newFrames = newDecoder.write(
      `${CONTAINER_EVENT_PREFIX}${JSON.stringify(event)}\n`
    );
    newDecoder.write(
      `${CONTAINER_OUTPUT_START}\n${JSON.stringify({
        text: "done",
      })}\n${CONTAINER_OUTPUT_END}\n`
    );

    expect(legacyFrames).toEqual(newFrames);
    expect(legacyDecoder.parseOutput()).toEqual(newDecoder.parseOutput());
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/legacy.*AIHUB.*markers/i);
  });

  it("decodes split event frames and final output", () => {
    const decoder = new ContainerProtocolDecoder();
    const event = { type: "assistant_text", text: "hi", timestamp: 1 };
    const line = `${CONTAINER_EVENT_PREFIX}${JSON.stringify(event)}\n`;

    expect(decoder.write(line.slice(0, 12))).toEqual([]);
    expect(decoder.write(line.slice(12))).toEqual([
      { type: "event", payload: JSON.stringify(event) },
    ]);

    decoder.write(
      `${CONTAINER_OUTPUT_START}\n${JSON.stringify({
        text: "done",
      })}\n${CONTAINER_OUTPUT_END}\n`
    );

    expect(decoder.parseOutput()).toEqual({ text: "done" });
  });

  it("flushes a final unterminated event line", () => {
    const decoder = new ContainerProtocolDecoder();
    const event = { type: "assistant_text", text: "tail", timestamp: 1 };

    decoder.write(`${CONTAINER_EVENT_PREFIX}${JSON.stringify(event)}`);

    expect(decoder.flush()).toEqual([
      { type: "event", payload: JSON.stringify(event) },
    ]);
  });

  it("parses output blocks and filters benign runner stderr", () => {
    expect(parseProtocolOutput([JSON.stringify({ text: "ok" })])).toEqual({
      text: "ok",
    });
    expect(
      getMeaningfulStderr(
        "[agent-runner] Running agent cloud with SDK pi\nreal error\n"
      )
    ).toBe("real error");
  });
});
