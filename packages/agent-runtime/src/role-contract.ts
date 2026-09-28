import { isRecord, parseSingleJsonObject, unwrapClaudeCliResult, unwrapCodexCliResult } from "./protocol";
import type { ProviderResponse } from "./types";
import { outputLanguageInstruction, WORKING_STYLE_RULES, type OwnerLanguage, type SkillFeedback } from "@owl/shared";

/**
 * One definition per role output. Each role schema below is used three ways
 * so the prompt, the provider and the validator cannot drift apart:
 *   1. renderOutputTemplate() turns it into the JSON template the prompt asks
 *      the model to fill in (every field present);
 *   2. providerSchema() is the exact object passed to the provider
 *      (Claude `--json-schema`, Codex `--output-schema`);
 *   3. validateRoleOutput() checks the parsed answer strictly against it.
 *
 * Only a small JSON Schema subset is used, chosen to be accepted by both
 * Claude structured output and OpenAI strict structured output: every object
 * lists all of its properties as required and forbids additional ones.
 */
export type RoleSchemaType = "object" | "array" | "string" | "integer" | "number" | "boolean" | "null";

export interface RoleSchema {
  readonly type: RoleSchemaType | readonly RoleSchemaType[];
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly properties?: Readonly<Record<string, RoleSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly items?: RoleSchema;
  readonly minItems?: number;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  /**
   * Template hint only: the value renderOutputTemplate() shows for this field.
   * It is not a validation keyword and providerSchema() strips it.
   */
  readonly example?: unknown;
}

export const SKILLS_USED_SCHEMA: RoleSchema = {
  type: "array",
  items: objectSchema({
    name: { type: "string", description: "name of a skill you used" },
    verdict: { type: "string", enum: ["helpful", "misleading", "irrelevant"], description: "how the skill applied" },
    note: { type: "string", description: "brief optional context; empty when none" },
  }),
  example: [],
  description: "skills actually used and how they applied; [] if none",
};

export const SKILL_PROPOSALS_SCHEMA: RoleSchema = {
  type: "array",
  items: objectSchema({
    kind: { type: "string", enum: ["new", "update"], description: "create a new skill or update an existing one" },
    target: { type: ["string", "null"], description: "existing skill name for update, otherwise null" },
    summary: { type: "string", description: "what reusable procedure should be captured" },
    steps_or_diff: { type: "string", description: "reusable steps or the change needed in the existing skill" },
    evidence: { type: "string", description: "why the procedure is reusable or the skill needs correction" },
  }),
  example: [],
  description: "proposals for reusable procedures or skill improvements; [] if none",
};

const SKILL_OUTPUT_FIELDS = new Set(["skills_used", "skill_proposals"]);

/** Adds empty fields only for a legacy answer that contains no skill fields. */
export function prepareLegacySkillOutput(
  schema: RoleSchema,
  payload: Record<string, unknown>,
): { readonly payload: Record<string, unknown>; readonly hasSkillFields: boolean } {
  const fields = Object.keys(schema.properties ?? {}).filter((field) => SKILL_OUTPUT_FIELDS.has(field));
  const hasSkillFields = fields.some((field) => Object.prototype.hasOwnProperty.call(payload, field));
  if (hasSkillFields || fields.length === 0) return { payload, hasSkillFields };
  return { payload: { ...payload, ...Object.fromEntries(fields.map((field) => [field, []])) }, hasSkillFields: false };
}

export function skillFeedbackFromOutput(payload: Record<string, unknown>, hasSkillFields: boolean): SkillFeedback | null {
  if (!hasSkillFields) return null;
  return {
    skills_used: payload.skills_used as SkillFeedback["skills_used"],
    skill_proposals: (payload.skill_proposals ?? []) as SkillFeedback["skill_proposals"],
  };
}

/** Object schema whose every property is required and no other key is allowed. */
export function objectSchema(
  properties: Readonly<Record<string, RoleSchema>>,
  description?: string,
): RoleSchema {
  return {
    type: "object",
    ...(description ? { description } : {}),
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function schemaTypes(schema: RoleSchema): readonly RoleSchemaType[] {
  return typeof schema.type === "string" ? [schema.type] : schema.type;
}

function childPath(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

/** The fill-in placeholder shown for a string field in the prompt template. */
function templatePlaceholder(schema: RoleSchema): string {
  return `<${schema.description ?? "text"}>`;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(type: RoleSchemaType, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

/**
 * Validate `value` against `schema`. Returns null when it conforms, otherwise
 * the first violation as `<path>:<problem>` (for example
 * `findings[0].line:expected_integer` or `tasks[1].priority:not_allowed`).
 */
export function validateRoleOutput(schema: RoleSchema, value: unknown, path = ""): string | null {
  const at = path.length === 0 ? "$" : path;
  const types = schemaTypes(schema);
  const type = types.find((candidate) => matchesType(candidate, value));
  if (type === undefined) {
    return `${at}:expected_${types.join("_or_")}_got_${describeValue(value)}`;
  }
  if (type === "string") {
    const text = value as string;
    if (schema.enum && !schema.enum.includes(text)) return `${at}:not_one_of_${schema.enum.join("|")}`;
    if (schema.minLength !== undefined && text.trim().length < schema.minLength) return `${at}:empty`;
    if (!schema.enum && text === templatePlaceholder(schema)) return `${at}:template_placeholder`;
    return null;
  }
  if (type === "integer") {
    if (schema.minimum !== undefined && (value as number) < schema.minimum) return `${at}:below_${schema.minimum}`;
    if (schema.maximum !== undefined && (value as number) > schema.maximum) return `${at}:above_${schema.maximum}`;
    return null;
  }
  if (type === "number") {
    if (schema.minimum !== undefined && (value as number) < schema.minimum) return `${at}:below_${schema.minimum}`;
    if (schema.maximum !== undefined && (value as number) > schema.maximum) return `${at}:above_${schema.maximum}`;
    return null;
  }
  if (type === "array") {
    const items = value as readonly unknown[];
    if (schema.minItems !== undefined && items.length < schema.minItems) return `${at}:fewer_than_${schema.minItems}_items`;
    if (schema.items) {
      for (let index = 0; index < items.length; index += 1) {
        const problem = validateRoleOutput(schema.items, items[index], `${path}[${index}]`);
        if (problem) return problem;
      }
    }
    return null;
  }
  if (type === "object") {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) return `${childPath(path, key)}:missing`;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) return `${childPath(path, key)}:not_allowed`;
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const problem = validateRoleOutput(propertySchema, record[key], childPath(path, key));
      if (problem) return problem;
    }
  }
  return null;
}

/**
 * Render the fill-in JSON template for a schema: every object field is present,
 * strings show `<description>`, enums show their first value, nullable fields
 * show null, integers show their minimum, booleans show false, and an array
 * of objects shows one example element so the element shape is visible. A
 * field's `example` hint overrides the rendered value.
 */
export function renderOutputTemplate(schema: RoleSchema): unknown {
  if (schema.example !== undefined) return schema.example;
  const types = schemaTypes(schema);
  if (types.includes("null") && types.length > 1 && !types.includes("object") && !types.includes("array")) {
    return null;
  }
  const type = types.find((candidate) => candidate !== "null") ?? "null";
  switch (type) {
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, property]) => [key, renderOutputTemplate(property)]),
      );
    case "array":
      return schema.items && schemaTypes(schema.items).includes("object") ? [renderOutputTemplate(schema.items)] : [];
    case "string":
      return schema.enum?.[0] ?? templatePlaceholder(schema);
    case "integer":
      return schema.minimum ?? 0;
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    case "null":
      return null;
  }
}

function describeType(schema: RoleSchema): string {
  const types = schemaTypes(schema);
  return types
    .map((type) => {
      if (type === "string" && schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
      if (type === "array" && schema.items) {
        const itemTypes = schemaTypes(schema.items);
        return itemTypes.includes("object") ? "array of objects" : `array of ${itemTypes.join(" | ")}`;
      }
      if ((type === "integer" || type === "number") && schema.minimum !== undefined) return `${type} >= ${schema.minimum}`;
      if (type === "string" && schema.minLength) return "non-empty string";
      return type;
    })
    .join(" | ");
}

/** One line per field (`path: type - description`), generated from the schema. */
export function renderFieldReference(schema: RoleSchema, path = ""): string[] {
  const lines: string[] = [];
  const types = schemaTypes(schema);
  if (types.includes("object") && schema.properties) {
    for (const [key, property] of Object.entries(schema.properties)) {
      const propertyPath = childPath(path, key);
      lines.push(`- ${propertyPath}: ${describeType(property)}${property.description ? ` - ${property.description}` : ""}`);
      lines.push(...renderFieldReference(property, propertyPath));
    }
  } else if (types.includes("array") && schema.items && schemaTypes(schema.items).includes("object")) {
    lines.push(...renderFieldReference(schema.items, `${path}[]`));
  }
  return lines;
}

/** The exact schema object given to the provider for enforcement. */
export function providerSchema(schema: RoleSchema): Readonly<Record<string, unknown>> {
  // minLength is enforced by validateRoleOutput only: OpenAI strict structured
  // outputs (Codex --output-schema) reject it as an unsupported keyword.
  const { example: _example, minLength: _minLength, properties, items, ...rest } = schema;
  return {
    ...rest,
    ...(properties
      ? { properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, providerSchema(value)])) }
      : {}),
    ...(items ? { items: providerSchema(items) } : {}),
  };
}

export interface RolePromptSlots {
  /** Opening line naming the role (tests and fake providers key on it). */
  readonly role: string;
  /** Role and mode instructions; fixed text for a given role and mode. */
  readonly instructions: readonly string[];
  /** Process-specific procedure references for the installed role. */
  readonly processSkills?: readonly string[] | null;
  /** Guidance for working in a known git worktree; see renderWorkspaceToolsNote. */
  readonly workspaceTools?: readonly string[] | null;
  /** The one schema definition for this role and mode's output. */
  readonly output: RoleSchema;
  /** Semantic rules the schema cannot express. */
  readonly outputRules: readonly string[];
  /** The Owner's language: every human-readable output value is written in it. */
  readonly language: OwnerLanguage;
  /** Named input blocks, always the same names in the same order per role and mode. */
  readonly inputs: readonly { readonly name: string; readonly value: unknown }[];
}

/**
 * The single prompt template shared by the Manager, Worker, Hybrid and
 * Reviewer roles. Sections and headings never change; only slot values do.
 */
/** Shared for every role. Intermediate output is never shown to anyone; only the final JSON is read. */
export const WORKING_STYLE_HEADING = "## Working style";

const ROLE_INPUT_HEADINGS = { section: "## Input", input: "### " } as const;

function renderRoleInputName(name: string): string {
  return name
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

function parseRoleInputName(value: string): string | null {
  let name = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      name += character;
      continue;
    }
    const escape = value[index + 1];
    if (escape === "\\") {
      name += "\\";
      index += 1;
    } else if (escape === "n") {
      name += "\n";
      index += 1;
    } else if (escape === "r") {
      name += "\r";
      index += 1;
    } else {
      return null;
    }
  }
  return name;
}

export function renderRolePrompt(slots: RolePromptSlots): string {
  return [
    slots.role,
    ["## Instructions", ...slots.instructions].join("\n"),
    ...(slots.processSkills && slots.processSkills.length > 0
      ? [["## Process skills", ...slots.processSkills].join("\n")]
      : []),
    ...(slots.workspaceTools && slots.workspaceTools.length > 0
      ? [["## Workspace tools", ...slots.workspaceTools].join("\n")]
      : []),
    [WORKING_STYLE_HEADING, ...WORKING_STYLE_RULES].join("\n"),
    [
      "## Output template",
      "Return exactly one JSON object and nothing else: no markdown fences, no prose before or after. Copy this template, keep every field, and replace only the values. An array shown with one example element may hold zero or more elements of that shape.",
      JSON.stringify(renderOutputTemplate(slots.output), null, 2),
    ].join("\n"),
    ["## Output fields", ...renderFieldReference(slots.output), ...slots.outputRules].join("\n"),
    ["## Output language", outputLanguageInstruction(slots.language)].join("\n"),
    [ROLE_INPUT_HEADINGS.section, ...slots.inputs.map((input) => `${ROLE_INPUT_HEADINGS.input}${renderRoleInputName(input.name)}\n${JSON.stringify(input.value, null, 2)}`)].join("\n\n"),
  ].join("\n\n");
}

export function splitRolePrompt(prompt: string): { header: string; inputs: Record<string, unknown>; shape: string } | null {
  const sectionMarker = `${ROLE_INPUT_HEADINGS.section}\n\n`;
  const markerAt = prompt.lastIndexOf(sectionMarker);
  if (markerAt < 0) {
    if (prompt.endsWith(ROLE_INPUT_HEADINGS.section)) {
      const header = prompt.slice(0, -ROLE_INPUT_HEADINGS.section.length);
      return { header, inputs: {}, shape: "[]" };
    }
    return null;
  }

  const inputText = prompt.slice(markerAt + sectionMarker.length);
  const headingPattern = new RegExp(`(?:^|(?<=\\n))${ROLE_INPUT_HEADINGS.input}([^\\n]*)\\n`, "g");
  const headings = [...inputText.matchAll(headingPattern)];
  if (inputText.length > 0 && (headings.length === 0 || headings[0]?.index !== 0)) return null;

  try {
    const inputs: Record<string, unknown> = {};
    const shape: [string, string][] = [];
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index];
      if (!heading || heading.index === undefined) return null;
      const name = parseRoleInputName(heading[1] ?? "");
      if (name === null) return null;
      if (Object.prototype.hasOwnProperty.call(inputs, name)) return null;
      const start = heading.index + heading[0].length;
      const end = headings[index + 1]?.index ?? inputText.length;
      const value: unknown = JSON.parse(inputText.slice(start, end).trim());
      Object.defineProperty(inputs, name, { value, enumerable: true, configurable: true, writable: true });
      const kind = Array.isArray(value) ? "array" : value === null ? "null" : isRecord(value) ? "object" : typeof value;
      shape.push([name, kind]);
    }
    return { header: prompt.slice(0, markerAt), inputs, shape: JSON.stringify(shape) };
  } catch {
    return null;
  }
}

/**
 * Read the role's JSON object from provider output. Claude `--json-schema`
 * returns the answer as `structured_output` (an object) with `result` holding
 * text; without a schema, or on older CLIs, `result` holds the JSON text.
 * Codex returns the final agent message text. Plain-text providers return
 * the JSON text directly. No fence or prose tolerance is applied anywhere:
 * the provider schema is what keeps the model on the contract.
 */
export function extractRoleOutputObject(
  response: Pick<ProviderResponse, "adapter" | "stdout" | "format">,
  reason: string,
): Record<string, unknown> {
  const format = response.format ?? "provider-json";
  if (format !== "provider-json") {
    return parseSingleJsonObject(response.stdout, reason);
  }
  const text = response.adapter === "codex" || response.adapter.startsWith("codex")
    ? unwrapCodexCliResult(response.stdout)
    : unwrapClaudeCliResult(response.stdout);
  return parseSingleJsonObject(text, reason);
}
