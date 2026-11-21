import type { AssistantImages, ImageApi, ImageModel } from "@earendil-works/pi-ai";
import { GatewayConfigSchema } from "@yoplai/shared";
import { expect, it, vi } from "vitest";
import type { OAuthTokensDeps } from "../sdk/container/oauth-tokens.js";
import { generateImage } from "./generate.js";

const codexConfig = GatewayConfigSchema.parse({
  agents: [],
  imageGeneration: { provider: "openai-codex" },
});

const fakeAccessToken = [
  "fixture",
  Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
  })).toString("base64url"),
  "signature",
].join(".");

function codexOAuth(): OAuthTokensDeps {
  return {
    authPath: "/fixture/image-generation-auth.json",
    createRuntime: async () => ({ getAuth: async () => ({}) }),
    readCredential: async () => ({
      type: "oauth", access: fakeAccessToken, expires: Date.now() + 3_600_000,
    }),
  };
}

it("generates a PNG through the gateway ChatGPT connection", async () => {
  const fetchImage = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/hQAAAAASUVORK5CYII=" }],
  }));
  const image = await generateImage("A seagull over a harbor", codexConfig, undefined, {
    fetch: fetchImage, oauth: codexOAuth(),
  });

  expect(image.mimeType).toBe("image/png");
  expect(image.bytes.toString("hex")).toBe(
    "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da63fcff1f0003030200ef9afe140000000049454e44ae426082",
  );
  expect(fetchImage).toHaveBeenCalledWith(
    "https://chatgpt.com/backend-api/codex/images/generations",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: `Bearer ${fakeAccessToken}`,
        "chatgpt-account-id": "fixture-account",
        originator: "pi",
      }),
    }),
  );
  expect(JSON.parse(fetchImage.mock.calls[0][1]?.body as string)).toEqual({
    prompt: "A seagull over a harbor", model: "gpt-image-2", n: 1,
  });
});

it.each([
  { status: 429, body: "Too many requests", message: "The ChatGPT image quota is used up" },
  {
    status: 400,
    body: '{"error":{"type":"usage_limit_reached","resets_at":1795276800}}',
    message: "The ChatGPT image quota is used up (resets at 2026-11-21T16:00:00.000Z)",
  },
  { status: 401, body: "Unauthorized", message: "The ChatGPT connection was rejected or the account has no image access" },
  { status: 403, body: "Forbidden", message: "The ChatGPT connection was rejected or the account has no image access" },
  { status: 503, body: '{"error":{"message":"Untrusted failure","access_token":"codex-canary-value"}}', message: "Image generation failed (HTTP 503)" },
  { status: 502, body: "<html>Bad gateway</html>", message: "Image generation failed (HTTP 502)" },
  { status: 200, body: "not JSON", message: "Image generation failed (HTTP 200)" },
  { status: 200, body: '{"data":[]}', message: "Image generation returned no image" },
])("reports a final, safe ChatGPT image error for HTTP $status and $message", async ({ status, body, message }) => {
  const fetchImage = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(generateImage("A harbor", codexConfig, undefined, {
      fetch: fetchImage, oauth: codexOAuth(),
    })).rejects.toHaveProperty("message", `${message}; no fallback is configured`);
    const logs = JSON.stringify(warning.mock.calls);
    expect(logs).not.toContain("codex-canary-value");
    if (status === 503) expect(logs).toContain("[REDACTED]");
  } finally {
    warning.mockRestore();
  }
});

it.each(["missing", "expired"])("asks an admin to reconnect a %s ChatGPT connection", async (connection) => {
  const oauth = codexOAuth();
  if (connection === "missing") oauth.readCredential = async () => undefined;
  else oauth.createRuntime = async () => ({
    getAuth: async () => { throw new Error("Refresh rejected"); },
  });
  const fetchImage = vi.fn<typeof fetch>();
  await expect(generateImage("A harbor", codexConfig, undefined, {
    fetch: fetchImage, oauth,
  })).rejects.toHaveProperty("message",
    "The ChatGPT connection is missing or expired. Ask an admin to reconnect it; no fallback is configured",
  );
  expect(fetchImage).not.toHaveBeenCalled();
});

const providerConfig = GatewayConfigSchema.parse({
  agents: [],
  imageGeneration: { provider: "openrouter", model: "vendor/image-model" },
});

const providerModel: ImageModel<ImageApi> = {
  type: "image",
  id: "vendor/image-model",
  name: "Fixture image model",
  api: "openrouter-images",
  provider: "openrouter",
  baseUrl: "https://fixture.invalid",
  input: ["text"],
  output: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function providerResponse(output: AssistantImages["output"]): AssistantImages {
  return {
    api: "openrouter-images", provider: "openrouter", model: "vendor/image-model",
    timestamp: 0, output, stopReason: "stop",
  };
}

it("sends text to the configured image model and returns its first image with its MIME type", async () => {
  const generateImages = vi.fn().mockResolvedValue(providerResponse([
    { type: "text", text: "Image caption" },
    { type: "image", data: "/9j/2Q==", mimeType: "image/jpeg" },
    { type: "image", data: "UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAA=", mimeType: "image/webp" },
  ]));
  const signal = new AbortController().signal;
  const image = await generateImage("A bicycle by the beach", providerConfig, signal, {
    oauth: { ...codexOAuth(), readCredential: async () => undefined },
    createRuntime: async () => ({
      getModelOfType: (type, provider, model) =>
        type === "image" && provider === "openrouter" && model === "vendor/image-model" ? providerModel : undefined,
      generateImages,
    }),
  });

  expect(image.mimeType).toBe("image/jpeg");
  expect(image.bytes.toString("hex")).toBe("ffd8ffd9");
  expect(generateImages).toHaveBeenCalledWith(
    providerModel, { input: [{ type: "text", text: "A bicycle by the beach" }] }, { signal },
  );
});

it.each([
  { model: providerModel, outcome: "error", message: "Image generation failed on openrouter/vendor/image-model" },
  { model: providerModel, outcome: "rejection", message: "Image generation failed on openrouter/vendor/image-model" },
  { model: providerModel, outcome: "empty", message: "Image generation returned no image" },
  { model: undefined, outcome: "unknown model", message: "The configured image generation model was not found" },
])("reports a safe final provider/model error for $outcome", async ({ model, outcome, message }) => {
  const rawError = '401 provider response {"access_token":"provider-canary-value"}';
  const generateImages = vi.fn(async () => {
    if (outcome === "rejection") throw new Error(rawError);
    if (outcome === "error") {
      return { ...providerResponse([]), stopReason: "error" as const, errorMessage: rawError };
    }
    return providerResponse([{ type: "text", text: "No image" }]);
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(generateImage("A bicycle by the beach", providerConfig, undefined, {
      createRuntime: async () => ({ getModelOfType: () => model, generateImages }),
    })).rejects.toHaveProperty("message", `${message}; no fallback is configured`);
    const logs = JSON.stringify(warning.mock.calls);
    expect(logs).not.toContain("provider-canary-value");
    if (outcome === "error" || outcome === "rejection") expect(logs).toContain("[REDACTED]");
  } finally {
    warning.mockRestore();
  }
});

it.each(["Codex", "model provider"])("redacts escaped credential fields in %s diagnostics", async (backend) => {
  const syntheticValue = "canary-before\"canary-after";
  const nested = JSON.stringify({ access_token: syntheticValue });
  const body = JSON.stringify({ error: { refresh_token: syntheticValue, message: nested } });
  const options = backend === "Codex"
    ? { fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 503 })), oauth: codexOAuth() }
    : { createRuntime: async () => ({
      getModelOfType: () => providerModel,
      generateImages: async (): Promise<AssistantImages> => ({
        ...providerResponse([]), stopReason: "error", errorMessage: `503: ${body}`,
      }),
    }) };
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(generateImage("A bicycle by the beach", backend === "Codex" ? codexConfig : providerConfig, undefined, options))
      .rejects.toThrow("no fallback is configured");
    const logs = JSON.stringify(warning.mock.calls);
    expect(logs.includes("canary-before")).toBe(false);
    expect(logs.includes("canary-after")).toBe(false);
    expect(logs).toContain("[REDACTED]");
  } finally {
    warning.mockRestore();
  }
});

it.each(["!!!", "/9j/2Q=="])("rejects a provider's PNG result with invalid or mismatched bytes", async (data) => {
  await expect(generateImage("A park", providerConfig, undefined, {
    createRuntime: async () => ({
      getModelOfType: () => providerModel,
      generateImages: async () => providerResponse([{ type: "image", mimeType: "image/png", data }]),
    }),
  })).rejects.toHaveProperty("message", "Image generation returned an invalid image; no fallback is configured");
});

it("cancels a caller waiting for a shared OAuth refresh while another caller can finish", async () => {
  const controller = new AbortController();
  let startRefresh!: () => void;
  let finishRefresh!: () => void;
  const refreshStarted = new Promise<void>((resolve) => { startRefresh = resolve; });
  const refreshFinished = new Promise<void>((resolve) => { finishRefresh = resolve; });
  const oauth = {
    ...codexOAuth(),
    createRuntime: async () => ({
      getAuth: async () => {
        startRefresh();
        await refreshFinished;
        return {};
      },
    }),
  };
  const fetchImage = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({ data: [{ b64_json: "/9j/2Q==" }] }),
  );
  const cancelled = generateImage("A hill", codexConfig, controller.signal, { fetch: fetchImage, oauth });
  const other = generateImage("A river", codexConfig, undefined, { fetch: fetchImage, oauth });

  await refreshStarted;
  controller.abort(new Error("Untrusted cancellation reason"));
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise((resolve) => { watchdog = setTimeout(resolve, 250); });
    await expect(Promise.race([cancelled, expired])).rejects.toHaveProperty("message",
      "Image generation was cancelled; no fallback is configured",
    );
    expect(fetchImage).not.toHaveBeenCalled();
  } finally {
    clearTimeout(watchdog);
    finishRefresh();
    await Promise.allSettled([other, cancelled]);
  }
  await expect(other).resolves.toEqual({ bytes: Buffer.from("ffd8ffd9", "hex"), mimeType: "image/jpeg" });
  expect(fetchImage).toHaveBeenCalledTimes(1);
});
