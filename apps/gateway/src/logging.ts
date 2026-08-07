import { sanitizeForStorage, sanitizeSensitiveText } from "@yoplai/shared";

const DETAILS_LIMIT = 500;

type ErrorWithFields = Error & {
  status?: unknown;
  endpoint?: unknown;
  requestId?: unknown;
  details?: unknown;
};

function truncateDetails(details: unknown): string | undefined {
  if (details === undefined) return undefined;

  let text: string;
  if (typeof details === "string") {
    text = details;
  } else {
    try {
      text = JSON.stringify(details, createJsonReplacer()) ?? String(details);
    } catch {
      text = String(details);
    }
  }

  const sanitized = sanitizeSensitiveText(text);
  return sanitized.length > DETAILS_LIMIT
    ? `${sanitized.slice(0, DETAILS_LIMIT)}…`
    : sanitized;
}

function createJsonReplacer(): (
  this: object,
  key: string,
  value: unknown
) => unknown {
  const seen = new WeakSet<object>();
  return function (_key: string, value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function" || typeof value === "symbol") {
      return String(value);
    }
    if (value instanceof Error) {
      return { message: value.message, stack: value.stack };
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}

export function logInfo(
  msg: string,
  fields: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify(
      sanitizeForStorage({ level: "info", msg, ...fields }),
      createJsonReplacer()
    )
  );
}

export function logWarn(
  msg: string,
  fields: Record<string, unknown> = {}
): void {
  console.warn(
    JSON.stringify(
      sanitizeForStorage({ level: "warn", msg, ...fields }),
      createJsonReplacer()
    )
  );
}

export function logError(
  msg: string,
  error: unknown,
  fields: Record<string, unknown> = {}
): void {
  const structured = (error ?? {}) as ErrorWithFields;
  const message = error instanceof Error ? error.message : String(error);

  console.error(
    JSON.stringify(
      sanitizeForStorage({
        level: "error",
        msg,
        ...fields,
        status: structured?.status,
        endpoint: structured?.endpoint,
        requestId: structured?.requestId,
        details: truncateDetails(structured?.details),
        message,
        stack: error instanceof Error ? error.stack : undefined,
      }),
      createJsonReplacer()
    )
  );
}
