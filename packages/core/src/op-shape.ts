// Evens out harmless shape drift in model-proposed operations, using only a definition table
// (operation name -> required / optional fields). No operation name is known here: each receiver
// passes its own table. Anything the table cannot settle to exactly one reading is left alone,
// so the receiver's own validation still rejects it with the code it always used.
// Why not per-operation fixes: they would have to be rewritten for every receiver and new operation.

export interface OpDefinition { required: Readonly<Record<string, unknown>>; optional?: Readonly<Record<string, unknown>> }
export type OpDefinitions = Readonly<Record<string, OpDefinition>>;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The defined name that `value` spells apart from case and surrounding spaces, or null. */
function definedName(value: unknown, defs: OpDefinitions): string | null {
  if (typeof value !== "string") return null;
  const wanted = value.trim().toLowerCase();
  const hits = Object.keys(defs).filter((name) => name.toLowerCase() === wanted);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Returns the flat operation (`{op: name, ...fields}`) for a raw one, or null when it cannot be settled:
 * not an object, unknown name, two or more wrapper keys, or the wrapper key and an `op` field disagree.
 * Handles: `op` with different case or spaces, and `{name: {...fields}}` with or without a matching `op`.
 */
export function normalizeOp(raw: unknown, defs: OpDefinitions): Record<string, unknown> | null {
  if (!isPlain(raw)) return null;
  const hasOp = Object.hasOwn(raw, "op");
  if (hasOp && typeof raw.op !== "string") return null;
  const outer = hasOp ? definedName(raw.op, defs) : null;
  if (hasOp && outer === null) return null;
  const wrapperKeys = Object.keys(raw).filter((k) => k !== "op");
  const wrapped = wrapperKeys.length === 1 ? definedName(wrapperKeys[0], defs) : null;
  const inner = wrapped === null ? null : raw[wrapperKeys[0]];
  if (wrapped !== null && isPlain(inner)) {
    if (outer !== null && outer !== wrapped) return null;
    if (Object.hasOwn(inner, "op") && definedName(inner.op, defs) !== wrapped) return null;
    return { ...inner, op: wrapped };
  }
  return outer === null ? null : { ...raw, op: outer };
}

/**
 * The key holding the operation list in a model output: `listKey` itself when present; otherwise the
 * only key outside `otherKeys` that holds an array. Null when that is not unique.
 */
export function findListKey(output: Readonly<Record<string, unknown>>, listKey: string, otherKeys: readonly string[]): string | null {
  if (Object.hasOwn(output, listKey)) return listKey;
  const rest = Object.keys(output).filter((k) => !otherKeys.includes(k));
  return rest.length === 1 && Array.isArray(output[rest[0]]) ? rest[0] : null;
}
