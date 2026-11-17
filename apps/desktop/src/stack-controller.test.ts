import { describe, expect, it } from "vitest";
import { createStackController } from "./stack-controller.js";
import type { Stack, StackStart } from "./stack.js";

/** A fake start whose readiness the test controls. Counts stops. */
function fakeStarts() {
  const starts: { stops: number; finish: () => void; handle: StackStart }[] = [];
  const start = (): StackStart => {
    let finish = () => {};
    let cancel = () => {};
    const record = { stops: 0, finish: () => finish(), handle: undefined as unknown as StackStart };
    const ready = new Promise<Stack>((resolve, reject) => {
      finish = () =>
        resolve({
          uiUrl: "http://127.0.0.1:3000",
          uiOrigin: "http://127.0.0.1:3000",
          stop: async () => {
            record.stops += 1;
          },
        });
      cancel = () => reject(new Error("Start cancelled"));
    });
    record.handle = {
      ready,
      stop: async () => {
        record.stops += 1;
        cancel();
      },
    };
    starts.push(record);
    return record.handle;
  };
  return { starts, start };
}

describe("stack controller", () => {
  it("stops the children when quit comes during the ready wait", async () => {
    const { starts, start } = fakeStarts();
    const controller = createStackController(start);
    const starting = controller.restart().catch((err: Error) => err.message);
    await Promise.resolve();
    await controller.shutdown();
    expect(starts).toHaveLength(1);
    expect(starts[0].stops).toBe(1);
    expect(await starting).toBe("Start cancelled");
    expect(controller.current()).toBeNull();
  });

  it("waits for a pending old stop when quit comes during restart", async () => {
    let finishStop = () => {};
    let stopped = false;
    const old: Stack = {
      uiUrl: "http://127.0.0.1:3000",
      uiOrigin: "http://127.0.0.1:3000",
      stop: () =>
        new Promise<void>((resolve) => {
          finishStop = () => {
            stopped = true;
            resolve();
          };
        }),
    };
    const controller = createStackController(() => ({ ready: Promise.resolve(old), stop: async () => {} }));
    await controller.restart();
    const restarting = controller.restart().catch((err: Error) => err.message);
    await Promise.resolve();
    let shutDown = false;
    const shutdown = controller.shutdown().then(() => {
      shutDown = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(shutDown).toBe(false);
    finishStop();
    await shutdown;
    expect(stopped).toBe(true);
    expect(await restarting).toBe("Start cancelled");
  });

  it("gives one stack for two fast restart clicks", async () => {
    const { starts, start } = fakeStarts();
    const controller = createStackController(start);
    const first = controller.restart();
    const second = controller.restart();
    await Promise.resolve();
    starts[0].finish();
    const [a, b] = await Promise.all([first, second]);
    expect(starts).toHaveLength(1);
    expect(a).toBe(b);
    expect(controller.current()).toBe(a);
  });

  it("stops the old stack before a later restart", async () => {
    const { starts, start } = fakeStarts();
    const controller = createStackController(start);
    const first = controller.restart();
    await Promise.resolve();
    starts[0].finish();
    await first;
    const second = controller.restart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    starts[1].finish();
    await second;
    expect(starts[0].stops).toBe(1);
    expect(starts).toHaveLength(2);
  });

  it("does not start after shutdown", async () => {
    const { starts, start } = fakeStarts();
    const controller = createStackController(start);
    await controller.shutdown();
    await expect(controller.restart()).rejects.toThrow("Start cancelled");
    expect(starts).toHaveLength(0);
  });
});
