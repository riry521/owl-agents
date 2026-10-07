import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, errorBody } from "../../apps/server/dist/errors.js";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

test("HTTP error serialization changes only the human message", () => {
  const error = new ApiError(404, "not_found", "指定された項目が見つかりません。", { id: "x" });
  assert.equal(errorBody("request", error, "ja").error.message, error.message);
  assert.equal(errorBody("request", error, "en").error.message, "The requested resource was not found.");
  assert.equal(errorBody("request", error, "en").error.code, "not_found");
  assert.deepEqual(errorBody("request", error, "en").error.details, { id: "x" });
  assert.equal(errorBody("request", new ApiError(400, "validation_error", "The Core supplied a specific explanation."), "en").error.message, "The Core supplied a specific explanation.");
});

test("HTTP errors use the Owner language and preserve their codes", async (t) => {
  const root = await tempDir(t, "owl-api-language-");
  let language = "en";
  const api = await startTestHttpServer(t, { core: { getLanguage: async () => language }, webOut: root, owlRoot: root });
  if (!api) {
    t.skip("localhost listen is not permitted in this environment");
    return;
  }
  const url = `${api.baseUrl}/api/v1/unknown`;
  const english = await (await fetch(url)).json();
  assert.equal(english.error.code, "not_found");
  assert.doesNotMatch(english.error.message, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u);
  language = "ja";
  const japanese = await (await fetch(url)).json();
  assert.equal(japanese.error.code, "not_found");
  assert.match(japanese.error.message, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u);
});
