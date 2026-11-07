The header of an agent's chat page: back, who the agent is, a centered row of two section tabs, New chat, and a cog menu.

**When to use**
- At the top of any agent page. The tabs swap the content below it (the composer fades out and goes inert off the Chat tab).
- Dashboards and Jobs open from the cog menu into the same sheet: no tab is selected (the thumb fades out) and the panel shows a "← Chat" button to go back.

**What you provide**
- `agent: { name, avatar }`, `status` / `role` (e.g. "online · HR assistant")
- `activeTab: 'chat' | 'extensions' | null` (`null` while a menu-opened panel such as Dashboards or Jobs is showing), `onTab(tab)`
- `soundOn: boolean`, `onToggleSound(next)`
- `onOpenDashboards()`, `onOpenJobs()`, `onSettings()`
- `onNewChat()`, `onBack()`

**Do**
- Make Chat the first tab. Keep at most two or three tabs.
- Use one segmented control only: `yp-seg yp-seg--field yp-chathead__tabs`, `role="tablist"`, roving `tabindex`, arrow/Home/End keys, sliding thumb.
- Put Dashboards and Jobs in the cog menu: the sidebar owns the user-level ones, and two entry points for the same thing confuse people.
- Put settings-like toggles (sound) in the cog menu as stateful `role="menuitemcheckbox"` items: the label and icon swap in place (`yp-menu__swap`, `yp-menu__on` / `yp-menu__off`) and the menu stays open.
- Build the cog menu on `yp-menu`: `aria-haspopup="menu"` and `aria-expanded` on the cog, right-aligned under it, arrow/Home/End keys, Esc closes and returns focus to the cog.
- Let the cog's last item open agent settings (identity, teams, visibility).
- Keep thinking level in the composer, not here.
- Let the name truncate before the tabs do; below 900px the tabs scroll inside the segment and New chat becomes icon-only.

**Don't**
- Don't add Dashboards or Jobs back as tabs, or a bell in the header: notification sound is a cog-menu item.
- Don't add a Simple/Full mode switch.
- Don't put archive, delete or a main-agent star in the header: sessions are managed under the hood.
- Don't add a second segmented control.
- Don't mark a tab selected while a menu-opened panel shows.
- Don't put user-level settings such as personal connections in agent tabs; they live on the user's connections page.
