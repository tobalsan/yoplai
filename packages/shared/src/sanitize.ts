const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  // Anthropic thinking-block integrity signature: must be replayed verbatim
  // in session history or the API rejects the conversation; not a credential.
  if (key === "thinkingSignature") return false;
  if (
    /(authorization|secret|password|credential|api[-_]?key|signature|sig|x-amz-[\w-]+)/i.test(
      key
    )
  )
    return true;
  return /token$/i.test(key);
}
const sensitiveQueryKey =
  /^(?:x-amz-|x-goog-)?(?:algorithm|credential|date|expires|security-token|signature|signedheaders)|^(?:awsaccesskeyid|access_?token|api[-_]?key|authorization|signature|sig|token|sp|st|se|sv)$/i;
const urlPattern = /https?:\/\/[^\s"'<>]+/g;

function redactUrl(value: string): string {
  return value.replace(urlPattern, (candidate) => {
    const trailing = candidate.match(/[),.;:!?]+$/)?.[0] ?? "";
    const raw = trailing ? candidate.slice(0, -trailing.length) : candidate;
    try {
      const url = new URL(raw);
      const query = [...url.searchParams]
        .map(
          ([key, value]) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(sensitiveQueryKey.test(key) ? REDACTED : value)}`
        )
        .join("&");
      const credentials = url.username || url.password ? `${REDACTED}@` : "";
      const hash = url.hash.replace(
        /((?:access_?token|token)\s*=\s*)[^&\s]+/gi,
        `$1${REDACTED}`
      );
      return `${url.protocol}//${credentials}${url.host}${url.pathname}${query ? `?${query}` : ""}${hash}${trailing}`;
    } catch {
      return candidate;
    }
  });
}

/** Redacts credentials only at observability and persistence boundaries. */
export function sanitizeSensitiveText(value: string): string {
  return redactUrl(value)
    .replace(/\b(authorization\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(
      /\b((?:token|[A-Za-z][A-Za-z0-9_-]*(?:token|secret|password|credential|api[-_]?key|signature)[A-Za-z0-9_-]*)\s*[:=]\s*)[^\s,;&]+/gi,
      `$1${REDACTED}`
    )
    .replace(
      /\b((?:onecli[_-]?url|https?_proxy|access_?token|api[-_]?key|secret|password|credential)\s*[:=]\s*)[^\s,;&]+/gi,
      `$1${REDACTED}`
    )
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`);
}

export function sanitizeForStorage<T>(value: T): T {
  return sanitize(value, new WeakMap()) as T;
}

function sanitize(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return sanitizeSensitiveText(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Error) {
    const copy = new Error(sanitizeSensitiveText(value.message));
    copy.name = value.name;
    if (value.stack) copy.stack = sanitizeSensitiveText(value.stack);
    seen.set(value, copy);
    const error = value as Error & { cause?: unknown; errors?: unknown[] };
    if (error.cause !== undefined) {
      copy.cause = sanitize(error.cause, seen);
    }
    if (error.errors) {
      Object.defineProperty(copy, "errors", {
        value: error.errors.map((item) => sanitize(item, seen)),
      });
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === "errors" && error.errors) continue;
      (copy as unknown as Record<string, unknown>)[key] = isSensitiveKey(key)
        ? REDACTED
        : sanitize(item, seen);
    }
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    copy.push(...value.map((item) => sanitize(item, seen)));
    return copy;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = isSensitiveKey(key) ? REDACTED : sanitize(item, seen);
  }
  return copy;
}
