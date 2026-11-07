The floating glass message box docked at the bottom of a chat, with attach and the round Send button.

**When to use**
- Sending a message to an agent in a session. It floats over the paper thread: older turns scroll on under the glass, but the latest turn never hides behind it.

**What you provide**
- `value: string`, `onInput`, `onSend()`, `onStop()` while streaming
- `agentName: string` for the placeholder ("Message Henry…")
- `onAttach?()`, `disabled?: boolean`
- `thinkingLevel?: "" | "off" | "low" | "medium" | "high" | "xhigh"`, `onThinkingLevel(level)`
- The history's scroll container, marked `yp-chat-scroll`, plus the dock script below.

**Docking (scroll past the end)**
- The history can always scroll past its own end by exactly what the composer covers plus `space-7` (48px). The last turn then sits 48px above the composer at every draft length.
- The textarea grows with its content (`field-sizing: content`) up to 10 lines, then scrolls inside.
- Measure the overlap, not the composer's height: overlap = history bottom edge − composer top edge, written to `--dock-overlap`. Re-measure on resize of either element and after transitions or animations end, because transforms move boxes without resizing them.
- While you type at the bottom, the history stays pinned to the end, so a growing draft pushes the conversation up instead of covering it.
- Reserve the space with the `.yp-chat-scroll::after` spacer, never `padding-bottom`: padding taller than the box makes the box itself grow.

```js
const measureDock = () => {
  const atEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 8;
  const overlap = scroll.getBoundingClientRect().bottom - composer.getBoundingClientRect().top;
  scroll.style.setProperty('--dock-overlap', Math.max(0, overlap) + 'px');
  if (atEnd) scroll.scrollTop = scroll.scrollHeight;
};
const ro = new ResizeObserver(measureDock); ro.observe(composer); ro.observe(scroll);
['transitionend', 'animationend'].forEach((e) => document.addEventListener(e, measureDock));
```

**Do**
- Keep Send as the single orange action: `yp-send`, a circle that morphs into a "Stop" pill (`data-state="stop"`) while the reply streams.
- Keep the glass recipe: `glass`, `blur-glass` + `glass-saturate`, `glass-edge` highlight, `glass-rim`, `elev-2`, `radius-lg`.
- Label the attach icon button with `aria-label`. `:focus-within` draws the `focus` ring around the whole composer.
- Keep the thinking-level select in the toolbar next to attach (`yp-composer__think`: a ghost button over a native select, "Think Default ▾"); it does not belong in the page header.

**Don't**
- Don't use a fixed bottom padding on the history: it hides the last turn as soon as the draft grows.
- Don't widen it beyond `prose-w`.
- Don't make it opaque paper unless `prefers-reduced-transparency` asks for it (the bundle switches to `surface-raised`).
- Don't add extra toolbar buttons beside Send, attach and the thinking level.
