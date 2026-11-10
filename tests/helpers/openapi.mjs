import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { repoRoot } from "./paths.mjs";

// yaml is a dependency of packages/core only; the root package.json does not list it.
const { parse } = createRequire(join(repoRoot, "packages/core/package.json"))("yaml");

const METHODS = ["get", "head", "post", "put", "patch", "delete"];
const ANNOTATIONS = new Set(["description", "title", "example", "examples", "default", "deprecated", "readOnly", "writeOnly"]);
const KEYWORDS = new Set([
  "$ref", "type", "enum", "const", "required", "properties", "additionalProperties", "minProperties", "maxProperties",
  "items", "minItems", "maxItems", "uniqueItems", "minimum", "maximum", "minLength", "maxLength", "pattern", "format",
  "allOf", "anyOf", "oneOf",
]);
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const REF_PREFIX = "#/components/schemas/";

export function loadOpenApi() {
  return parse(readFileSync(join(repoRoot, "contracts/openapi/owl-api-v1.yaml"), "utf8"));
}

export function openApiOperations(document) {
  const operations = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) if (item && Object.hasOwn(item, method)) operations.push({ method: method.toUpperCase(), path });
  }
  return operations;
}

const isKnownKeyword = (key) => KEYWORDS.has(key) || ANNOTATIONS.has(key) || key.startsWith("x-");
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function resolveRef(document, ref) {
  if (typeof ref !== "string" || !ref.startsWith(REF_PREFIX)) return undefined;
  const name = ref.slice(REF_PREFIX.length);
  const schemas = document.components?.schemas ?? {};
  return Object.hasOwn(schemas, name) ? schemas[name] : undefined;
}

const typeMatches = (type, value) => {
  switch (type) {
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return isObject(value);
    default: return false;
  }
};

function validate(document, schema, value, path, refs) {
  if (!isObject(schema)) return [`${path}: invalid schema`];
  const errors = [];
  for (const key of Object.keys(schema)) {
    if (!isKnownKeyword(key)) errors.push(`${path}: unsupported keyword ${key}`);
  }
  if (schema.$ref !== undefined) {
    const target = resolveRef(document, schema.$ref);
    const mark = `${path}\u0000${schema.$ref}`;
    // JSON Schema 2020-12 evaluates keywords beside $ref too, so do not return here; only the
    // referenced branch carries the cycle mark.
    if (!target) errors.push(`${path}: cannot resolve ${schema.$ref}`);
    else if (refs.has(mark)) errors.push(`${path}: circular ${schema.$ref}`);
    else errors.push(...validate(document, target, value, path, new Set(refs).add(mark)));
  }
  const sub = (child, v, p) => validate(document, child, v, p, refs);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) errors.push(`${path}: expected ${types.join("|")}`);
  }
  if (schema.enum && !schema.enum.some((item) => isDeepStrictEqual(item, value))) errors.push(`${path}: not in enum`);
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(schema.const, value)) errors.push(`${path}: not const`);
  if (isObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}: missing ${key}`);
    const properties = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) errors.push(...sub(properties[key], value[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
      else if (isObject(schema.additionalProperties)) errors.push(...sub(schema.additionalProperties, value[key], `${path}.${key}`));
    }
    const count = Object.keys(value).length;
    if (schema.minProperties !== undefined && count < schema.minProperties) errors.push(`${path}: fewer than ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && count > schema.maxProperties) errors.push(`${path}: more than ${schema.maxProperties} properties`);
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((item, i) => errors.push(...sub(schema.items, item, `${path}[${i}]`)));
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems === true && value.some((a, i) => value.some((b, j) => i < j && isDeepStrictEqual(a, b)))) errors.push(`${path}: duplicate items`);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: pattern mismatch`);
    if (schema.format !== undefined) {
      if (schema.format !== "date-time") errors.push(`${path}: unsupported format ${schema.format}`);
      else if (!RFC3339.test(value) || Number.isNaN(Date.parse(value))) errors.push(`${path}: not date-time`);
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (!schema[key]) continue;
    const results = schema[key].map((child) => sub(child, value, path));
    const passed = results.filter((r) => r.length === 0).length;
    if (key === "allOf") results.forEach((r) => errors.push(...r));
    else if (key === "anyOf" && passed === 0) errors.push(`${path}: matches none of anyOf`, ...results.flat());
    else if (key === "oneOf" && passed !== 1) errors.push(`${path}: matches ${passed} of oneOf`);
  }
  return errors;
}

export function schemaErrors(document, value, ref) {
  return validate(document, { $ref: ref }, value, "$", new Set());
}

export function unsupportedKeywords(document, ref) {
  const found = [];
  const seen = new Set();
  const walk = (schema, owner) => {
    if (Array.isArray(schema)) return schema.forEach((child) => walk(child, owner));
    if (!isObject(schema)) return;
    for (const [key, child] of Object.entries(schema)) {
      if (key === "$ref") {
        const name = typeof child === "string" ? child.slice(REF_PREFIX.length) : "";
        const target = resolveRef(document, child);
        if (!target) found.push(`${owner}: unresolved $ref ${child}`);
        else if (!seen.has(name)) { seen.add(name); walk(target, name); }
      } else if (!isKnownKeyword(key)) found.push(`${owner}: ${key}`);
      else if (key === "properties") Object.values(child).forEach((c) => walk(c, owner));
      else if (["items", "additionalProperties", "allOf", "anyOf", "oneOf"].includes(key)) walk(child, owner);
    }
  };
  const name = ref.slice(REF_PREFIX.length);
  seen.add(name);
  walk(resolveRef(document, ref), name);
  return found;
}
