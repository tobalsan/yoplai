import { describe, expect, it } from "vitest";
import {
  classifyRunFailure,
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
    expect(runFailureMessage("generic", "en")).toBe(
      "Something went wrong, please try again."
    );
    expect(runFailureMessage("generic", "fr")).toBe(
      "Une erreur est survenue, merci de réessayer."
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
  });
});
