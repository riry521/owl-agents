function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function schemaTypes(schema: RoleSchema): readonly RoleSchemaType[] {
  return typeof schema.type === "string" ? [schema.type] : schema.type;
}

export function childPath(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

/** The fill-in placeholder shown for a string field in the prompt template. */
export function templatePlaceholder(schema: RoleSchema): string {
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
