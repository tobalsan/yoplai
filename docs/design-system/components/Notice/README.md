An inline message on a quiet wash ground for info, warning or error. It sits on paper.

**When to use**
- Persistent context inside a page: limits, expiries, maintenance.

**What you provide**
- `tone?: "info" | "warning" | "danger" | "success"` (info default, `accent-wash`)
- `children`: one sentence, plus an optional action link

**Do**
- Say what happened and where to fix it.
- Use `yp-notice--danger` only for blocking problems.
- Place it near the thing it describes; `radius-md`, 12/16px padding, no border.

**Don't**
- Don't use a notice for confirmations; use `yp-toast`.
- Don't stack several notices on one screen.
- Don't use bright fills for passive info.
