import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { startTestHttpServer } from "../helpers/http.mjs";

const WORK_ID = "01J00000000000000000000000";

function fakeCore(serviceCount) {
  return {
    ready: true,
    status: () => ({ services: Array.from({ length: serviceCount }, (_, index) => ({ name: `service-${index}`, state: "ok" })), mvp_scope: "test", version: "1.0.0" }),
    subscribe: () => () => {},
    eventsAfter: () => [],
    archiveWork: async () => ({ data: { work_id: WORK_ID }, version: 2 }),
  };
}

function rawGet(baseUrl, route, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${route}`, { headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

async function boot(t, serviceCount, serverOptions = {}) {
  const api = await startTestHttpServer(t, { core: fakeCore(serviceCount), webOut: "/tmp", owlRoot: "/tmp", dataDir: "/tmp", ...serverOptions });
  if (!api) t.skip("localhost listen is not permitted in this environment");
  return api;
}

const STATUS = "/api/v1/system/status";

test("GET 200 carries a weak ETag that is stable and answers If-None-Match with 304", async (t) => {
  const api = await boot(t, 1);
  if (!api) return;
  const first = await rawGet(api.baseUrl, STATUS, { "x-request-id": "a" });
  const second = await rawGet(api.baseUrl, STATUS, { "x-request-id": "b" });
  assert.equal(first.status, 200);
  assert.match(first.headers.etag, /^W\//u);
  assert.equal(first.headers.etag, second.headers.etag);
  const cached = await rawGet(api.baseUrl, STATUS, { "if-none-match": first.headers.etag });
  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);
  const other = await rawGet(api.baseUrl, STATUS, { "if-none-match": 'W/"other"' });
  assert.equal(other.status, 200);
});

test("POST command responses carry no ETag", async (t) => {
  const api = await boot(t, 1);
  if (!api) return;
  const response = await api.request("POST", `/api/v1/works/${WORK_ID}/archive`, { request_id: "r1", idempotency_key: "k1", expected_version: 1, payload: {} });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), null);
});

test("large GET responses are gzip-compressed only for clients that accept gzip", async (t) => {
  const api = await boot(t, 100);
  if (!api) return;
  const plain = await rawGet(api.baseUrl, STATUS);
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.ok(plain.body.length >= 1024);
  for (const accept of ["gzip", "*"]) {
    const res = await rawGet(api.baseUrl, STATUS, { "accept-encoding": accept });
    assert.equal(res.headers["content-encoding"], "gzip", accept);
    assert.match(res.headers.vary, /accept-encoding/iu);
    assert.deepEqual(JSON.parse(gunzipSync(res.body).toString()), JSON.parse(plain.body.toString()));
  }
  for (const accept of ["gzip;q=0", "identity", "gzip;q=0, *;q=1"]) {
    const res = await rawGet(api.baseUrl, STATUS, { "accept-encoding": accept });
    assert.equal(res.headers["content-encoding"], undefined, accept);
  }
});

test("small responses stay uncompressed unless the threshold option is lowered", async (t) => {
  const small = await boot(t, 1);
  if (!small) return;
  assert.equal((await rawGet(small.baseUrl, STATUS, { "accept-encoding": "gzip" })).headers["content-encoding"], undefined);
  const low = await boot(t, 1, { jsonCompressionMinBytes: 10 });
  assert.equal((await rawGet(low.baseUrl, STATUS, { "accept-encoding": "gzip" })).headers["content-encoding"], "gzip");
});
