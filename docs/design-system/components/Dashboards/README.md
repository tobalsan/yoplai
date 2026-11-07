The Dashboards page: the user-level list of dashboards your agents built for you or that others shared. A dashboard opens in a new tab.

**Rule: we design the list, never the agent-generated dashboard.** The dashboard itself is HTML an agent writes. Nothing here previews, frames or styles it.

**When to use**
- The "Dashboards" sidebar item. It replaces the chat in the same paper sheet (the sheet rises in); the header just reads "Dashboards". No title inside the sheet, no add button (agents create dashboards).
- Not the per-agent Dashboards panel in the chat cog menu: that one stays a panel inside the agent.

**What you provide**
- `owned` and `shared`: `{ id, title, agentId, agentName, ownerName, updatedAt, pinned, link, chatHref, params, shares | mode }[]`
- `onOpen` (new tab), `onChat`, `onPin(id)` (toggle), `onCopyLink`, `onManage(id)`, `onDelete(id)`
- Source: `apps/web/src/pages/Dashboards.tsx`, `DashboardListRow.tsx`, `DashboardAccessDialog.tsx`

**Scale pattern (many dashboards, several agents)**
- The toolbar comes first and never moves: filtering must not shift it under the cursor. Below it: "Pinned" (filtered like everything else), then ONE flat list. No per-agent sections.
- Toolbar, one calm row that wraps: search (title, agent, owner or sharer; matches in `mark` with accent-wash), a `yp-seg` scope switch All / Mine / Shared with faint counts, and multi-select agent chips (`yp-chip yp-skills__agent`: avatar, name, count). No chip selected means all agents. Over 6 agents: top 5 by count plus a "+N" chip opening a `yp-menu` with the rest; a chosen agent from the menu becomes a chip.
- Counts are live: each shows what a click would give under the other two filters. A chip at 0 is disabled.
- List sorted by last updated, grouped by quiet date labels (`yp-dash__date`: Today, Yesterday, This week, This month, Earlier). Each row: small agent avatar (`yp-dash__avatar`), title, meta "Connie · Owned by you · Nov 7" or "Sally · Shared by Thinh · Oct 19", access text (shared rows keep Can view / Can edit).
- Render 20 rows, then a quiet "Show 20 more" text button (`yp-dash__more-rows`); filter changes reset to 20. Rows that newly appear fade in (opacity and translate only, `data-new`); nothing else animates.
- States: no matches shows "No dashboards match “x”." with a "Clear filters" link (`yp-dash__clear`). No dashboards at all keeps the two empty lines below and hides the toolbar.
- The older per-agent grouping (small avatar and name heading over its rows) is only acceptable for a single agent's dashboards, as in the cog-menu panel: there the agent is implied and the list is short. Do not use it on this page.

**Do**
- Reuse the `yp-skills` page, section, label, count, list, row, search, agent-chip and empty classes. `yp-dash*` adds only the row content, toolbar and paging.
- Make the title the Open action: `yp-dash__open` stretches over the whole row. A dashboard that needs params has a plain title (no Open) and says "Needs region" in the meta.
- Show at most Chat and pin, plus "…" for owned rows. Pin is a toggle (`aria-pressed`, filled and ink when pinned); unpinned actions appear on hover or focus, always on touch. Every icon button has a `yp-tip` label.
- Put Copy link, Manage access, a separator, then Delete (`yp-menu__item--danger`) in the "…" `yp-menu`. Shared rows have no manage or delete: show Copy link as the last icon instead of "…".
- Show access as faint text with an icon: lock Private, globe Everyone, people "N people", eye Can view, pen Can edit.
- Meta line in faint small text, agent first: "Connie · Owned by you · Nov 7", "Sally · Shared by Thinh · Oct 19".
- Confirm Delete in a `yp-modal`: "Delete {title} and its published HTML and history? Shared databases are retained." Cancel and a `yp-btn--danger` Delete.
- Empty copy: "You do not own any dashboards yet." and "No dashboards have been shared with you."

**Don't**
- Don't render, thumbnail or restyle a dashboard's content.
- Don't use six inline text links, bordered cards or loud access pills.
- Don't repeat the page title inside the sheet.
