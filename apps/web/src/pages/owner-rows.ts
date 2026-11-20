import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

/**
 * The list, remove and recovery rules that the pairing sections share. Each owner is one visit. A change of owner
 * drops the rows, the pending action and the lock of the old owner, and a late answer of an old owner changes
 * nothing, so the new owner can act at once. After an uncertain remote remove, no control works until a read of
 * the same gateway works. The section keeps its own availability rule, texts and row rendering.
 */
export function createOwnerRows<Row>(options: {
  ownerId: Accessor<string | undefined>;
  /** A remote gateway can commit a remove before its answer fails, so only then the outcome is uncertain. */
  uncertainRemove: boolean;
  list: () => Promise<Row[]>;
  remove: (row: Row) => Promise<void>;
  /** True when a failed list read says that the gateway cannot hold these rows at all. */
  isUnavailable: (cause: unknown) => boolean;
  onAvailable: (available: boolean) => void;
  loadFailure: string;
  removeFailure: string;
}) {
  const [rows, setRows] = createSignal<Row[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [pending, setPending] = createSignal<string>();
  const [unavailable, setUnavailable] = createSignal(false);
  const [unknown, setUnknown] = createSignal(false);
  let requestId = 0;
  // Each owner change starts a new visit object. An answer compares it by reference, so a held request of an
  // earlier visit changes nothing, also when the same owner comes back.
  type Visit = { userId: string };
  let activeVisit: Visit | undefined;
  let disposed = false;
  onCleanup(() => { disposed = true; activeVisit = undefined; requestId++; });
  const current = (visit: Visit) => !disposed && activeVisit === visit;

  const refresh = async (visit: Visit): Promise<boolean> => {
    const currentRequest = ++requestId;
    setLoading(true);
    setError(undefined);
    try {
      const next = await options.list();
      if (!current(visit) || currentRequest !== requestId) return false;
      setRows(next);
      setUnavailable(false);
      options.onAvailable(true);
      return true;
    } catch (cause) {
      if (current(visit) && currentRequest === requestId) {
        setRows([]);
        // After a failed remote remove, an "unavailable" answer must not hide the error and Retry.
        if (options.isUnavailable(cause) && !unknown()) {
          setUnavailable(true);
          options.onAvailable(false);
        } else {
          setUnavailable(false);
          options.onAvailable(true);
          setError(cause instanceof Error ? cause.message : options.loadFailure);
        }
      }
      return false;
    } finally {
      if (current(visit) && currentRequest === requestId) setLoading(false);
    }
  };

  createEffect(() => {
    const userId = options.ownerId();
    if (userId === activeVisit?.userId) return;
    const visit: Visit | undefined = userId ? { userId } : undefined;
    activeVisit = visit;
    setRows([]);
    setError(undefined);
    setPending(undefined);
    setUnknown(false);
    setUnavailable(false);
    if (visit) void refresh(visit);
    else {
      requestId++;
      setLoading(false);
    }
  });

  const retry = async () => {
    const visit = activeVisit;
    if (!visit) return;
    const ok = await refresh(visit);
    if (current(visit) && ok) setUnknown(false);
  };

  /** `key` names the row in `pending`. */
  const remove = async (row: Row, key: string) => {
    const visit = activeVisit;
    if (!visit || unknown()) return;
    setPending(key);
    setError(undefined);
    let failed = false;
    try {
      await options.remove(row);
      if (current(visit)) await refresh(visit);
    } catch (cause) {
      failed = true;
      if (current(visit)) {
        setError(cause instanceof Error ? cause.message : options.removeFailure);
        // Lock the controls before `pending` clears, so no click starts another write while the recovery read runs.
        if (options.uncertainRemove) setUnknown(true);
      }
    } finally {
      if (current(visit)) setPending(undefined);
    }
    if (failed && options.uncertainRemove && current(visit)) {
      const message = error();
      const ok = await refresh(visit);
      // The lock stays until the same owner completes a successful read.
      if (current(visit)) {
        if (ok) setUnknown(false);
        if (message) setError(message);
      }
    }
  };

  return { rows, loading, error, pending, unavailable, unknown, retry, remove };
}
