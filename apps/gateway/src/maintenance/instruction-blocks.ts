function hasOpenFence(text: string): boolean {
  let open: string | undefined;
  for (const match of text.matchAll(/^ {0,3}(`{3,}|~{3,})(.*)$/gm)) {
    const [, fence, tail] = match;
    if (open) {
      if (fence[0] === open[0] && fence.length >= open.length && !tail.trim()) open = undefined;
    } else if (fence[0] === "~" || !tail.includes("`")) {
      open = fence;
    }
  }
  return open !== undefined;
}

export function completeInstructionBlocks(text: string): string {
  const draft = text.trimEnd();
  const breaks = [...draft.matchAll(/\r?\n[ \t]*\r?\n/g)];
  for (const { index } of breaks.reverse()) {
    const prefix = draft.slice(0, index).trimEnd();
    if (/[.!?。！？]$/u.test(prefix) && !hasOpenFence(prefix)) return prefix.trimStart();
  }
  return "";
}
