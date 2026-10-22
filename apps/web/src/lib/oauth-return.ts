export type OAuthResult = {
  status: "connected" | "error";
  scope: "personal" | "team";
  error?: string;
};

/** Consume a callback result once, preserving the page's other query values and hash. */
export function readOAuthResult(): OAuthResult | undefined {
  const url = new URL(window.location.href);
  const status = url.searchParams.get("oauth");
  if (status !== "connected" && status !== "error") return undefined;
  const result: OAuthResult = {
    status,
    scope: url.searchParams.get("oauth_scope") === "team" ? "team" : "personal",
    error: status === "error" ? url.searchParams.get("oauth_error") || "Connection failed." : undefined,
  };
  for (const key of ["oauth", "oauth_error", "oauth_scope"]) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  return result;
}
