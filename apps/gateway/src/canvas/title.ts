export function dashboardTitle(html: string, slug: string): string {
  return html.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i)?.[1]
    ?.replace(/<[^>]*>/g, "").trim() || slug;
}
