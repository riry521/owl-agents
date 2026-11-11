import type { Core, MemoryService } from "@owl/core";
import type { ExternalCoreAdapter } from "./core.js";
import { ApiError } from "./errors.js";
import { CoreFeatureMessages } from "./messages/core-feature.js";
import type { MessageRef } from "./messages/define.js";
import type { CorePort } from "./types.js";

export type OwlCore = Core;
type MethodKey<T> = { [P in keyof T]-?: T[P] extends (...args: never[]) => unknown ? P : never }[keyof T];
/** T の必須メンバーの名前。`?` の付くメンバーは入らない。 */
type RequiredKey<T> = { [P in keyof T]-?: {} extends Pick<T, P> ? never : P }[keyof T];
/** CorePort の必須メンバー。HTTP 層は context.core から直接呼ぶ。 */
export type CorePortDirectKey = RequiredKey<CorePort>;
/**
 * adapter が実装し、CorePort では必須でないメソッド。
 * keyof CorePort で除くと省略可能なメソッドまで除かれ、存在を確かめて呼ぶ手段が無くなる。
 * そのため必須のメンバーだけを除く。
 */
export type AdapterFeatureKey = Exclude<MethodKey<ExternalCoreAdapter>, CorePortDirectKey>;
/** 実 Core にあり、adapter には無いメソッド。 */
export type CoreFeatureKey = Exclude<MethodKey<OwlCore>, keyof ExternalCoreAdapter>;

type Assert<T extends true> = T;
/** 型だけの確認。CorePort の省略可能なメンバーは、すべて requireAdapterFeature に渡せる。 */
export type OptionalPortMethodsAreAdapterFeatures =
  Assert<[Exclude<Exclude<keyof CorePort, CorePortDirectKey>, AdapterFeatureKey>] extends [never] ? true : false>;

export interface CoreFeatureError {
  readonly code: "dependency_unavailable" | "core_not_ready";
  readonly message: string | MessageRef;
}

// 関数を取り出さず object 自身を返す。取り出すと呼ぶときの this が変わるため。
function firstWithMethods(candidates: readonly unknown[], keys: readonly string[]): object | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    if (keys.every((key) => typeof record[key] === "function")) return candidate;
  }
  return null;
}

const inner = (core: unknown): unknown => (core as { core?: unknown } | null | undefined)?.core;
const memoryOf = (core: unknown): unknown => (core as { memory?: unknown } | null | undefined)?.memory;

const unavailable = (error: CoreFeatureError): ApiError => new ApiError(503, error.code, error.message);

// Why not: core.core も見る案は採らない。adapter が包んだ実 Core の規約で呼ぶと、adapter の規約と取り違えるため。
export function requireAdapterFeature<K extends AdapterFeatureKey>(
  core: unknown, keys: readonly K[], error: CoreFeatureError,
): Pick<ExternalCoreAdapter, K> {
  const found = firstWithMethods([core], keys);
  if (!found) throw unavailable(error);
  return found as Pick<ExternalCoreAdapter, K>;
}

export function requireCoreFeature<K extends CoreFeatureKey, O extends CoreFeatureKey = never>(
  core: unknown, keys: readonly K[], error: CoreFeatureError, _optional?: readonly O[],
): Pick<OwlCore, K> & Partial<Pick<OwlCore, O>> {
  const found = firstWithMethods([core, inner(core)], keys);
  if (!found) throw unavailable(error);
  return found as Pick<OwlCore, K> & Partial<Pick<OwlCore, O>>;
}

export function optionalCoreFeature<K extends CoreFeatureKey, O extends CoreFeatureKey = never>(
  core: unknown, keys: readonly K[], _optional?: readonly O[],
): (Pick<OwlCore, K> & Partial<Pick<OwlCore, O>>) | null {
  return firstWithMethods([core, inner(core)], keys) as (Pick<OwlCore, K> & Partial<Pick<OwlCore, O>>) | null;
}

type MemoryRequiredKey = "search" | "expand" | "recall" | "health" | "reindex";
type MemoryPageKey = "readIndex" | "page" | "append" | "searchPages";
export type MemoryFeature = Pick<MemoryService, MemoryRequiredKey> & Partial<Pick<MemoryService, MemoryPageKey>> & {
  /** MemoryService には無い。持つ偽物だけが答える。 */
  mode?(): "pages";
};

const MEMORY_REQUIRED: readonly MemoryRequiredKey[] = ["search", "expand", "recall", "health", "reindex"];

export function requireMemoryFeature(core: unknown): MemoryFeature {
  const found = firstWithMethods([memoryOf(core), memoryOf(inner(core))], MEMORY_REQUIRED);
  if (!found) throw new ApiError(503, "dependency_unavailable", CoreFeatureMessages.memoryApiUnsupported());
  return found as MemoryFeature;
}
