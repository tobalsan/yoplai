export function completeInstructionBlocks(text: string): string {
  const blocks = text.trim().split(/\r?\n[ \t]*\r?\n/);
  blocks.pop();
  while (blocks.length) {
    const prefix = blocks.join("\n\n").trimEnd();
    // Keep only a prefix that ends with a sentence and has no code fence.
    if (/[.!?。！？]$/u.test(prefix) && !/^\s*(?:`{3,}|~{3,})/m.test(prefix)) return prefix;
    blocks.pop();
  }
  return "";
}
