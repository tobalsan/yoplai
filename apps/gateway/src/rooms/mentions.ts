export function roomMentions(text: string, agentIds: readonly string[]): string[] {
  const mentions = new Set<string>();
  for (const [, token] of text.matchAll(/(?<!\w)@([A-Za-z0-9_-]+)/g)) {
    const candidates = agentIds.filter((id) => id.toLowerCase() === token.toLowerCase());
    if (candidates.includes(token)) mentions.add(token);
    else if (candidates.length === 1) mentions.add(candidates[0]);
  }
  return [...mentions];
}
