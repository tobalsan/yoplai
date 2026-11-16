import { createMemo, type Accessor } from "solid-js";

type KeyObject = Record<string, string | boolean | undefined>;

/**
 * A resource source that returns a new object on each read starts a new request
 * each time. This key keeps the old object while all of its fields stay equal.
 */
export function createResourceKey<T extends KeyObject | null>(read: () => T): Accessor<T> {
  return createMemo(read, undefined, {
    equals: (previous, next) =>
      previous === next ||
      (!!previous && !!next && Object.keys(previous).length === Object.keys(next).length && Object.entries(previous).every(([name, value]) => next[name] === value)),
  });
}
