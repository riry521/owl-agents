import { escapeRegExp } from "@owl/shared/small-helpers";

export const API_PREFIX = "/api/v1";
export const WEBSOCKET_PATH = `${API_PREFIX}/ws`;
export type ApiMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteDefinition {
  readonly method: ApiMethod;
  /** OpenAPI 形式のテンプレート。末尾だけ {name*} と {name+} を使える。 */
  readonly path: string;
  /** 列挙値だけに当たる変数。例: { provider: ["slack", "discord"] } */
  readonly values?: Readonly<Record<string, readonly string[]>>;
  /** true なら正規化前の rawPathname と照合する。 */
  readonly raw?: true;
  /** パスが合った時点で、メソッドを比べる前に decodeURIComponent する変数。 */
  readonly decodeOnPathMatch?: readonly string[];
}

export interface CompiledRoute<T extends RouteDefinition> {
  readonly route: T;
  readonly pattern: RegExp;
  readonly names: readonly string[];
}

const TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)([*+]?)\}/g;

// Why not: 手書きの正規表現を各行に持たせる案は、OpenAPI のパスと二重管理になるので採らない。
// テンプレートから機械的に作れば、OpenAPI と同じ書き方のまま照合できる。
export function compileRoutes<T extends RouteDefinition>(routes: readonly T[]): CompiledRoute<T>[] {
  const seen = new Set<string>();
  return routes.map((route) => {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) throw new Error(`Duplicate route: ${key}`);
    seen.add(key);

    const names: string[] = [];
    let source = "";
    let last = 0;
    for (const match of route.path.matchAll(TOKEN)) {
      const [token, name, mark] = match as unknown as [string, string, string];
      const index = match.index ?? 0;
      if (mark && index + token.length !== route.path.length) {
        throw new Error(`"${mark}" is only allowed at the end of the path: ${route.path}`);
      }
      source += escapeRegExp(route.path.slice(last, index));
      last = index + token.length;
      const allowed = route.values?.[name];
      source += allowed
        ? `(${allowed.map(escapeRegExp).join("|")})`
        : mark === "*" ? "(.*)" : mark === "+" ? "(.+)" : "([^/]+)";
      names.push(name);
    }
    source += escapeRegExp(route.path.slice(last));

    for (const name of [...Object.keys(route.values ?? {}), ...(route.decodeOnPathMatch ?? [])]) {
      if (!names.includes(name)) throw new Error(`Unknown variable "${name}" in route: ${route.path}`);
    }
    return { route, pattern: new RegExp(`^${source}$`), names };
  });
}

export function findRoute<T extends RouteDefinition>(
  table: readonly CompiledRoute<T>[], method: string, pathname: string, rawPathname: string,
): { route: T; params: Readonly<Record<string, string>> } | null {
  for (const { route, pattern, names } of table) {
    const match = pattern.exec(route.raw ? rawPathname : pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    names.forEach((name, i) => { params[name] = match[i + 1] ?? ""; });
    // URIError は捕まえない。今の分岐と同じく、メソッドに関係なく呼び出し側の 500 に届ける。
    for (const name of route.decodeOnPathMatch ?? []) params[name] = decodeURIComponent(params[name]!);
    if (route.method === method) return { route, params };
  }
  return null;
}

/** {name*} と {name+} を {name} に直した OpenAPI のパスを返す。 */
export function openApiPath(path: string): string {
  return path.replace(TOKEN, "{$1}");
}
