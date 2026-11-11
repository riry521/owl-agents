import assert from "node:assert/strict";
import { test } from "node:test";

import { API_ROUTES, listApiRoutes, matchApiRoute } from "../../apps/server/dist/http-routes.js";
import { openApiPath, WEBSOCKET_PATH } from "../../apps/server/dist/http-route-table.js";

const ORIGIN = "http://localhost";

/** Build a sample path: values variables take `value`, a trailing {x*}/{x+} becomes a/b, others become x. */
function samplePath(route, valueFor = () => undefined) {
  return route.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)([*+]?)\}/gu, (_token, name, mark) => valueFor(name) ?? (mark ? "a/b" : "x"));
}

/** Samples for one row: one per `values` entry (or a single one when it has none). */
function samplesOf(route) {
  const entries = Object.entries(route.values ?? {});
  if (entries.length === 0) return [samplePath(route)];
  const [name, allowed] = entries[0];
  return allowed.map((value) => samplePath(route, (variable) => (variable === name ? value : undefined)));
}

/** Match like the server does: pathname goes through WHATWG URL normalisation, rawPathname stays as sent. */
function match(method, rawPathname) {
  const pathname = new URL(rawPathname, ORIGIN).pathname;
  return matchApiRoute(method, pathname, rawPathname);
}

test("listApiRoutes has 220 rows without duplicates and ends with the WebSocket path", () => {
  const rows = listApiRoutes();
  assert.equal(rows.length, 220);
  const keys = rows.map((row) => `${row.method} ${row.path}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes(`GET ${WEBSOCKET_PATH}`));
  assert.equal(WEBSOCKET_PATH, "/api/v1/ws");
  assert.equal(API_ROUTES.length, 219);
});

test("matchApiRoute returns the row itself for every row's sample path", () => {
  for (const route of API_ROUTES) {
    for (const sample of samplesOf(route)) {
      const found = match(route.method, sample);
      assert.ok(found, `no row for ${route.method} ${sample}`);
      assert.equal(found.route, route, `${route.method} ${sample} is hidden by ${found.route.method} ${found.route.path}`);
    }
  }
});

test("owner-files (6), memory (10) and GET /ws rows exist", () => {
  const rows = listApiRoutes().map((row) => `${row.method} ${row.path}`);
  for (const method of ["GET", "HEAD"]) {
    for (const path of ["/api/v1/owner-files", "/api/v1/owner-files/roots", "/api/v1/owner-files/{path}"]) {
      assert.ok(rows.includes(`${method} ${path}`), `${method} ${path}`);
    }
  }
  const owner = API_ROUTES.filter((route) => route.path.startsWith("/api/v1/owner-files"));
  assert.equal(owner.length, 6);
  assert.ok(owner.every((route) => route.raw === true));
  const memory = API_ROUTES.filter((route) => /^\/api\/v1\/memory\/(?!pages\/pending|pages\/integrate|save-explicit)/u.test(route.path));
  assert.equal(memory.length, 10);
  assert.ok(rows.includes("GET /api/v1/ws"));
});

test("only the 11 entry pathname rows come before the owner-files rows", () => {
  const firstOwner = API_ROUTES.findIndex((route) => route.path.startsWith("/api/v1/owner-files"));
  const before = API_ROUTES.slice(0, firstOwner);
  assert.equal(before.length, 12);
  assert.equal(before[0].raw, true, "skills files is the only raw row before owner-files");
  assert.equal(before[0].path, "/api/v1/skills/{name}/files/{path*}");
  assert.equal(before.slice(1).filter((route) => route.raw !== true).length, 11);
  assert.ok(API_ROUTES.slice(firstOwner + 6).every((route) => route.raw !== true));
});

test("dot-segment URLs behave as designed (5.4)", () => {
  const health = match("GET", "/api/v1/owner-files/../health");
  assert.equal(health?.route.path, "/api/v1/health");
  const markdown = match("GET", "/api/v1/owner-files/../works/x/markdown");
  assert.equal(openApiPath(markdown?.route.path ?? ""), "/api/v1/owner-files/{path}");
  assert.equal(markdown?.route.raw, true);
  const view = match("GET", "/api/v1/owner-files/%2e%2e/works/x/view");
  assert.equal(view?.route.path, "/api/v1/works/{work_id}/view");
  assert.equal(view?.params.work_id, "x");
});

test("advisor channels decode the key once, and a broken key throws regardless of method", () => {
  assert.throws(() => match("DELETE", "/api/v1/advisor/windows/%E0%A4%A/channels/slack"), URIError);
  assert.throws(() => match("GET", "/api/v1/advisor/windows/%E0%A4%A/channels"), URIError);
  assert.equal(match("GET", "/api/v1/advisor/windows/key/channels/slack"), null);
  const decoded = match("GET", "/api/v1/advisor/windows/a%2Fb/channels");
  assert.equal(decoded?.params.key, "a/b");
  const twice = match("GET", "/api/v1/advisor/windows/a%252Fb/channels");
  assert.equal(twice?.params.key, "a%2Fb");
});
