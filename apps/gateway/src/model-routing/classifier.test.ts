import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRoutingConfigSchema, type ModelRoutingRow } from "@yoplai/shared";
import type { ClassifierAnswer, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { createRoutingClassifier, type ClassifierRuntime, type WorkRequestResult, type CategoryResult } from "./classifier.js";

const model: ClassifierModel<"openai-decisions"> = {
  type: "classifier", api: "openai-decisions", provider: "openai", id: "gpt-6-luna",
  name: "Classifier fixture", baseUrl: "https://invalid.test", input: ["text"],
  contextWindow: 10000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function response(question: string, answer: ClassifierAnswer): ClassifierResult {
  return {
    api: "openai-decisions", provider: "openai", model: "gpt-6-luna",
    answers: { [question]: answer }, stopReason: "stop", timestamp: 0,
  };
}

function runtime(classify: ClassifierRuntime["classify"]): ClassifierRuntime {
  return { getModelOfType: () => model, classify };
}

function row(id: string): ModelRoutingRow {
  return {
    id, definition: `Tasks for ${id}`, examples: [`Example of ${id}`],
    claude: { provider: "anthropic", model: "sonnet", effort: "medium" },
    chatgpt: { provider: "openai-codex", model: "sol", effort: "medium" }, pool: "either",
  };
}

const categoryConfig = () => ModelRoutingConfigSchema.parse({
  floor: [], table: [row("office_deliverable"), row("single_tool_call")],
});

describe("routing classifier deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Node's native AbortSignal.timeout uses internal timers; use the same signal contract with Vitest's clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([
    ["predicate", "runtime", 20], ["predicate", "provider", 20],
    ["category", "runtime", 40], ["category", "provider", 40],
  ] as const)("bounds %s including a stalled %s", async (method, stage, budget) => {
    let seenSignal: AbortSignal | undefined;
    const classifier = createRoutingClassifier({ ...categoryConfig(), budgets: { predicateMs: 20, categoryMs: 40 } }, {
      getApiKey: () => "fixture-key",
      createRuntime: async (signal) => {
        seenSignal = signal;
        if (stage === "runtime") return new Promise(() => {});
        return runtime(async (_model, _context, options) => {
          seenSignal = options?.signal;
          return new Promise(() => {});
        });
      },
    });
    let result: WorkRequestResult | CategoryResult | undefined;
    const input = { agentId: "casey", text: "Task" };
    const pending = (method === "predicate" ? classifier.checkWorkRequest(input) : classifier.classifyCategory(input))
      .then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(budget - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ status: "unavailable", reason: "timeout" });
    expect(seenSignal?.aborted).toBe(true);
    await pending;
  });

  it.each(["predicate", "category"] as const)("cancels %s promptly when its caller aborts", async (method) => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const classifier = createRoutingClassifier(categoryConfig(), {
      getApiKey: () => "fixture-key",
      createRuntime: async () => runtime(async (_model, _context, options) => {
        receivedSignal = options?.signal;
        return new Promise(() => {});
      }),
    });
    const input = { agentId: "casey", text: "Task", signal: controller.signal };
    let result: WorkRequestResult | CategoryResult | undefined;
    const pending = (method === "predicate" ? classifier.checkWorkRequest(input) : classifier.classifyCategory(input))
      .then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual({ status: "unavailable", reason: "aborted" });
    expect(receivedSignal?.aborted).toBe(true);
    await pending;
  });

  it("does not start a late vendor request after timeout and permits the next request", async () => {
    let release: (value: ClassifierRuntime) => void = () => {};
    const lateRuntime = new Promise<ClassifierRuntime>((resolve) => { release = resolve; });
    let creates = 0;
    const lateClassify = vi.fn();
    const classifier = createRoutingClassifier({ ...categoryConfig(), budgets: { predicateMs: 20, categoryMs: 40 } }, {
      getApiKey: () => "fixture-key",
      createRuntime: async () => ++creates === 1 ? lateRuntime
        : runtime(async () => response("work_request", { type: "bool", probability: 0.9 })),
    });
    const input = { agentId: "casey", text: "Task" };
    const first = classifier.checkWorkRequest(input);
    await vi.advanceTimersByTimeAsync(20);
    await expect(first).resolves.toEqual({ status: "unavailable", reason: "timeout" });
    await expect(classifier.checkWorkRequest(input)).resolves.toEqual({ status: "ok", isWorkRequest: true, probability: 0.9 });
    release(runtime(lateClassify));
    await vi.advanceTimersByTimeAsync(0);
    expect(lateClassify).not.toHaveBeenCalled();
  });
});

describe("routing classifier", () => {
  it("returns unavailable without constructing a runtime when the API key is blank", async () => {
    const createRuntime = vi.fn();
    const classifier = createRoutingClassifier(ModelRoutingConfigSchema.parse({}), {
      getApiKey: () => "  ",
      createRuntime,
    });

    await expect(classifier.checkWorkRequest({ agentId: "casey", text: "Hi" }))
      .resolves.toEqual({ status: "unavailable", reason: "no_key" });
    await expect(classifier.classifyCategory({ agentId: "casey", text: "Hi" }))
      .resolves.toEqual({ status: "unavailable", reason: "no_key" });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it.each([[0.5, true], [0.4999, false], [0.98, true], [0.01, false]] as const)(
    "answers the work predicate at probability %s", async (probability, expected) => {
      const classifier = createRoutingClassifier(ModelRoutingConfigSchema.parse({}), {
        getApiKey: () => " fixture-key ",
        createRuntime: async () => runtime(async (_model, context, options) => {
          // Explicit API-key auth prevents stored subscription credentials from being selected.
          expect(options?.apiKey).toBe("fixture-key");
          expect(options?.maxRetries).toBe(1);
          expect(context.questions.work_request).toMatchObject({
            type: "bool",
            criteria: { false: expect.stringMatching(/greeting.*what can you do.*test.*ack/i) },
          });
          return response("work_request", { type: "bool", probability });
        }),
      });

      await expect(classifier.checkWorkRequest({ agentId: "casey", text: "Please reply to this ticket" }))
        .resolves.toEqual({ status: "ok", isWorkRequest: expected, probability });
    }
  );

  it("averages by category id across forward and reversed choices", async () => {
    const orders: string[][] = [];
    const classifier = createRoutingClassifier(categoryConfig(), {
      getApiKey: () => "fixture-key",
      createRuntime: async () => runtime(async (_model, context) => {
        const question = context.questions.category;
        if (question.type !== "choice") throw new Error("Expected choices");
        const ids = Object.keys(question.criteria);
        orders.push(ids);
        expect(question.criteria.office_deliverable).toContain("Example of office_deliverable");
        return response("category", { type: "choice", choice: ids[0], confidence: 0.8,
          probabilities: { [ids[0]]: orders.length === 1 ? 0.8 : 0.6, [ids[1]]: orders.length === 1 ? 0.2 : 0.4 } });
      }),
    });

    const result = await classifier.classifyCategory({ agentId: "casey", text: "Make a slide deck" });
    expect(orders).toEqual([["office_deliverable", "single_tool_call"], ["single_tool_call", "office_deliverable"]]);
    expect(result).toEqual({ status: "ok", category: "office_deliverable", score: expect.closeTo(0.6, 12),
      probabilities: { office_deliverable: expect.closeTo(0.6, 12), single_tool_call: 0.4 } });
  });

  it.each([
    ["OpenAI Decisions refused to answer work_request", "refusal"],
    ["OpenAI Decisions did not return an answer for category", "malformed"],
    ["OpenAI Decisions did not return a predicate answer for work_request", "malformed"],
    ["OpenAI Decisions returned an unexpected response", "malformed"],
    ["OpenAI Decisions returned an invalid probability for work_request", "malformed"],
    ["OpenAI Decisions returned invalid probabilities for category", "malformed"],
    ["OpenAI Decisions error (503): unavailable", "provider_error"],
    ["An unrecognized future error", "provider_error"],
  ])("maps Pi's error fixture '%s' to %s", async (errorMessage, reason) => {
    const classifier = createRoutingClassifier(categoryConfig(), {
      getApiKey: () => "fixture-key",
      createRuntime: async () => runtime(async () => ({
        api: "openai-decisions", provider: "openai", model: "gpt-6-luna",
        answers: {}, stopReason: "error", timestamp: 0, errorMessage,
      })),
    });
    await expect(classifier.checkWorkRequest({ agentId: "casey", text: "Task" }))
      .resolves.toEqual({ status: "unavailable", reason });
    await expect(classifier.classifyCategory({ agentId: "casey", text: "Task" }))
      .resolves.toEqual({ status: "unavailable", reason });
  });

  it.each([
    { type: "choice", choice: "office_deliverable", confidence: 1, probabilities: { stranger: 1 } },
    { type: "choice", choice: "stranger", confidence: 1, probabilities: { office_deliverable: 1 } },
    { type: "choice", choice: "office_deliverable", confidence: 1, probabilities: { office_deliverable: NaN } },
    { type: "choice", choice: "office_deliverable", confidence: 1, probabilities: { office_deliverable: Infinity } },
    { type: "choice", choice: "office_deliverable", confidence: 1, probabilities: { office_deliverable: -0.1 } },
    { type: "choice", choice: "office_deliverable", confidence: 1, probabilities: { office_deliverable: 1.1 } },
    { type: "choice", choice: "office_deliverable", confidence: NaN, probabilities: { office_deliverable: 1 } },
    { type: "choice", choice: "office_deliverable", confidence: 1, probabilities: null },
    { type: "choice", choice: "office_deliverable", confidence: 1, probabilities: [] },
    { type: "bool", probability: 0.9 },
    undefined,
  ])("rejects malformed category answers (%j)", async (answer) => {
    const classifier = createRoutingClassifier(categoryConfig(), {
      getApiKey: () => "fixture-key",
      createRuntime: async () => runtime(async () => response("category", answer as ClassifierAnswer)),
    });
    await expect(classifier.classifyCategory({ agentId: "casey", text: "Task" }))
      .resolves.toEqual({ status: "unavailable", reason: "malformed" });
  });

  it("counts a missing category probability as zero even for an object-property name", async () => {
    const config = ModelRoutingConfigSchema.parse({ floor: [], table: [row("constructor"), row("single_tool_call")] });
    const classifier = createRoutingClassifier(config, {
      getApiKey: () => "fixture-key",
      createRuntime: async () => runtime(async () => response("category", {
        type: "choice", choice: "single_tool_call", confidence: 0.6,
        probabilities: { single_tool_call: 0.6 },
      })),
    });
    await expect(classifier.classifyCategory({ agentId: "casey", text: "Task" }))
      .resolves.toEqual({ status: "ok", category: "single_tool_call", score: 0.6,
        probabilities: { constructor: 0, single_tool_call: 0.6 } });
  });

  it.each([
    [0.8, 0.2, true], [0.7999, 0.2001, false], [0.5, 0.5, false],
  ] as const)("returns score %s for the caller's inclusive threshold comparison", async (first, second, routes) => {
    const classifier = createRoutingClassifier(categoryConfig(), {
      getApiKey: () => "fixture-key",
      createRuntime: async () => runtime(async () => response("category", {
        type: "choice", choice: "single_tool_call", confidence: 1,
        probabilities: { office_deliverable: first, single_tool_call: second },
      })),
    });
    const result = await classifier.classifyCategory({ agentId: "casey", text: "Task" });
    expect(result).toEqual({ status: "ok", category: "office_deliverable", score: first,
      probabilities: { office_deliverable: first, single_tool_call: second } });
    if (result.status !== "ok") throw new Error("Expected a genuine score");
    expect(result.score >= 0.8).toBe(routes);
  });

  it.each([-0.1, 1.1, NaN, Infinity])("rejects invalid predicate probabilities (%s)", async (probability) => {
    const classifier = createRoutingClassifier(categoryConfig(), {
      getApiKey: () => "fixture-key",
      createRuntime: async () => runtime(async () => response("work_request", { type: "bool", probability })),
    });
    await expect(classifier.checkWorkRequest({ agentId: "casey", text: "Task" }))
      .resolves.toEqual({ status: "unavailable", reason: "malformed" });
  });

  it("treats a successful response without an answer map as malformed", async () => {
    const classifier = createRoutingClassifier(categoryConfig(), {
      getApiKey: () => "fixture-key",
      createRuntime: async () => runtime(async () => ({
        ...response("work_request", { type: "bool", probability: 1 }), answers: null,
      }) as unknown as ClassifierResult),
    });
    await expect(classifier.checkWorkRequest({ agentId: "casey", text: "Task" }))
      .resolves.toEqual({ status: "unavailable", reason: "malformed" });
    await expect(classifier.classifyCategory({ agentId: "casey", text: "Task" }))
      .resolves.toEqual({ status: "unavailable", reason: "malformed" });
  });

  it("returns unavailable if only the reversed order fails", async () => {
    let calls = 0;
    const classifier = createRoutingClassifier(categoryConfig(), {
      getApiKey: () => "fixture-key",
      createRuntime: async () => runtime(async () => ++calls === 1
        ? response("category", { type: "choice", choice: "office_deliverable", confidence: 1, probabilities: { office_deliverable: 1 } })
        : { ...response("category", { type: "bool", probability: 0 }), answers: {}, stopReason: "error", errorMessage: "OpenAI Decisions refused to answer category" }),
    });
    await expect(classifier.classifyCategory({ agentId: "casey", text: "Task" }))
      .resolves.toEqual({ status: "unavailable", reason: "refusal" });
  });

  it("uses the configured classifier, truncates human text, and reads a fresh key on every call", async () => {
    const config = ModelRoutingConfigSchema.parse({ classifier: { provider: "fixture", model: "router" }, version: "v-test", maxRetries: 2 });
    let key = " first-fixture-key ";
    const classifier = createRoutingClassifier(config, {
      getApiKey: () => key,
      createRuntime: async () => ({
        getModelOfType: (type, provider, id) => type === "classifier" && provider === "fixture" && id === "router" ? model : undefined,
        classify: async (_model, context, options) => {
          expect(context.state).toEqual({ agentId: "casey", text: "x".repeat(6000) });
          expect(context.questions.work_request.instructions).toContain("v-test");
          expect(options?.apiKey).toBe(key.trim());
          expect(options?.maxRetries).toBe(2);
          return response("work_request", { type: "bool", probability: 0.9 });
        },
      }),
    });
    const input = { agentId: "casey", text: "x".repeat(6010) };
    await expect(classifier.checkWorkRequest(input)).resolves.toEqual({ status: "ok", isWorkRequest: true, probability: 0.9 });
    key = "";
    await expect(classifier.checkWorkRequest(input)).resolves.toEqual({ status: "unavailable", reason: "no_key" });
    key = "second-fixture-key";
    await expect(classifier.checkWorkRequest(input)).resolves.toEqual({ status: "ok", isWorkRequest: true, probability: 0.9 });
  });

  it("keeps floor categories when restricting choices and uses the whole table when omitted", async () => {
    const config = ModelRoutingConfigSchema.parse({ floor: ["customer_support_reply"],
      table: [row("writing_marketing"), row("customer_support_reply"), row("single_tool_call")] });
    const orders: string[][] = [];
    const classifier = createRoutingClassifier(config, {
      getApiKey: () => "fixture-key",
      createRuntime: async () => runtime(async (_model, context) => {
        const question = context.questions.category;
        if (question.type !== "choice") throw new Error("Expected choices");
        orders.push(Object.keys(question.criteria));
        return response("category", { type: "choice", choice: "single_tool_call", confidence: 1, probabilities: { single_tool_call: 1 } });
      }),
    });
    const input = { agentId: "casey", text: "Task" };
    await classifier.classifyCategory({ ...input, categories: ["single_tool_call"] });
    await classifier.classifyCategory(input);
    expect(orders).toEqual([
      ["customer_support_reply", "single_tool_call"], ["single_tool_call", "customer_support_reply"],
      ["writing_marketing", "customer_support_reply", "single_tool_call"], ["single_tool_call", "customer_support_reply", "writing_marketing"],
    ]);
  });

  it.each(["create", "classify", "missing_model", "aborted"] as const)("contains unexpected runtime outcomes (%s)", async (outcome) => {
    const classifier = createRoutingClassifier(categoryConfig(), {
      getApiKey: () => "fixture-key",
      createRuntime: async () => {
        if (outcome === "create") throw new Error("Runtime failed");
        return {
          getModelOfType: () => outcome === "missing_model" ? undefined : model,
          classify: async () => {
            if (outcome === "classify") throw new Error("Request failed");
            return { ...response("work_request", { type: "bool", probability: 0 }), answers: {}, stopReason: "aborted" };
          },
        };
      },
    });
    const expected = { status: "unavailable", reason: outcome === "aborted" ? "aborted" : "provider_error" };
    await expect(classifier.checkWorkRequest({ agentId: "casey", text: "Task" })).resolves.toEqual(expected);
    await expect(classifier.classifyCategory({ agentId: "casey", text: "Task" })).resolves.toEqual(expected);
  });
});
