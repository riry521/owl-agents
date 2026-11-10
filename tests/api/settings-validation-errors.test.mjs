import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

async function startApi(t) {
  const { root, db, core: durableCore } = await createTestCore(t, { version: "settings-validation-errors-test" }, { prefix: "owl-api-settings-validation-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const token = randomBytes(24).toString("hex");
  const server = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir }, { token });
  if (!server) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  return (method, path, body) => server.request(method, `/api/v1${path}`, body);
}

const CASES = [
  ["dependency-summary", { max_chars: 0 }, "max_chars"],
  ["fixer-escalation", { after_review_rejections: 0 }, "after_review_rejections"],
];

for (const [name, payload, field] of CASES) {
  test(`PUT /settings/${name} rejects an invalid value with 400, validation_error and the field`, async (t) => {
    const request = await startApi(t);
    if (!request) return;
    const response = await request("PUT", `/settings/${name}`, command(payload, `settings-validation-errors:${name}`));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, "validation_error");
    assert.equal(body.error.details.field, field);
  });
}
