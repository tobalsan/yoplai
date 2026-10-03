import { describe, expect, it } from "vitest";
import {
  buildAutoFormFields,
  REDACTED_SECRET_VALUE,
  splitAutoFormValues,
} from "./auto-form-schema";

describe("buildAutoFormFields", () => {
  it("masks schema-marked optional credential fields without making them required", () => {
    const fields = buildAutoFormFields({ properties: { password: { type: "string", writeOnly: true }, token: { type: "string", format: "password" } } });
    expect(fields).toMatchObject([{ name: "password", secret: true, required: false }, { name: "token", secret: true, required: false }]);
  });
  it("returns no fields for a null/empty schema", () => {
    expect(buildAutoFormFields(null, [])).toEqual([]);
    expect(buildAutoFormFields({}, [])).toEqual([]);
    expect(buildAutoFormFields({ properties: {} }, [])).toEqual([]);
  });

  it("builds a masked secret field for a requiredSecrets property (exa tracer)", () => {
    const fields = buildAutoFormFields(
      {
        type: "object",
        properties: { apiKey: { type: "string" } },
        required: ["apiKey"],
      },
      ["apiKey"]
    );
    expect(fields).toEqual([
      {
        name: "apiKey",
        label: "Api Key",
        description: undefined,
        type: "secret",
        required: true,
        secret: true,
        advanced: false,
      },
    ]);
  });

  it("drops the base `enabled` toggle", () => {
    const fields = buildAutoFormFields(
      {
        properties: {
          enabled: { type: "boolean" },
          apiKey: { type: "string" },
        },
      },
      ["apiKey"]
    );
    expect(fields.map((f) => f.name)).toEqual(["apiKey"]);
  });

  it("maps schema types to field types and honors title/description", () => {
    const fields = buildAutoFormFields(
      {
        properties: {
          host: { type: "string", title: "Host", description: "The host URL" },
          port: { type: "integer" },
          verbose: { type: "boolean" },
        },
        required: ["host"],
      },
      []
    );
    expect(fields).toEqual([
      {
        name: "host",
        label: "Host",
        description: "The host URL",
        type: "text",
        required: true,
        secret: false,
        advanced: false,
      },
      {
        name: "port",
        label: "Port",
        description: undefined,
        type: "number",
        required: false,
        secret: false,
        advanced: false,
      },
      {
        name: "verbose",
        label: "Verbose",
        description: undefined,
        type: "boolean",
        required: false,
        secret: false,
        advanced: false,
      },
    ]);
  });

  it("humanizes camelCase property names when title is absent", () => {
    const fields = buildAutoFormFields(
      {
        properties: {
          apiToken: { type: "string" },
          serviceAccountJson: { type: "string" },
          timeoutMs: { type: "integer" },
          readOnly: { type: "boolean" },
          subdomain: { type: "string" },
        },
      },
      []
    );
    expect(fields.map((f) => f.label)).toEqual([
      "Api Token",
      "Service Account Json",
      "Timeout Ms",
      "Read Only",
      "Subdomain",
    ]);
  });

  it("humanizes snake_case and hyphenated property names", () => {
    const fields = buildAutoFormFields(
      {
        properties: {
          jira_project_keys: { type: "string" },
          "some-hyphenated-key": { type: "string" },
        },
      },
      []
    );
    expect(fields.map((f) => f.label)).toEqual([
      "Jira Project Keys",
      "Some Hyphenated Key",
    ]);
  });

  it("uses the explicit title verbatim instead of humanizing", () => {
    const fields = buildAutoFormFields(
      {
        properties: {
          apiToken: { type: "string", title: "apiToken (legacy)" },
        },
      },
      []
    );
    expect(fields[0].label).toBe("apiToken (legacy)");
  });

  it("treats a secret field as secret even when its schema type is not string", () => {
    const fields = buildAutoFormFields(
      { properties: { token: { type: "integer" } } },
      ["token"]
    );
    expect(fields[0].type).toBe("secret");
    expect(fields[0].secret).toBe(true);
    expect(fields[0].required).toBe(true);
  });

  it("marks fields listed by the extension as advanced", () => {
    const fields = buildAutoFormFields(
      {
        properties: {
          apiKey: { type: "string" },
          timeoutMs: { type: "integer" },
        },
      },
      ["apiKey"],
      ["timeoutMs"]
    );
    expect(fields.map((field) => ({ name: field.name, advanced: field.advanced }))).toEqual([
      { name: "apiKey", advanced: false },
      { name: "timeoutMs", advanced: true },
    ]);
  });
});

describe("splitAutoFormValues", () => {
  const fields = buildAutoFormFields(
    {
      properties: {
        apiKey: { type: "string" },
        host: { type: "string" },
        port: { type: "integer" },
        verbose: { type: "boolean" },
      },
    },
    ["apiKey"]
  );

  it("routes secrets to `secrets` and non-secrets to `config`", () => {
    const { config, secrets } = splitAutoFormValues(fields, {
      apiKey: "sk-123",
      host: "example.com",
      port: "8080",
      verbose: true,
    });
    expect(secrets).toEqual({ apiKey: "sk-123" });
    expect(config).toEqual({ host: "example.com", port: 8080, verbose: true });
  });

  it("omits blank text/number and empty secrets, keeps booleans", () => {
    const { config, secrets } = splitAutoFormValues(fields, {
      apiKey: "",
      host: "",
      port: "",
      verbose: false,
    });
    expect(secrets).toEqual({});
    expect(config).toEqual({ verbose: false });
  });

  it("omits unchanged redacted secrets", () => {
    const { secrets } = splitAutoFormValues(fields, {
      apiKey: REDACTED_SECRET_VALUE,
    });
    expect(secrets).toEqual({});
  });

  it("drops non-numeric number input", () => {
    const { config } = splitAutoFormValues(fields, { port: "abc" });
    expect(config).not.toHaveProperty("port");
  });
});
