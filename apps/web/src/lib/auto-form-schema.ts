// Turns an extension's config JSON-schema (+ its `requiredSecrets`) into a flat
// list of form-field descriptors the schema-driven auto-form renderer can draw.
// Kept pure and framework-free so it can be unit-tested without a DOM.

export type AutoFormFieldType = "text" | "number" | "boolean" | "secret";

export const REDACTED_SECRET_VALUE = "********";

export type AutoFormField = {
  /** Property name — the config/secret key written back to agent.yaml/.env. */
  name: string;
  /** Human label (schema `title` if present, else the property name). */
  label: string;
  /** Optional schema `description`, shown as help text. */
  description?: string;
  type: AutoFormFieldType;
  required: boolean;
  /** True when the field is a secret (masked input + written to .env). */
  secret: boolean;
  /** True when the extension wants this field hidden under advanced settings. */
  advanced: boolean;
};

type JsonSchema = {
  properties?: Record<string, unknown>;
  required?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

// A JSON-schema `type` can be a string or an array of strings (e.g. nullable
// fields). Pick the first non-"null" entry so an input still renders.
function primitiveType(schema: Record<string, unknown>): string | undefined {
  const raw = schema.type;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((t) => typeof t === "string" && t !== "null");
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function fieldType(
  schema: Record<string, unknown>,
  secret: boolean
): AutoFormFieldType {
  if (secret) return "secret";
  const type = primitiveType(schema);
  if (type === "boolean") return "boolean";
  if (type === "number" || type === "integer") return "number";
  return "text";
}

// Humanize a raw property name into a Title Cased label when the schema has
// no `title`: split camelCase/PascalCase boundaries plus underscores/hyphens
// into words, then capitalize each word (e.g. `serviceAccountJson` ->
// "Service Account Json", `jira_project_keys` -> "Jira Project Keys").
function humanizeName(name: string): string {
  const words = name
    .split(/[_-]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter((word) => word.length > 0);
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Build the ordered list of form fields from a config JSON-schema.
 *
 * - The base `enabled` toggle is dropped — the form always enables the
 *   extension on submit, so surfacing it as a field would be redundant.
 * - Fields named in `requiredSecrets` render as masked secret inputs and are
 *   marked `secret` regardless of their schema type.
 * - `required` reflects the schema's `required` array (secrets in that array
 *   are required too).
 */
export function buildAutoFormFields(
  configJsonSchema: Record<string, unknown> | null | undefined,
  requiredSecrets: string[] = [],
  advancedConfigFields: string[] = []
): AutoFormField[] {
  const schema = (configJsonSchema ?? {}) as JsonSchema;
  const properties = asRecord(schema.properties);
  if (!properties) return [];

  const secretSet = new Set(requiredSecrets);
  const advancedSet = new Set(advancedConfigFields);
  const requiredList = Array.isArray(schema.required)
    ? (schema.required.filter((v) => typeof v === "string") as string[])
    : [];
  const requiredSet = new Set(requiredList);

  const fields: AutoFormField[] = [];
  for (const [name, rawProp] of Object.entries(properties)) {
    if (name === "enabled") continue;
    const prop = asRecord(rawProp) ?? {};
    const secret = secretSet.has(name) || prop.writeOnly === true || prop.format === "password";
    const title =
      typeof prop.title === "string" ? prop.title : humanizeName(name);
    const description =
      typeof prop.description === "string" ? prop.description : undefined;
    fields.push({
      name,
      label: title,
      description,
      type: fieldType(prop, secret),
      required: requiredSet.has(name) || secretSet.has(name),
      secret,
      advanced: advancedSet.has(name),
    });
  }
  return fields;
}

export type AutoFormValues = Record<string, string | number | boolean>;

export type AutoFormSubmitPayload = {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
};

/**
 * Split raw form values into the write-path patch shape: secrets go to the
 * `.env` (as `$env:` refs in agent.yaml), non-secrets are written verbatim into
 * agent.yaml. Empty/blank optional values are omitted so we don't write empty
 * strings; empty secrets are dropped so we never clobber an existing secret with
 * a blank on a no-op resubmit.
 */
export function splitAutoFormValues(
  fields: AutoFormField[],
  values: AutoFormValues
): AutoFormSubmitPayload {
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};

  for (const field of fields) {
    const value = values[field.name];
    if (field.secret) {
      const text = typeof value === "string" ? value : "";
      if (text.length > 0 && text !== REDACTED_SECRET_VALUE) {
        secrets[field.name] = text;
      }
      continue;
    }
    if (field.type === "boolean") {
      config[field.name] = Boolean(value);
      continue;
    }
    if (field.type === "number") {
      if (value === "" || value === undefined || value === null) continue;
      const num = typeof value === "number" ? value : Number(value);
      if (!Number.isNaN(num)) config[field.name] = num;
      continue;
    }
    // text
    const text = typeof value === "string" ? value : "";
    if (text.length > 0) config[field.name] = text;
  }

  return { config, secrets };
}
