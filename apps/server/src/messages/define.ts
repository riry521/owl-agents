export type MessageParams = Readonly<Record<string, string | number>>;

/** A reference to a row of a message table: the key and the values to put in its {placeholders}. */
export interface MessageRef {
  readonly key: string;
  readonly params?: MessageParams;
}

export interface MessageEntry {
  readonly ja: string;
  readonly en: string;
}

// Why not a plain object: the key can come from outside (a ref built from a response), so lookups use a Map and cannot hit prototype keys.
const registry = new Map<string, MessageEntry>();

export function isMessageRef(value: unknown): value is MessageRef {
  return typeof value === "object" && value !== null && typeof (value as MessageRef).key === "string";
}

export function lookupMessage(key: string): MessageEntry | undefined {
  return registry.get(key);
}

/**
 * Registers one domain's messages and returns a builder per message.
 * `const M = defineMessages("memory", { notFound: { ja: "…", en: "…" } })`
 * then `new ApiError(404, "not_found", M.notFound())`. Put values in the text
 * as {name} and pass them as `M.badField({ name: "limit" })`.
 * The registry key is "<domain>.<name>"; registering a key twice throws.
 */
export function defineMessages<T extends Record<string, MessageEntry>>(
  domain: string,
  entries: T,
): { readonly [K in keyof T]: (params?: MessageParams) => MessageRef } {
  const builders: Record<string, (params?: MessageParams) => MessageRef> = {};
  for (const [name, entry] of Object.entries(entries)) {
    const key = `${domain}.${name}`;
    if (registry.has(key)) throw new Error(`Duplicate message key: ${key}`);
    registry.set(key, entry);
    builders[name] = (params) => (params === undefined ? { key } : { key, params });
  }
  return builders as { readonly [K in keyof T]: (params?: MessageParams) => MessageRef };
}
