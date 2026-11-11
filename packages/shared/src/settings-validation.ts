import { isRecord } from "./small-helpers.js";
export { isRecord };

/** 反した条件の種類と値。message（英語）とは別に、言語ごとの文を作る側へ構造で渡す。 */
export type SettingsCondition =
  | { readonly kind: "not_object" }
  | { readonly kind: "exact_keys"; readonly keys: readonly string[] }
  | { readonly kind: "boolean" }
  | { readonly kind: "integer_min"; readonly min: number }
  | { readonly kind: "integer_range"; readonly min: number; readonly max: number }
  | { readonly kind: "number_range"; readonly min: number; readonly max: number }
  | { readonly kind: "one_of"; readonly values: readonly (string | number)[] }
  /** 必須のキーをすべて持ち、ほかは任意のキーだけを持つ。 */
  | { readonly kind: "keys"; readonly required: readonly string[]; readonly optional: readonly string[] }
  /** 1 つ以上のキーを持ち、どれも keys のいずれか。 */
  | { readonly kind: "known_keys"; readonly keys: readonly string[] }
  | { readonly kind: "array" }
  | { readonly kind: "array_length"; readonly min: number; readonly max: number }
  | { readonly kind: "string" }
  | { readonly kind: "non_empty_string" }
  | { readonly kind: "string_list" }
  | { readonly kind: "non_empty_string_list" }
  /** 空でない文字列で、どれも正規表現として読める。 */
  | { readonly kind: "regex_list" }
  /** キャプチャグループ 1 を持つ正規表現。 */
  | { readonly kind: "regex_with_group" }
  /** どれも HH:MM の時刻。 */
  | { readonly kind: "hh_mm_list" }
  /** どれも max_length 文字以下の空でない glob で、glob として読める。 */
  | { readonly kind: "glob_list"; readonly max_length: number }
  /** values の中から重複なく選んだ一覧。 */
  | { readonly kind: "distinct_one_of_list"; readonly values: readonly string[] }
  /** 先頭が空白だけでない引数を 1 つ以上持つ一覧。 */
  | { readonly kind: "argv" }
  /** グループ名から一覧へのオブジェクトで、グループは max_groups 個以下、名前は 1 から max_name_length 文字。 */
  | { readonly kind: "named_groups"; readonly max_groups: number; readonly max_name_length: number }
  /** 小文字・数字・_ を単一の - で区切った max_length 文字以下で、末尾に - を 1 つ付けてもよい。 */
  | { readonly kind: "channel_name_prefix"; readonly max_length: number };

/** 設定の検証エラーの親。field はエラーになった欄の名前（全体なら "payload"）。condition は分かる場合だけ付く。 */
export class SettingsValidationError<F extends string = string> extends Error {
  public declare readonly condition?: SettingsCondition;

  public constructor(message: string, public readonly field: F, condition?: SettingsCondition) {
    super(message);
    // Not a parameter property: that would always define an own `condition` key, even when undefined.
    if (condition !== undefined) Object.defineProperty(this, "condition", { value: condition, enumerable: true });
  }
}

/** キーの組が決まっている設定の検証関数を作る。 */
export function exactKeysValidator<T, K extends keyof T & string = keyof T & string>(spec: {
  readonly keys: readonly K[];
  /** 値が正しければ値を返し、不正なら設定のエラークラスを throw する。 */
  readonly check: (key: K, value: unknown) => unknown;
  /** エラークラス。"payload" を field に取れること。 */
  readonly error: new (message: string, field: "payload", condition?: SettingsCondition) => SettingsValidationError;
  /** キーの組が違うときのメッセージ。省略すると `Settings must contain exactly ${keys.join(", ")}.` */
  readonly exactKeysMessage?: string;
}): (value: unknown) => T {
  return (value) => {
    if (!isRecord(value)) throw new spec.error("Settings must be an object.", "payload", { kind: "not_object" });
    const own = Reflect.ownKeys(value);
    if (own.length !== spec.keys.length || !spec.keys.every((key) => own.includes(key))) {
      throw new spec.error(spec.exactKeysMessage ?? `Settings must contain exactly ${spec.keys.join(", ")}.`, "payload", { kind: "exact_keys", keys: spec.keys });
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
