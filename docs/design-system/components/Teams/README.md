The Teams page: organize agents and people into teams. One flat list; a row opens the team's sheet.

**When to use**
- The "Teams" sidebar item. It replaces the chat in the same paper sheet; the header just reads "Teams". No title inside the sheet.
- A team's sheet opens in that same sheet (like Agent settings), with a "← Teams" back row.
- Superadmin sees New team and Delete. A `canManage` user sees Edit details and the sheet, no New team or Delete. Staff also see "Without a team".

**What you provide**
- `teams`: `{ id, name, description, color, icon, allUsers, members[], agents[{ name, visibility }], canManage }[]`
- `withoutTeam`: `{ id, name, email, note? }[]` (staff only)
- `directory`: `{ id, name, email }[]` for the add-people search
- `onCreate / onUpdate(details)`, `onDelete(id)`, `onSave(id, { allUsers, addMembers, removeMembers, removeAgents })`, `onAssign(userId, teamId)`
- Colour (10 swatches) and icon (18) are user data, not tokens.

**Do**
- Render ONE flat list sorted by name. Row: glyph, name, meta "4 members · 1 agent · description", overlapping avatar stack (max 4, then +N), "…" menu.
- Make the whole row the Open action (`yp-dash__open` stretches over it). Put Edit details, a separator, then Delete team (`yp-menu__item--danger`) in the "…" menu. The "…" is faint until hover or focus, always visible on touch, and reserves its space.
- Stage membership edits: added people get a quiet "New" badge, removed people and agents stay in place struck through with Undo, so nothing jumps. Show the sticky `yp-settings__bar` ("Unsaved changes", Cancel, Save). Save toasts "Team saved".
- Confirm leaving with unsaved changes ("Discard unsaved changes?") and removing an agent ("Remove X from Team?", warn when it is the agent's last team).
- When "All users" is on, collapse the Members list to one muted line and keep the explicitly added people listed.
- Edit details and New team share one `yp-modal`: Name (required, "Name is required."), Description, Color radio swatches (selected = ink ring), Icon radio grid (selected = ink border), live glyph preview.
- Delete confirms with the prod copy, including "These users will have no team: A, B." People left teamless move to "Without a team".
- "Without a team" rows: native `<select>` "Add to team…"; choosing adds at once, toasts, and the row fades out. When empty, show only "Everyone is in a team."
- Accent only on "New team" (list) and "Save" (sheet bar). Switches on are ink.
- Team colour appears only on the glyph (list row, sheet header, preview).

**Don't**
- Don't use a card grid, or three buttons per team.
- Don't repeat the page title as a heading inside the sheet.
- Don't apply membership changes before Save, or let rows vanish or shift on Remove.
- Don't colour anything but the glyph with the team colour, or use a second orange.
