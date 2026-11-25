function messageRows(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[data-feed-message]")];
}

/** Capture on the old layout. Restore the first visible row, or the nearest row that survived. */
export function captureFeedScroll(container: HTMLElement): (() => void) | undefined {
  const rows = messageRows(container);
  const top = container.getBoundingClientRect().top;
  const visible = rows.findIndex((row) => row.getBoundingClientRect().bottom > top);
  if (visible < 0) return;
  const offset = rows[visible].getBoundingClientRect().top - top;
  const ids = rows.map((row) => row.dataset.feedMessage);
  return () => {
    const byId = new Map(messageRows(container).map((row) => [row.dataset.feedMessage, row]));
    for (let distance = 0; distance < ids.length; distance++) {
      const row = byId.get(ids[visible + distance]) ?? byId.get(ids[visible - distance]);
      if (row) {
        container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - offset;
        return;
      }
    }
  };
}

export function clearFeedCentering(container: HTMLElement | undefined) {
  container?.style.removeProperty("padding-block-start");
  container?.style.removeProperty("padding-block-end");
}

export function centerFeedMessage(container: HTMLElement, id: string) {
  const row = messageRows(container).find((row) => row.dataset.feedMessage === id);
  if (!row) return false;
  clearFeedCentering(container);
  const rect = row.getBoundingClientRect();
  const top = container.getBoundingClientRect().top;
  const target = container.scrollTop + rect.top - top - (container.clientHeight - rect.height) / 2;
  const style = getComputedStyle(container);
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const contentBottom = (container.lastElementChild?.getBoundingClientRect().bottom ?? rect.bottom)
    - top + container.scrollTop + paddingBottom;
  const before = Math.max(0, -target);
  const after = target > 0 ? Math.max(0, target + container.clientHeight - contentBottom) : 0;
  if (before) container.style.paddingBlockStart = `${paddingTop + before}px`;
  if (after) container.style.paddingBlockEnd = `${paddingBottom + Math.ceil(after)}px`;
  container.scrollTop = target + before;
  return true;
}
