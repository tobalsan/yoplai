A transient glass message with an icon, a title and one line of detail.

**When to use**
- Confirming an action finished or reporting a background failure.

**What you provide**
- `tone: "success" | "danger"`, `title: string`, `message?: string`
- `duration?: number`; errors should persist until dismissed
- Source: `apps/web/src/components/ui/Toast.tsx`

**Do**
- Use `role="status"` for success and `role="alert"` for `yp-toast--danger`.
- Keep the glass recipe on `elev-3` with `radius-md`; give success a `yp-check` icon (`pathLength="1"`) so the check draws itself.
- Rise 12px on `spring-snappy`, leave down at `dur-quick` via `data-leaving`, and slide siblings with FLIP. Name the agent and the next step.

**Don't**
- Don't use a toast for blocking decisions; use `yp-modal`.
- Don't rely on color alone; keep the icon and title.
- Don't stack more than three.
