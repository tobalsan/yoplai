import type { AgentConfig, GatewayConfig } from "@yoplai/shared";

type PreviewContext = { agent: AgentConfig; config: GatewayConfig; signal?: AbortSignal };
type PreviewCheck = {
  frameable: boolean;
  reason: null | "x-frame-options" | "frame-ancestors" | "unreachable";
  finalUrl: string;
  status: number | null;
};

function invalidInput(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "invalid_input" });
}

function checkedUrl(value: string, context: PreviewContext, ownOrigins: Set<string>, base?: URL): URL {
  if (value.length > 2048) throw invalidInput("Preview URL must be at most 2048 characters.");
  let url: URL;
  try { url = new URL(value, base); } catch { throw invalidInput("Preview requires a valid URL."); }
  if (url.href.length > 2048) throw invalidInput("Preview URL must be at most 2048 characters.");
  if (url.username || url.password) throw invalidInput("Preview URL must not contain credentials.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw invalidInput("Preview requires HTTPS, or HTTP on a loopback host.");
  }
  if (loopback && context.agent.sandbox?.enabled) throw invalidInput("Loopback previews are unavailable to sandbox agents.");
  const ownPorts = [context.config.ui?.port ?? 3000, context.config.gateway?.port ?? 4000,
    context.config.server?.port, context.config.apps?.port ?? 4001];
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (ownOrigins.has(url.origin) || (loopback && ownPorts.includes(port))) {
    throw invalidInput("Preview cannot frame this Yoplai instance.");
  }
  return url;
}

function frameReason(headers: Headers): PreviewCheck["reason"] {
  if (headers.has("x-frame-options")) return "x-frame-options";
  const policies = headers.get("content-security-policy")?.split(",") ?? [];
  for (const policy of policies) {
    for (const directive of policy.split(";")) {
      const [name, ...values] = directive.trim().split(/\s+/);
      if (name?.toLowerCase() === "frame-ancestors" && (values.length !== 1 || values[0] !== "*")) return "frame-ancestors";
    }
  }
  return null;
}

export async function checkPreviewUrl(url: string, context: PreviewContext): Promise<PreviewCheck> {
  context.signal?.throwIfAborted();
  const { getTrustedOrigins } = await import("@yoplai/extension-multi-user");
  const ownOrigins = new Set(getTrustedOrigins(context.config));
  if (context.config.apps?.origin) ownOrigins.add(new URL(context.config.apps.origin).origin);
  let target = checkedUrl(url, context, ownOrigins);
  const timeout = AbortSignal.timeout(5000);
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  for (let redirects = 0; ; redirects++) {
    let response: Response;
    try {
      response = await fetch(target, { headers: { "User-Agent": "Yoplai-WebPreview/1" }, redirect: "manual", credentials: "omit", signal });
      await response.body?.cancel();
    } catch {
      context.signal?.throwIfAborted();
      return { frameable: false, reason: "unreachable", finalUrl: target.href, status: null };
    }
    const location = response.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(response.status) && location !== null) {
      if (redirects === 5) throw invalidInput("Preview cannot follow more than 5 redirects.");
      target = checkedUrl(location, context, ownOrigins, target);
      continue;
    }
    const reason = frameReason(response.headers);
    return { frameable: reason === null, reason, finalUrl: target.href, status: response.status };
  }
}
