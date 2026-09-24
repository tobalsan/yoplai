export function safeReturnTo(search: string): string | null {
  const returnTo = new URLSearchParams(search).get("returnTo");
  if (
    !returnTo?.startsWith("/") ||
    returnTo.startsWith("//") ||
    returnTo.startsWith("/\\")
  ) {
    return null;
  }
  const base = "https://return-to.invalid";
  try {
    return new URL(returnTo, base).origin === base ? returnTo : null;
  } catch {
    return null;
  }
}
