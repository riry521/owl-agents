/** 配列ではないオブジェクトかどうか。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 設定の検証エラーの親。field はエラーになった欄の名前（全体なら "payload"）。 */
export class SettingsValidationError<F extends string = string> extends Error {
  public constructor(message: string, public readonly field: F) {
    super(message);
  }
}

/** キーの組が決まっている設定の検証関数を作る。 */
export function exactKeysValidator<T, K extends keyof T & string = keyof T & string>(spec: {
  readonly keys: readonly K[];
  /** 値が正しければ値を返し、不正なら設定のエラークラスを throw する。 */
  readonly check: (key: K, value: unknown) => unknown;
  /** エラークラス。"payload" を field に取れること。 */
  readonly error: new (message: string, field: "payload") => SettingsValidationError;
  /** キーの組が違うときのメッセージ。省略すると `Settings must contain exactly ${keys.join(", ")}.` */
  readonly exactKeysMessage?: string;
}): (value: unknown) => T {
  return (value) => {
    if (!isRecord(value)) throw new spec.error("Settings must be an object.", "payload");
    const own = Reflect.ownKeys(value);
    if (own.length !== spec.keys.length || !spec.keys.every((key) => own.includes(key))) {
      throw new spec.error(spec.exactKeysMessage ?? `Settings must contain exactly ${spec.keys.join(", ")}.`, "payload");
    }
    return Object.fromEntries(spec.keys.map((key) => [key, spec.check(key, value[key])])) as T;
  };
}

/** キーごとに既定値に戻す読み取り関数を作る。 */
export function keyedReader<T, K extends keyof T & string = keyof T & string>(spec: {
  readonly keys: readonly K[];
  readonly defaults: T;
  readonly check: (key: K, value: unknown) => unknown;
  /** オブジェクトでないときの警告。 */
  readonly notObject: string;
  /** 値が不正なときの警告。 */
  readonly invalid: (key: K) => string;
  /** 知らないキーがあるときの警告。省略すると知らないキーには何も言わない。 */
  readonly unknown?: (key: string) => string;
}): (value: unknown, warn?: (message: string) => void) => T {
  return (value, warn) => {
    if (!isRecord(value)) {
      warn?.(spec.notObject);
      return spec.defaults;
    }
    if (spec.unknown) {
      for (const key of Reflect.ownKeys(value)) {
        if (!(spec.keys as readonly (string | symbol)[]).includes(key)) warn?.(spec.unknown(String(key)));
      }
    }
    return Object.fromEntries(spec.keys.map((key) => {
      if (!Object.hasOwn(value, key)) return [key, spec.defaults[key]];
      try {
        return [key, spec.check(key, value[key])];
      } catch {
        warn?.(spec.invalid(key));
        return [key, spec.defaults[key]];
      }
    })) as T;
  };
}
