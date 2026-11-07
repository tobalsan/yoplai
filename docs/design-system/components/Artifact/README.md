What an agent made (dashboard, HTML report, image, PDF) as it shows up in a chat turn: an inline card, or one quiet marker when the item lives in the side panel or is an older version.

**When to use**
- Under the assistant turn that created or updated the item. Classes: `yp-artifact` (card), `yp-artifact-mark` (marker), `yp-frame` (the preview surface).
- The latest version of an item is a card. If that item is open in the side panel, the card becomes a marker. Older updates of the same item are always markers carrying the title they had at that moment.
- One item, one element: never a file card plus an "updated" marker for the same HTML file.

**What you provide**
- `item`: `{ id, type: 'dash' | 'html' | 'img' | 'pdf', title, meta, file: boolean, bg, note? }`. `meta` is the muted line: "PNG · 11 KB", "Dashboard · updated 2 min ago", "PDF · 60 pages · 72 KB". `bg` is the content's own background. `note` is the PDF line "Showing the first 50 of 60 pages. Download the file for all pages."
- `state`: `ready | loading | error`.
- Marker: `{ verb: 'Created' | 'Updated', title }` (the title at that moment) and `st: 'open' | 'panel' | 'active'`.
- Events: Download (files only), Open in browser, Expand (also clicking the preview) and marker click. All go to the host; Expand and marker click open or focus the item in the side panel.

**Do**
- Header: 16px type icon, title (500, ellipsis), muted meta, then ghost icon buttons with aria-labels: Download (files only; dashboards have none), Open in browser, Expand.
- Clip the preview at 320px with no inner scroll. When it is taller, show the bottom fade and the quiet "Expand" pill (`data-clip` on the card). The body is the Expand target.
- Images are contained and centered with no fade. PDFs show page one only, with the page note as a padded muted footer line inside the card.
- Loading is a skeleton (opacity pulse) plus "Loading dashboard…". Failure is a muted "View unavailable" (or "Dashboard unavailable") and the Download button stays.
- Marker: 32px single line, hairline border, icon, muted verb + ink title, right state "Open", "In side panel", or "In side panel" with a small ink dot when its tab is the active one. Hover is a subtle wash.

**Don't**
- Don't use three marker styles. No filled or accent marker, no blue "Click to see it" button.
- Don't show the dashboard's current title on an old marker.
- Don't let a preview scroll inside the chat (scroll trap), and don't use accent colour anywhere here.
