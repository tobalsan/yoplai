import { Show, createSignal, onCleanup } from "solid-js";
import type { DashboardRow } from "../api/dashboards";

type RowDashboard = Pick<DashboardRow,
  "link" | "title" | "params" | "legacy" | "isOwner" | "ownerName" | "mode" | "updatedAt" | "publishedAt"
> & Partial<Pick<DashboardRow, "shared" | "shares" | "agentName" | "pinned">>;

export function ownershipLabel(dashboard: Pick<RowDashboard, "legacy" | "isOwner" | "shared" | "ownerName">) {
  if (dashboard.isOwner) return "Owned by you";
  if (dashboard.legacy) return "Not claimed";
  const owner = dashboard.ownerName ?? "Unknown user";
  return dashboard.shared ? `Shared by ${owner}` : `Owned by ${owner}`;
}

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

type Access = { label: string; title?: string; icon: string; shared: boolean };

function sharingSummary(shares: NonNullable<RowDashboard["shares"]>): Access {
  if (shares.some((share) => share.kind === "all")) return { label: "Everyone", title: "Everyone on the platform", icon: "fa-globe", shared: true };
  if (shares.length === 0) return { label: "Private", icon: "fa-lock", shared: false };
  return { label: shares.length === 1 ? "1 person" : `${shares.length} people`, icon: "fa-user-group", shared: true };
}

function accessOf(dashboard: RowDashboard): Access | undefined {
  if (dashboard.isOwner) return sharingSummary(dashboard.shares ?? []);
  if (dashboard.legacy) return undefined;
  return dashboard.mode === "write"
    ? { label: "Can edit", icon: "fa-pen", shared: true }
    : { label: "Can view", icon: "fa-eye", shared: false };
}

export function DashboardListActions(props: {
  dashboard: RowDashboard;
  onManage?: () => void;
  onClaim?: () => void;
  onDelete?: () => void;
  /** Keeps an empty Delete column so rows without Delete stay aligned. */
  reserveDelete?: boolean;
  onPin?: () => void;
  pinPending?: boolean;
}) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(new URL(props.dashboard.link, window.location.origin).href);
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const canManage = () => props.dashboard.isOwner && !!props.onManage;
  const canClaim = () => props.dashboard.legacy && !!props.onClaim;
  const canDelete = () => props.dashboard.isOwner && !!props.onDelete;
  return (
    <div class="dashboard-list-row__actions">
      <Show when={props.onPin}>
        <span class="dashboard-slot dashboard-slot--pin">
          <button type="button" class="dashboard-action dashboard-action--pin"
            aria-label={props.dashboard.pinned ? "Unpin" : "Pin"}
            title={props.dashboard.pinned ? "Unpin" : "Pin"}
            aria-pressed={!!props.dashboard.pinned} disabled={props.pinPending} onClick={props.onPin}>
            <i class="fa-solid fa-thumbtack" aria-hidden="true" />
          </button>
        </span>
      </Show>
      <span class="dashboard-slot dashboard-slot--open" classList={{ "dashboard-slot--empty": props.dashboard.params.length > 0 }}>
        <Show when={props.dashboard.params.length === 0}>
          <a class="dashboard-action" href={props.dashboard.link} target="_blank" rel="noopener noreferrer">
            <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true" />Open
          </a>
        </Show>
      </span>
      <span class="dashboard-slot dashboard-slot--copy">
        <button type="button" class="dashboard-action" onClick={() => void copy()}>
          <i class={copied() ? "fa-solid fa-check" : "fa-solid fa-link"} aria-hidden="true" />
          {copied() ? "Copied" : "Copy link"}
        </button>
      </span>
      <span class="dashboard-slot dashboard-slot--manage" classList={{ "dashboard-slot--empty": !canManage() && !canClaim() }}>
        <Show when={canClaim()}>
          <button type="button" class="dashboard-action" onClick={props.onClaim}>
            <i class="fa-solid fa-hand" aria-hidden="true" />Claim
          </button>
        </Show>
        <Show when={canManage()}>
          <button type="button" class="dashboard-action" onClick={props.onManage}>
            <i class="fa-solid fa-user-lock" aria-hidden="true" />Manage access
          </button>
        </Show>
      </span>
      <Show when={canDelete() || props.reserveDelete || props.onDelete}>
        <span class="dashboard-slot dashboard-slot--delete" classList={{ "dashboard-slot--empty": !canDelete() }}>
          <Show when={canDelete()}>
            <button type="button" class="dashboard-action dashboard-action--danger" onClick={props.onDelete}>
              <i class="fa-solid fa-trash" aria-hidden="true" />Delete
            </button>
          </Show>
        </span>
      </Show>
      <style>{`
        .dashboard-list-row { container-type: inline-size; border-bottom: 1px solid var(--border-subtle); }
        .dashboard-list-row__grid { display: grid; grid-template-columns: minmax(0, 1fr) 112px auto; align-items: center; column-gap: 16px; row-gap: 6px; padding: 12px 0; }
        .dashboard-list-row__text { min-width: 0; }
        .dashboard-list-row__text strong { display: block; font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; }
        .dashboard-list-row__meta { display: block; margin-top: 2px; font-size: 12px; color: var(--text-secondary); }
        .dashboard-list-row__access { display: flex; }
        .dashboard-access-pill { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border: 1px solid var(--border-default); border-radius: 999px; background: var(--bg-raised); color: var(--text-secondary); font-size: 11px; font-weight: 550; line-height: 1; white-space: nowrap; }
        .dashboard-access-pill i { font-size: 10px; }
        .dashboard-access-pill--shared { border-color: color-mix(in srgb, var(--accent, #3b82f6) 35%, transparent); background: color-mix(in srgb, var(--accent, #3b82f6) 12%, transparent); color: color-mix(in srgb, var(--accent, #3b82f6) 75%, var(--text-primary)); }
        .dashboard-list-row__actions { display: flex; align-items: center; gap: 4px; }
        .dashboard-slot { display: flex; }
        .dashboard-slot--open { width: 72px; }
        .dashboard-slot--copy { width: 100px; }
        .dashboard-slot--manage { width: 140px; }
        .dashboard-slot--delete { width: 80px; }
        .dashboard-action { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 13px; text-decoration: none; white-space: nowrap; cursor: pointer; }
        .dashboard-action i { font-size: 12px; }
        .dashboard-action:hover { background: var(--bg-raised); color: var(--text-primary); }
        .dashboard-action:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: 1px; }
        .dashboard-action--danger { color: var(--color-danger, #dc2626); }
        .dashboard-action--danger:hover { color: var(--color-danger, #dc2626); background: color-mix(in srgb, var(--color-danger, #dc2626) 12%, transparent); }
        .dashboard-action--pin { justify-content: center; width: 40px; height: 40px; padding: 0; }
        .dashboard-action--pin[aria-pressed="true"] { color: var(--accent, #3b82f6); background: var(--accent-bg, rgba(59, 130, 246, 0.14)); }
        .dashboard-action--pin:active:not(:disabled) { background: var(--bg-raised); }
        .dashboard-action--pin:disabled { opacity: 0.5; cursor: wait; }
        @container (max-width: 640px) {
          .dashboard-list-row__grid { grid-template-columns: minmax(0, 1fr) auto; }
          .dashboard-list-row__actions { grid-column: 1 / -1; flex-wrap: wrap; margin-left: -10px; }
          .dashboard-slot { width: auto; }
          .dashboard-slot--empty { display: none; }
        }
      `}</style>
    </div>
  );
}

export function DashboardListRow(props: {
  dashboard: RowDashboard;
  showAgent?: boolean;
  onManage?: () => void;
  onClaim?: () => void;
  onDelete?: () => void;
  reserveDelete?: boolean;
  onPin?: () => void;
  pinPending?: boolean;
}) {
  const meta = () => {
    const dashboard = props.dashboard;
    const parts = [ownershipLabel(dashboard)];
    const when = dashboard.updatedAt ?? dashboard.publishedAt;
    if (when) parts.push(dateFormat.format(new Date(when)));
    if (props.showAgent && dashboard.agentName) parts.push(dashboard.agentName);
    if (dashboard.params.length) parts.push(`Needs ${dashboard.params.join(", ")}`);
    return parts.join(" · ");
  };
  return (
    <div class="dashboard-list-row">
      <div class="dashboard-list-row__grid">
        <div class="dashboard-list-row__text">
          <strong>{props.dashboard.title}</strong>
          <span class="dashboard-list-row__meta">{meta()}</span>
        </div>
        <div class="dashboard-list-row__access">
          <Show when={accessOf(props.dashboard)}>{(access) => (
            <span class="dashboard-access-pill" classList={{ "dashboard-access-pill--shared": access().shared }} title={access().title}>
              <i class={`fa-solid ${access().icon}`} aria-hidden="true" />{access().label}
            </span>
          )}</Show>
        </div>
        <DashboardListActions dashboard={props.dashboard} onManage={props.onManage} onClaim={props.onClaim} onDelete={props.onDelete} reserveDelete={props.reserveDelete} onPin={props.onPin} pinPending={props.pinPending} />
      </div>
    </div>
  );
}
