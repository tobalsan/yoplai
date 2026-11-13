import { describe, expect, it } from "vitest";
import {
  classifyRunFailure,
  isSafetyRefusal,
  runFailureMessage,
  RunFailureKindSchema,
} from "./run-failure.js";
import {
  AgentConfigSchema,
  NotificationsConfigSchema,
  StreamEventSchema,
} from "./types.js";

describe("classifyRunFailure", () => {
  it.each([
    [{ status: 429 }, "rate_limit_error", "rate_limit"],
    [{ response: { status: 429 } }, "rate_limit_exceeded", "rate_limit"],
    [{ statusCode: 429 }, "insufficient_quota", "quota"],
    [
      { status: 429, error: { code: "insufficient_quota" } },
      undefined,
      "quota",
    ],
    [{ error: { type: "overloaded_error" } }, undefined, "overloaded"],
    [{}, "billing error: credit balance too low", "quota"],
    [{}, "subscription usage limit reached", "quota"],
    [{ status: 529 }, "overloaded_error", "overloaded"],
    [
      {},
      "Primary anthropic/claude failed: 429 rate_limit_error; fallback openai/gpt failed: Invalid 'input[282].id'",
      "rate_limit",
    ],
    [
      {},
      "Primary failed: overloaded; fallback failed: insufficient_quota",
      "quota",
    ],
    // ALG-700 incident strings
    [
      { status: 400 },
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 4543685 tokens > 1000000 maximum"}}',
      "context_overflow",
    ],
    [
      {},
      "Agent error: Invalid 'input[1].content[0].text': string too long. Expected a string with maximum length 10485760, but got a string with length 14355887 instead.",
      "context_overflow",
    ],
    [
      {},
      "Primary anthropic/claude-sonnet-5-5 failed: 400 prompt is too long: 4543685 tokens > 1000000 maximum; fallback openai-codex/gpt-6.1-sol failed: Invalid 'input[1].content[0].text': string too long.",
      "context_overflow",
    ],
    [{}, "Context overflow recovery failed: summarization failed", "context_overflow"],
    [{}, "This model's maximum context length is 128000 tokens", "context_overflow"],
    [{}, "context_length_exceeded", "context_overflow"],
    [{}, "input exceeds the context window of this model", "context_overflow"],
    [{ status: 429 }, "prompt is too long; rate_limit_error", "rate_limit"],
    [{}, "prompt is too long; insufficient_quota", "quota"],
    [{}, "overloaded_error; context length exceeded", "overloaded"],
    [{ kind: "context_overflow" }, "unknown", "context_overflow"],
    [{}, "Failed to fetch context window metadata", "generic"],
    [{}, "Invalid context_length configuration", "generic"],
    [{}, "tool output string too long to display", "generic"],
    [{ code: "tool_deadline" }, "stopped", "tool_deadline"],
    [{ code: "max" }, "stopped", "max_run_time"],
    [{ code: "idle" }, "stopped", "idle_timeout"],
    [{ code: "shutdown_enforcement" }, "stopped", "generic"],
    [{ kind: "quota" }, "unknown", "quota"],
    [{ kind: "invalid" }, "unknown", "generic"],
    [undefined, "unknown", "generic"],
  ])("classifies %j / %s as %s", (error, message, kind) => {
    expect(classifyRunFailure(error, message)).toBe(kind);
  });

  const cyber =
    "Cyber safeguards flagged this message. If this is legitimate security work, you can apply for the Cyber Verification Program: https://example.test";
  const tos =
    "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.";
  const refused = "The model refused to complete the request";

  it.each([
    ["cyber filter", new Error(cyber), undefined],
    ["ToS filter", {}, tos],
    ["refusal stop reason", {}, refused],
    ["lower case", {}, "cyber SAFEGUARDS flagged this message"],
    ["Agent error wrapper", new Error(`Agent error: ${cyber}`), undefined],
    [
      "Primary wrapper",
      {},
      `Primary anthropic/claude-sonnet-5-5 failed: ${refused}; fallback openai/gpt failed: 400`,
    ],
    ["wins over rate limit", { status: 429 }, `429 rate_limit: ${tos}`],
    ["wins over quota", {}, `${refused} (usage limit reached)`],
  ])("classifies a safety refusal (%s)", (_label, error, message) => {
    expect(classifyRunFailure(error, message)).toBe("safety_refusal");
    expect(isSafetyRefusal(error, message)).toBe(true);
  });

  it.each([
    [{ status: 429 }, "rate_limit_error"],
    [{}, "Something unrelated failed"],
    [{}, "Provider stopped with: sensitive"],
  ])("does not flag %j / %s as a safety refusal", (error, message) => {
    expect(isSafetyRefusal(error, message)).toBe(false);
  });
});

describe("runFailureMessage", () => {
  it("uses the fixed English and French catalog", () => {
    expect(runFailureMessage("rate_limit", "en")).toBe(
      "The AI service is temporarily rate-limited. Please try again in a few minutes."
    );
    expect(runFailureMessage("overloaded", "fr")).toBe(
      "Le service IA est temporairement saturé. Merci de réessayer dans quelques minutes."
    );
    expect(runFailureMessage("quota", "en")).toBe(
      "The AI service quota for this workspace is exhausted. Your administrator has been notified."
    );
    expect(runFailureMessage("quota", "fr")).toBe(
      "Le quota du service IA pour cet espace est épuisé. Votre administrateur a été prévenu."
    );
    for (const kind of [
      "tool_deadline",
      "max_run_time",
      "idle_timeout",
    ] as const) {
      expect(runFailureMessage(kind, "en")).toBe(
        "Sorry, this request took too long and was stopped. Partial changes may exist. Please try again or ask me to continue."
      );
      expect(runFailureMessage(kind, "fr")).toBe(
        "Désolé, cette demande a pris trop de temps et a été interrompue. Des modifications partielles peuvent exister. Réessayez ou demandez-moi de continuer."
      );
    }
    expect(runFailureMessage("context_overflow", "en")).toBe(
      "The attached file or conversation is too large for the model to read in chat. Attach a smaller file, or start a new conversation."
    );
    expect(runFailureMessage("context_overflow", "fr")).toBe(
      "Le fichier joint ou la conversation est trop volumineux pour que le modèle le lise dans le chat. Joignez un fichier plus petit ou démarrez une nouvelle conversation."
    );
    expect(runFailureMessage("generic", "en")).toBe(
      "Something went wrong, please try again."
    );
    expect(runFailureMessage("generic", "fr")).toBe(
      "Une erreur est survenue, merci de réessayer."
    );
    expect(runFailureMessage("safety_refusal", "en")).toBe(
      "The AI provider's safety filter blocked this message, so it was not kept. You can rephrase or carry on."
    );
    expect(runFailureMessage("safety_refusal", "fr")).toBe(
      "Le filtre de sécurité du fournisseur d'IA a bloqué ce message, il n'a donc pas été conservé. Vous pouvez le reformuler ou continuer."
    );
  });

  it("never incorporates untrusted context", () => {
    for (const kind of RunFailureKindSchema.options) {
      for (const lang of ["en", "fr"] as const) {
        expect(
          runFailureMessage(kind, lang, { toolName: "secret-request-id" })
        ).not.toContain("secret-request-id");
      }
    }
  });
});

describe("run failure schemas", () => {
  it("defaults language to English and preserves French", () => {
    const agent = {
      id: "test",
      name: "Test",
      workspace: "/test",
      model: { provider: "anthropic", model: "claude" },
    };
    expect(AgentConfigSchema.parse(agent).language).toBe("en");
    expect(AgentConfigSchema.parse({ ...agent, language: "fr" }).language).toBe(
      "fr"
    );
    expect(
      AgentConfigSchema.safeParse({ ...agent, language: "de" }).success
    ).toBe(false);
  });

  it("preserves admin channels and compatible error events", () => {
    expect(
      NotificationsConfigSchema.parse({ adminChannel: "admin" }).adminChannel
    ).toBe("admin");
    expect(StreamEventSchema.parse({ type: "error", message: "raw" })).toEqual({
      type: "error",
      message: "raw",
    });
    expect(
      StreamEventSchema.parse({
        type: "error",
        message: "raw",
        kind: "quota",
        userMessage: "safe",
      })
    ).toMatchObject({ kind: "quota", userMessage: "safe" });
    expect(RunFailureKindSchema.parse("safety_refusal")).toBe("safety_refusal");
    expect(
      StreamEventSchema.parse({
        type: "error",
        message: "raw",
        kind: "safety_refusal",
        userMessage: "safe",
      })
    ).toMatchObject({ kind: "safety_refusal" });
    expect(
      StreamEventSchema.parse({ type: "error", message: "raw", kind: "context_overflow" })
    ).toMatchObject({ kind: "context_overflow" });
  });
});
