import assert from "node:assert/strict";
import { test } from "node:test";

import { compileRoutes, findRoute, openApiPath, API_PREFIX, WEBSOCKET_PATH } from "../../apps/server/dist/http-route-table.js";

const find = (routes, method, path, raw = path) => findRoute(compileRoutes(routes), method, path, raw);

test("{x} は1段だけに当たる", () => {
  const routes = [{ method: "GET", path: "/a/{x}/b" }];
  assert.deepEqual(find(routes, "GET", "/a/1/b")?.params, { x: "1" });
  assert.equal(find(routes, "GET", "/a/1/2/b"), null);
  assert.equal(find(routes, "GET", "/a//b"), null);
  assert.equal(find(routes, "POST", "/a/1/b"), null);
});

test("{p*} は空と複数段に当たり、{p+} は空に当たらない", () => {
  const star = [{ method: "GET", path: "/f/{p*}" }];
  assert.equal(find(star, "GET", "/f/")?.params.p, "");
  assert.equal(find(star, "GET", "/f/a/b")?.params.p, "a/b");
  const plus = [{ method: "GET", path: "/k/{p+}" }];
  assert.equal(find(plus, "GET", "/k/"), null);
  assert.equal(find(plus, "GET", "/k/a/b")?.params.p, "a/b");
});

test("values は列挙値だけに当たる", () => {
  const routes = [{ method: "PUT", path: "/i/{provider}", values: { provider: ["slack", "discord"] } }];
  assert.equal(find(routes, "PUT", "/i/slack")?.params.provider, "slack");
  assert.equal(find(routes, "PUT", "/i/discord")?.params.provider, "discord");
  assert.equal(find(routes, "PUT", "/i/other"), null);
  assert.equal(find(routes, "PUT", "/i/slackx"), null);
});

test("raw の行は rawPathname と照合する", () => {
  const routes = [{ method: "GET", path: "/o/{p*}", raw: true }];
  assert.equal(find(routes, "GET", "/health", "/o/../health")?.params.p, "../health");
  assert.equal(find(routes, "GET", "/o/x", "/health"), null);
});

test("先の行が優先される", () => {
  const routes = [
    { method: "GET", path: "/w/{id}", name: "first" },
    { method: "GET", path: "/w/roots", name: "second" },
  ];
  assert.equal(find(routes, "GET", "/w/roots")?.route.name, "first");
});

test("params は decode しない", () => {
  const routes = [{ method: "GET", path: "/a/{x}" }];
  assert.equal(find(routes, "GET", "/a/a%2Fb")?.params.x, "a%2Fb");
});

test("decodeOnPathMatch は、パスが合えばメソッドが違っても decode し、壊れた値は URIError にする", () => {
  const routes = [{ method: "GET", path: "/c/{key}/x", decodeOnPathMatch: ["key"] }];
  assert.throws(() => find(routes, "DELETE", "/c/%E0%A4%A/x"), URIError);
  assert.throws(() => find(routes, "GET", "/c/%E0%A4%A/x"), URIError);
  assert.equal(find(routes, "DELETE", "/c/ok/x"), null);
  assert.equal(find(routes, "GET", "/c/y/z"), null);
  assert.equal(find(routes, "GET", "/c/a%2Fb/x")?.params.key, "a/b");
  assert.equal(find(routes, "GET", "/c/a%252Fb/x")?.params.key, "a%2Fb");
});

test("不正な定義は例外になる", () => {
  assert.throws(() => compileRoutes([{ method: "GET", path: "/a" }, { method: "GET", path: "/a" }]), /Duplicate/);
  assert.throws(() => compileRoutes([{ method: "GET", path: "/a/{p*}/b" }]), /end of the path/);
  assert.throws(() => compileRoutes([{ method: "GET", path: "/a/{p+}/b" }]), /end of the path/);
  assert.throws(() => compileRoutes([{ method: "GET", path: "/a/{x}", values: { y: ["1"] } }]), /Unknown variable/);
  assert.throws(() => compileRoutes([{ method: "GET", path: "/a/{x}", decodeOnPathMatch: ["y"] }]), /Unknown variable/);
  assert.doesNotThrow(() => compileRoutes([{ method: "GET", path: "/a" }, { method: "POST", path: "/a" }]));
});

test("openApiPath は * と + を外し、定数は API_PREFIX から作る", () => {
  assert.equal(openApiPath("/k/{p+}"), "/k/{p}");
  assert.equal(openApiPath("/f/{p*}"), "/f/{p}");
  assert.equal(openApiPath("/a/{x}/b"), "/a/{x}/b");
  assert.equal(API_PREFIX, "/api/v1");
  assert.equal(WEBSOCKET_PATH, "/api/v1/ws");
});
