import type { ApiRoute, RouteRequest } from "./http-common.js";
import { compileRoutes, findRoute, openApiPath, WEBSOCKET_PATH, type ApiMethod } from "./http-route-table.js";
import { ADVISOR_ROUTES } from "./http-routes-advisor.js";
import { AGENT_ROUTES } from "./http-routes-agents.js";
import { MEMORY_ROUTES } from "./http-routes-memory.js";
import { PROJECT_ROUTES } from "./http-routes-projects.js";
import { SETTINGS_ROUTES } from "./http-routes-settings.js";
import { SKILL_FILE_ROUTES, SKILL_ROUTES } from "./http-routes-skills.js";
import { OWNER_FILE_ROUTES, SYSTEM_ENTRY_ROUTES, SYSTEM_ROUTES } from "./http-routes-system.js";
import { WORK_ENTRY_ROUTES, WORK_ROUTES } from "./http-routes-works.js";

// 並びの理由: rawPathname と照合する行（skills の files、owner-files）は、`..` や `%2e%2e` を含む URL で
// 正規化後の別の行にも当たる。そのため今の if と同じ前後になるよう、owner-files より前に置く行を固定する。
export const API_ROUTES: readonly ApiRoute[] = [
  ...SKILL_FILE_ROUTES,
  ...SYSTEM_ENTRY_ROUTES,
  ...WORK_ENTRY_ROUTES,
  ...OWNER_FILE_ROUTES,
  ...SYSTEM_ROUTES,
  ...WORK_ROUTES,
  ...PROJECT_ROUTES,
  ...SETTINGS_ROUTES,
  ...SKILL_ROUTES,
  ...MEMORY_ROUTES,
  ...ADVISOR_ROUTES,
  ...AGENT_ROUTES,
];

const COMPILED_ROUTES = compileRoutes(API_ROUTES);

export function matchApiRoute(method: string, pathname: string, rawPathname: string):
  { route: ApiRoute; params: Readonly<Record<string, string>> } | null {
  return findRoute(COMPILED_ROUTES, method, pathname, rawPathname);
}

/** 当たる行があれば処理して true、無ければ false。呼び出し側が 404 にする。 */
export async function dispatchApiRoute(route: Omit<RouteRequest, "params">): Promise<boolean> {
  const matched = matchApiRoute(route.method, route.pathname, route.rawPathname);
  if (!matched) return false;
  await matched.route.handle({ ...route, params: matched.params });
  return true;
}

export function listApiRoutes(): Array<{ method: ApiMethod; path: string }> {
  return [
    ...API_ROUTES.map((route) => ({ method: route.method, path: openApiPath(route.path) })),
    { method: "GET", path: WEBSOCKET_PATH },
  ];
}
