// Shared by sql.ts and the forked sql-worker.ts. Type-only: no runtime imports.
export type DashboardQueryRequest = {
  root: string;
  rootDev: number;
  rootIno: number;
  snapshotParent: string;
  snapshotParentDev: number;
  snapshotParentIno: number;
  snapshotDirectory: string;
  snapshotDev: number;
  snapshotIno: number;
  database: string;
  sql: string;
  bindings: Record<string, string | null>;
  rowLimit: number;
  resultByteLimit: number;
};

/** One row edit or add, already validated and encoded by the gateway. */
export type DashboardEditRequest = {
  root: string;
  /** Identity of the root the gateway resolved; the worker refuses a swap. */
  rootDev: number;
  rootIno: number;
  database: string;
  table: string;
  key: string;
  updatedAt?: string;
  at: string;
  audit: {
    dashboardId: string;
    userId: string;
    email: string | null;
    name: string | null;
    edit: string;
  };
} & (
  | {
      op: "edit";
      keyValue: string | number;
      field: string;
      value: unknown;
      /** Set when the actor is not a writer: the row guard to check first. */
      guard?: { sql: string; bindings: Record<string, string | number | null> };
    }
  | { op: "add"; values: Record<string, unknown>; fields: string[] }
);

export type DashboardEditResponse =
  | { ok: true; value?: unknown; key?: number; values?: Record<string, unknown> }
  | { ok: false; status: 400 | 403 | 404 | 503; error: string };
