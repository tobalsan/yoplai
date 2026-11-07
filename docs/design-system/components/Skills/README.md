The Skills page: skills you turn on for all your agents, and the read-only skills each agent keeps in its own workspace.

**When to use**
- The "Skills" sidebar item. It replaces the chat in the same paper sheet (the sheet rises in); the header just reads "Skills".
- Two sections only: "Your skills" (on/off) and "Agent skills" (read-only). Add "Shared with me" in the same form when multi-user is on.

**What you provide**
- `mine: { id, description, enabled, locked? }[]`, `onToggle(id, on)` (turning a skill on makes it available to all your agents)
- `agentSkills: { agent: { name, avatar }, skills: { name, description }[] }[]`
- Row actions `onShare`, `onUpdate`, `onVersions`, `onDelete` (Delete asks to confirm first); `onAdd(kind: "zip" | "folder" | "create" | "import")`
- Search is client-side over name, description and agent name; matches are marked, and sections show the filtered count
- Source: `apps/web/src/pages/Skills.tsx`, `AgentSkillTabs.tsx`

**Do**
- Make "Add skill" the one `yp-btn--primary`; its `yp-menu` lists Upload zip, Upload folder, Create skill, Import from Claude or ChatGPT.
- Use `yp-skills__list` rows: name in mono, description clamped to two lines (full text in the `title`), hairline separators that fade with a soft wash on hover.
- Use `yp-switch` for on/off (`role="switch"`, `aria-checked`, label "Enable name"); a switched-off name dims. Toggle at once, confirm with a toast.
- Put Share, Update, Versions, then a separator and Delete (`yp-menu__item--danger`) in the row's "…" `yp-menu`.
- Head sections with the quiet uppercase label, the count as faint text, and the explanation in a `yp-tip` on a small info button (hover or focus), not a loud icon.
- Pick the agent with a wrapping row of `yp-chip` toggles (avatar, name, count). Chips with no search match are disabled; the selection moves to the first agent that has one.
- Show an empty message per section ("No skills yet. Use Add skill…", "No skills match “q”.").

**Don't**
- Don't box the list in a bordered card or table, and don't use underline tabs for agents.
- Don't add toggles or a "…" menu to agent skills: they belong to the agent's workspace.
- Don't use a `yp-seg` for agents: it spans equal columns and overflows past about five agents, and a chip row wraps.
- Don't show a second accent fill: the switches are the only other orange, and only while on.
