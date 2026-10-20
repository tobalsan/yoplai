export async function writeReplyClipboard(content: {
  html: string;
  plain: string;
}): Promise<boolean> {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([content.html], { type: "text/html" }),
        "text/plain": new Blob([content.plain], { type: "text/plain" }),
      }),
    ]);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(content.plain);
      return true;
    } catch {
      return false;
    }
  }
}
