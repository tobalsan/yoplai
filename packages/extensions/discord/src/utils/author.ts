/**
 * Agent-facing author label. Includes the mention form so agents can
 * @-mention the author (bots only respond to explicit mentions).
 */
export function formatDiscordAuthor(author: {
  id: string;
  username?: string;
  bot?: boolean;
}): string {
  const name = author.username ?? author.id;
  return `${name} (<@${author.id}>${author.bot ? ", bot" : ""})`;
}
