The right-hand panel that holds expanded artifacts next to the chat sheet. One item shows a header; two or more show tabs.

**When to use**
- After Expand on an inline card or a click on a marker. Collapse (or closing a tab) puts the item back inline. Classes: `yp-panel`, `yp-panel-scrim`.
- The chat sheet and composer re-centre in the space left of the panel; closing the last item gives the width back.
- Default split is 50/50: the panel takes half of the chat row ((row − 6px) / 2) and the resize handle sits in the middle. Drag or arrow keys to resize (panel ≥ 320px, chat keeps ≥ 406px); double-click the handle to go back to half. A manual width sticks until double-click, clamped on window resize.
- The two halves read as equal: the chat header and the chat sheet fill the left half (the sheet drops its side gutters), and the panel runs full height beside the header. Closing the panel gives the header and the centred sheet back.
- When the window is 768px or narrower, or the chat row is under 726px, the panel is an overlay sheet from the right over a scrim; Escape or a scrim click closes it.

**What you provide**
- The open items in order, the active one, and the same `item` objects the inline cards use (see Artifact).
- Host sets `--panel-w` (computed: half the row by default, min 320px) and `--panel-bleed` if the panel sits under a bleeding sheet.
- `data-overlay` on the panel switches to the overlay layout.
- Events: select, close/collapse, reorder, Download, Open in browser.

**Do**
- One item: header = icon, title, meta, actions (Download if a file, Open in browser, Collapse). No tab row.
- Two or more: tab row (`role=tablist`) replaces the title. Tab = icon + title (ellipsis) + × (shown on hover, focus and for the active tab). Fixed width so nothing shifts under the pointer. Active tab: raised paper, ink text, 2px ink underline that slides (transform only). Under it a slim toolbar: meta left, actions right. Never repeat the title.
- Keyboard: Left/Right/Home/End move and select, Delete closes, Alt+Left/Right reorders. Drag reorders with an ink drop indicator.
- Resizer: 6px hit area on the left edge, hairline, ink on hover or drag, `role=separator`. Drag, Left/Right keys, double-click resets.
- The frame fills the panel body and the body takes the content's own background. No white void.
- Keep every open item's page mounted so switching tabs keeps its state.

**Don't**
- Don't use text type labels ("FILE", "IMG") or blue for the active tab.
- Don't use accent anywhere in the panel.
- Don't animate width; enter with opacity and transform only.
