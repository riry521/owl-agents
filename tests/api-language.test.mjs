import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { ApiError, errorBody } from "../apps/server/dist/errors.js";

test("HTTP error serialization changes only the human message", () => {
  const error = new ApiError(404, "not_found", "指定された項目が見つかりません。", { id: "x" });
  assert.equal(errorBody("request", error, "ja").error.message, error.message);
  assert.equal(errorBody("request", error, "en").error.message, "The requested resource was not found.");
  assert.equal(errorBody("request", error, "en").error.code, "not_found");
  assert.deepEqual(errorBody("request", error, "en").error.details, { id: "x" });
  assert.equal(errorBody("request", new ApiError(400, "validation_error", "The Core supplied a specific explanation."), "en").error.message, "The Core supplied a specific explanation.");
});

test("HTTP errors use the Owner language and preserve their codes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-api-language-"));
  let language = "en";
  const http = createOwlHttpServer({
    core: { getLanguage: async () => language },
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("localhost listen is not permitted in this environment");
      return;
    }
    throw error;
  }
  t.after(() => http.close());
  const address = http.server.address();
  const url = `http://127.0.0.1:${address.port}/api/v1/unknown`;
  const english = await (await fetch(url)).json();
  assert.equal(english.error.code, "not_found");
  assert.doesNotMatch(english.error.message, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u);
  language = "ja";
  const japanese = await (await fetch(url)).json();
  assert.equal(japanese.error.code, "not_found");
  assert.match(japanese.error.message, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u);
});
