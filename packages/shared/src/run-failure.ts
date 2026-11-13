import { z } from "zod";
import { getErrorStatus } from "./provider-retry.js";

export const RunFailureKindSchema = z.enum([
  "rate_limit",
  "quota",
  "overloaded",
  "tool_deadline",
  "max_run_time",
  "idle_timeout",
  "safety_refusal",
  "generic",
]);
export type RunFailureKind = z.infer<typeof RunFailureKindSchema>;

/**
 * Provider safety-filter refusals. Retrying the same context can never
 * succeed, so callers drop the refused turn instead of keeping it.
 */
const SAFETY_REFUSAL =
  /cyber safeguards flagged|violate anthropic's terms of service|the model refused to complete the request/i;

function failureText(error: unknown, message?: string): string {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : undefined;
  const providerError =
    record?.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : undefined;
  return [
    message ?? (error instanceof Error ? error.message : String(error)),
    record?.code,
    record?.type,
    record?.message,
    providerError?.code,
    providerError?.type,
    providerError?.message,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

/** True when the provider's safety filter refused the run. */
export function isSafetyRefusal(error: unknown, message?: string): boolean {
  return SAFETY_REFUSAL.test(failureText(error, message));
}

export function classifyRunFailure(
  error: unknown,
  message?: string
): RunFailureKind {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : undefined;
  const attachedKind = RunFailureKindSchema.safeParse(record?.kind);
  if (attachedKind.success) return attachedKind.data;
  if (record?.code === "tool_deadline") return "tool_deadline";
  if (record?.code === "max") return "max_run_time";
  if (record?.code === "idle") return "idle_timeout";
  const text = failureText(error, message);
  if (SAFETY_REFUSAL.test(text)) return "safety_refusal";
  if (/Container tool_deadline:/i.test(text)) return "tool_deadline";
  if (/Container exceeded max runtime/i.test(text)) return "max_run_time";
  if (/Container idle timed out/i.test(text)) return "idle_timeout";
  const status = getErrorStatus(error);
  if (
    /insufficient[_ -]quota|quota|billing|credit|usage[_ -]limit|plan[_ -]limit/i.test(
      text
    )
  )
    return "quota";
  if (status === 429 || /\b429\b|rate[_ -]limit|too many requests/i.test(text))
    return "rate_limit";
  if (status === 529 || /\b529\b|overloaded/i.test(text)) return "overloaded";
  return "generic";
}

export function runFailureMessage(
  kind: RunFailureKind,
  lang: "en" | "fr",
  _ctx?: { toolName?: string }
): string {
  switch (kind) {
    case "rate_limit":
    case "overloaded":
      return lang === "fr"
        ? "Le service IA est temporairement saturé. Merci de réessayer dans quelques minutes."
        : "The AI service is temporarily rate-limited. Please try again in a few minutes.";
    case "quota":
      return lang === "fr"
        ? "Le quota du service IA pour cet espace est épuisé. Votre administrateur a été prévenu."
        : "The AI service quota for this workspace is exhausted. Your administrator has been notified.";
    case "tool_deadline":
    case "max_run_time":
    case "idle_timeout":
      return lang === "fr"
        ? "Désolé, cette demande a pris trop de temps et a été interrompue. Des modifications partielles peuvent exister. Réessayez ou demandez-moi de continuer."
        : "Sorry, this request took too long and was stopped. Partial changes may exist. Please try again or ask me to continue.";
    case "safety_refusal":
      return lang === "fr"
        ? "Le filtre de sécurité du fournisseur d'IA a bloqué ce message, il n'a donc pas été conservé. Vous pouvez le reformuler ou continuer."
        : "The AI provider's safety filter blocked this message, so it was not kept. You can rephrase or carry on.";
    case "generic":
      return lang === "fr"
        ? "Une erreur est survenue, merci de réessayer."
        : "Something went wrong, please try again.";
  }
}
