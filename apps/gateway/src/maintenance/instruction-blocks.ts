export function completeInstructionBlocks(text: string): string {
  const draft = text.trimEnd();
  let open: string | undefined;
  let end = 0;
  for (const { 0: span, 1: line, index } of draft.matchAll(/([^\r\n]*)(?:\r?\n|$)/g)) {
    if (!span) break;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const [, fence, tail] = marker;
      if (open) {
        if (fence[0] === open[0] && fence.length >= open.length && !tail.trim()) {
          open = undefined;
          if (index + line.length < draft.length) end = index + line.length;
        }
      } else if (fence[0] === "~" || !tail.includes("`")) {
        open = fence;
      }
    } else if (!open && !line.trim() && /[.!?。！？]$/u.test(draft.slice(0, index).trimEnd())) {
      end = index;
    }
  }
  return draft.slice(0, end).trim();
}
