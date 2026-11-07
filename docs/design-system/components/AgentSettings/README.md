The quiet settings panel for one agent: who it is, who can use it, which teams it serves.

**When to use**
- "Agent settings" in the chat header's cog menu. It opens as a panel in the sheet, like Dashboards and Jobs: the panel rises in, the composer fades and goes inert, no header tab is selected, and a "← Chat" row returns.
- Settings are only identity, visibility and teams. Extensions are the Extensions tab, dashboards and scheduled jobs are cog-menu panels, and user-level connections live on the user page. None of them belong here.

**What you provide**
- `agent: { name, role, avatar }` (read-only; emoji, image or initial)
- `visibility: "private" | "public"`, `onVisibility(v)` (saves at once)
- `teams: { id, name }[]`, `selected: string[]`, `onSave(ids)`
- `canManage: boolean`; when false, render the seg and chips with `disabled` and drop the save bar
- Source: `apps/web/src/pages/EditAgent.tsx` (`ForkVisibility`, `TeamAssignment`)

**Do**
- Use `yp-settings` for the column (`prose-w`, `space-7` between sections) and `yp-settings__label` for the quiet uppercase section headings.
- Show visibility as a `yp-seg yp-seg--field` with a one-line hint, not a loud badge. It saves immediately and confirms with a toast.
- Show teams as `yp-chip` toggles (`aria-pressed`): soft accent wash when on, never outlined.
- Show the `yp-settings__bar` glass bar only while teams differ from the saved set; Save is the one orange action. If Save would remove a team, switch the bar's text to what members lose and relabel the button "Remove and save".
- Discard unsaved team edits when the user leaves the panel.

**Don't**
- Don't add fields main does not have (instructions, model, delete); add them only when the product does.
- Don't make name or role editable; they come from the agent definition.
- Don't put extensions, dashboards, jobs or personal connections in this panel.
- Don't autosave teams: removing one revokes access and needs the explicit, confirmed Save.
