import type { CoreReasonCode, CoreReasonValues } from "@owl/core";

/** One sentence per language for one reason code; each is written wholly in its language. */
export interface ReasonText<V> {
  ja: (values: V) => string;
  en: (values: V) => string;
}

/** Requiring every CoreReasonCode here makes a code without a sentence a type error. */
export type ReasonTable<K extends CoreReasonCode> = { [C in K]: ReasonText<CoreReasonValues[C]> };
