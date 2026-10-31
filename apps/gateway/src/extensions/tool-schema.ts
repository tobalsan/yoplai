import { Ajv2020 } from "ajv/dist/2020.js";

const ajv = new Ajv2020();

export function validateToolParameters(schema: Record<string, unknown>):
  | { ok: true; schema: Record<string, unknown> }
  | { ok: false; reason: string } {
  try {
    const reason = validationError(schema);
    if (reason === undefined) return { ok: true, schema };
    if (!isObject(schema)) return { ok: false, reason };
    const moved: string[][] = [];
    const nestedDefinitions: string[][] = [];
    const refs: { keyword: string; value: string }[] = [];
    const unambiguous = walkSchemas(schema, (node, path) => {
      if (path.length > 0 && ("$id" in node || "definitions" in node)) return false;
      if (path.length > 0) nestedDefinitions.push([...path, "definitions"]);
      if ("definitions" in node && "$defs" in node) return false;
      if ("definitions" in node) moved.push([...path, "definitions"]);
      if (Array.isArray(node.items) && ("prefixItems" in node || "additionalItems" in node)) return false;
      if (Array.isArray(node.items)) moved.push([...path, "items"]);
      for (const [exclusive, inclusive] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]]) {
        if (node[exclusive] === true && typeof node[inclusive] !== "number") return false;
        if (node[exclusive] === true) moved.push([...path, inclusive]);
        if (node[exclusive] === false) moved.push([...path, exclusive]);
      }
      if ("required" in node && !Array.isArray(node.required)) moved.push([...path, "required"]);
      if (path.length === 0 && "$schema" in node) moved.push(["$schema"]);
      for (const keyword of ["$ref", "$dynamicRef"]) {
        if (typeof node[keyword] === "string") refs.push({ keyword, value: node[keyword] });
      }
      return true;
    });
    if (!unambiguous) return { ok: false, reason };
    for (const { keyword, value } of refs) {
      if (!value.startsWith("#")) continue;
      let fragment: string;
      try {
        fragment = decodeURIComponent(value.slice(1));
      } catch {
        return { ok: false, reason };
      }
      if (!fragment.startsWith("/")) continue;
      const tokens = fragment.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
      if (nestedDefinitions.some((location) => isPrefix(location, tokens))) return { ok: false, reason };
      for (const location of moved) {
        if (!isPrefix(location, tokens)) continue;
        // This rewrite covers only root definitions, never a moved child within it.
        if (location.length === 1 && location[0] === "definitions" && keyword === "$ref" && value.startsWith("#/definitions/")) continue;
        return { ok: false, reason };
      }
    }
    const repaired = structuredClone(schema);
    delete repaired.$schema;
    if ("definitions" in repaired) {
      repaired.$defs = repaired.definitions;
      delete repaired.definitions;
    }
    walkSchemas(repaired, (node) => {
      if (Array.isArray(node.items)) {
        node.prefixItems = node.items;
        delete node.items;
      }
      for (const [exclusive, inclusive] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]]) {
        if (node[exclusive] === false) delete node[exclusive];
        else if (node[exclusive] === true && typeof node[inclusive] === "number") {
          node[exclusive] = node[inclusive];
          delete node[inclusive];
        }
      }
      if (typeof node.$ref === "string" && node.$ref.startsWith("#/definitions/")) {
        node.$ref = node.$ref.replace("#/definitions/", "#/$defs/");
      }
      if ("required" in node && !Array.isArray(node.required)) delete node.required;
      return true;
    });
    const repairError = validationError(repaired);
    return repairError === undefined ? { ok: true, schema: repaired } : { ok: false, reason: repairError };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function isPrefix(location: string[], pointer: string[]): boolean {
  return location.length <= pointer.length && location.every((token, index) => pointer[index] === token);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Keyword values that contain schemas; data and custom keyword values stay opaque.
function walkSchemas(
  schema: unknown,
  visit: (node: Record<string, unknown>, path: string[]) => boolean,
  path: string[] = []
): boolean {
  if (!isObject(schema)) return true;
  if (!visit(schema, path)) return false;
  for (const key of ["properties", "patternProperties", "$defs", "dependentSchemas", "dependencies", ...(path.length === 0 ? ["definitions"] : [])]) {
    if (!isObject(schema[key])) continue;
    for (const [name, child] of Object.entries(schema[key])) {
      if (!walkSchemas(child, visit, [...path, key, name])) return false;
    }
  }
  for (const key of ["items", "contains", "additionalProperties", "propertyNames", "if", "then", "else", "not", "unevaluatedItems", "unevaluatedProperties", "contentSchema"]) {
    if (!walkSchemas(schema[key], visit, [...path, key])) return false;
  }
  for (const key of ["prefixItems", "allOf", "anyOf", "oneOf", "items"]) {
    const children = schema[key];
    if (!Array.isArray(children)) continue;
    for (const [index, child] of children.entries()) {
      if (!walkSchemas(child, visit, [...path, key, String(index)])) return false;
    }
  }
  return true;
}

function validationError(schema: Record<string, unknown>): string | undefined {
  const validationSchema = isObject(schema) ? { ...schema } : schema;
  if (isObject(validationSchema)) delete validationSchema.$schema;
  if (ajv.validateSchema(validationSchema)) return undefined;
  const error = ajv.errors![0];
  return `${error.instancePath} ${error.message}`;
}
