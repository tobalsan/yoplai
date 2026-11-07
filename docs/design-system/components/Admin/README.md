The Admin page: five tabs (Users, Extensions, MCP servers, Skills, Quota) in one paper sheet. Every tab is rows under one muted line; nothing is a five-column table.

**When to use**
- The "Admin" sidebar item. It replaces the chat in the same paper sheet; the header just reads "Admin". No eyebrow, no big heading, no second title per tab.
- Tabs are a `yp-seg--field` with `role="tablist"` at the top of the sheet, then ONE muted description line, then the tab's toolbar and list.
- Superadmin sees all five tabs. A plain admin sees Users only, without the role select or View as (superadmin-only).

**What you provide**
- Users: `{ id, name, email, role: "user" | "admin" | "superadmin", approved, createdAt, image? }[]`, the session user id, `onApprove(id)`, `onReject(id)`, `onRole(id, role)`, `onRemoveAccess(id)`, `onViewAs(id)`
- Extensions: `candidates: { extensions[{ id, displayName, description, iconDataUri? }], mcp[{ url, displayName, iconUrl?, agentCount }] }`, `top: { extensions[], mcp[] }`, `system: { extensions[], mcp[] }`, `onToggleTop(kind, id)`, `onToggleSystem(kind, id)`
- MCP servers: `{ name, url, displayName?, description?, iconUrl? }[]`, `onAdd({ url, displayName, description })`, `onUpdate(name, { displayName, description })`, `onRefreshIcon(name)`, `onRemove(name)`
- Skills: `{ skills[{ id, name, description, ownerName, ownerActive, shares[], enabledCount, updatedAt, disabledByAdmin, collisions[] }], agent[{ id, name, agentName, description, system }], system[{ id, name, description, kind, agents? }] }`, `users[]` for Transfer, `onTransfer`, `onDisable`, `onDelete`, `onSystem`, `onMakeDefault`
- Quota: `logins: { provider, plan?, accountRef, stale, error?, fiveHour?, fiveHourState, weekly?, weeklyPace, source, updatedAt }[]`, refreshed every 20 seconds
- Loading ("Loading…"), load errors (inline alert with Retry) and "Superadmin access required." keep their prod copy

**Do**
- Users: search, then "Waiting for approval N" (avatar, name and email, "Asked Nov 6", Reject ghost, Approve accent), then "Members N" (avatar, name, email muted, joined date, compact ghost role select, "…" menu). The menu holds View as, a separator, then Remove access (`yp-menu__item--danger`) with a confirm modal. Your own row says "You", keeps its space in the "…" column, and its role select is disabled.
- Extensions: one toolbar (search, `All / Top / System` with counts) that never re-renders while you type or filter. Rows keep their place when you toggle, so starring inside "Top" does not make the row vanish. A star toggle (`yp-dash__pin`, `aria-pressed`, ink when on) and a small "System" chip (`yp-admin__sys`, `aria-pressed`, ink-filled when on, title "Hidden from users and admins on agent configuration pages"). Extensions and MCP servers stay two labelled sections, as in the code.
- MCP servers: "Add server" (accent) sits in the tab toolbar and opens one modal: URL (required, https), Display name, Description. Rows: icon, name, URL in mono muted, description. "…" menu: Edit, Refresh icon, separator, Remove (danger, confirm). Empty copy: "No shared MCP servers yet."
- Skills: keep the three sections from the code (User skills, Agent skills, System skills), each with its description line. A skill row is mono name, two-line description, and a meta line "Owner · Access · N users · Updated". "Owner inactive" is a quiet warning badge, "Disabled" a muted badge. "…" menu: Transfer…, then (shared with everyone, or already disabled) Disable / Enable, a separator and Delete (danger, confirm). Transfer opens a small modal with a user select.
- Quota: one card per provider, with the name, a muted plan or id and a quiet badge (Fresh / Stale / Error). One `yp-progress` row per window: label, "Resets in 1h 14m", right-aligned tabular percent, then the meter. "Pace 0.79×" is muted meta; above 1 it turns warning text. Footer: "Updated 4m ago · Claude usage endpoint".
- Use `toast(title, detail)` for every change (role, star, System, approve, transfer).

**Don't**
- Don't use accent for anything but Approve (Users, pending rows only) and Add server (MCP servers). Stars, switches and the System chip are ink when on, never accent. No accent on the tabs.
- Don't build tables with a column of buttons. One row, one "…" menu for rare or destructive actions.
- Don't show danger red on a resting row. It lives in menu items and confirm dialogs only.
- Don't repeat "Admin" or the tab name as a heading inside the sheet; the header and the tab already say it.
- Don't move the toolbar when filtering: no re-render, and give the counts a fixed width.
- Don't change meaning with color alone: the meter always has its percent beside it.
