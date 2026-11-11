import assert from "node:assert/strict";
import { test } from "node:test";

import { externalError } from "../../apps/server/dist/core.js";
import { ApiError, errorBody } from "../../apps/server/dist/errors.js";
import { defineMessages } from "../../apps/server/dist/messages/define.js";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { validationError } from "../../packages/core/dist/errors.js";

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

test("HTTP error serialization changes only the human message", () => {
  const error = new ApiError(404, "not_found", "指定された項目が見つかりません。", { id: "x" });
  assert.equal(errorBody("request", error, "ja").error.message, error.message);
  assert.equal(errorBody("request", error, "en").error.message, "The requested resource was not found.");
  assert.equal(errorBody("request", error, "en").error.code, "not_found");
  assert.deepEqual(errorBody("request", error, "en").error.details, { id: "x" });
  assert.equal(errorBody("request", new ApiError(400, "validation_error", "The Core supplied a specific explanation."), "en").error.message, "The Core supplied a specific explanation.");
});

test("an error thrown with a message-table key is worded in the Owner language, with its values and field name", () => {
  const M = defineMessages("language-test", {
    badLimit: { ja: "{field}が不正です。{min}以上の整数を指定してください。", en: "Set {field} to an integer of {min} or more." },
    toString: { ja: "表のkeyが toString でも引ける", en: "A key named toString can be looked up" },
  });
  const invalid = new ApiError(400, "validation_error", M.badLimit({ field: "limit", min: 1 }), { field: "limit" });
  assert.equal(errorBody("request", invalid, "ja").error.message, "limitが不正です。1以上の整数を指定してください。");
  assert.equal(errorBody("request", invalid, "en").error.message, "Set limit to an integer of 1 or more.");
  const query = new ApiError(400, "invalid_query", M.badLimit({ field: "offset", min: 0 }));
  assert.match(errorBody("request", query, "ja").error.message, /^offsetが不正です/u);
  assert.match(errorBody("request", query, "en").error.message, /^Set offset /u);
  assert.equal(errorBody("request", invalid, "en").error.code, "validation_error");
  assert.equal(errorBody("request", new ApiError(500, "server_error", M.toString()), "en").error.message, "A key named toString can be looked up");
  assert.equal(errorBody("request", new ApiError(500, "server_error", { key: "language-test.missing" }), "en").error.message, "language-test.missing");
  assert.equal(errorBody("request", new ApiError(500, "server_error", { key: "toString" }), "en").error.message, "toString");
});

test("a Core error with an English message follows the Owner language through its code", () => {
  const core = new ApiError(404, "work_not_found", "work W1 was not found.", { id: "W1" });
  assert.equal(errorBody("request", core, "en").error.message, "work W1 was not found.");
  assert.equal(errorBody("request", core, "ja").error.message, "Work が見つかりません。");
  assert.equal(errorBody("request", core, "ja").error.code, "work_not_found");
  const server = new ApiError(404, "work_not_found", "指定されたWorkが見つかりません。");
  assert.equal(errorBody("request", server, "ja").error.message, server.message);
  assert.equal(errorBody("request", server, "en").error.message, "The Work was not found.");
});

test("a Core validation_error with a reason code is worded wholly in the Owner language and names the field", () => {
  // The same error the child-run scheduler throws for a wrong child_ids count, passed through the server's Core adapter.
  const core = validationError("child_ids must contain between 1 and 20 child IDs.", {}, { code: "child_run.child_ids_invalid", values: { field: "child_ids", max: 20 } });
  const error = externalError(core, "childRuns.wait");
  const japanese = errorBody("request", error, "ja").error;
  const english = errorBody("request", error, "en").error;
  assert.equal(japanese.code, "validation_error");
  assert.equal(english.code, "validation_error");
  assert.match(japanese.message, /child_ids/u);
  assert.match(japanese.message, /件以下/u);
  assert.doesNotMatch(japanese.message, /must|between|IDs|request is invalid/u);
  assert.match(english.message, /^child_ids must contain between 1 and 20 child IDs\.$/u);
  assert.doesNotMatch(english.message, JAPANESE);
  assert.deepEqual(japanese.details.reason, { code: "child_run.child_ids_invalid", values: { field: "child_ids", max: 20 } });
});

test("validation_error and invalid_query without a key or a reason code keep their own text instead of a sentence in the other language", () => {
  const field = new ApiError(400, "validation_error", "name must be a string.", { field: "name" });
  assert.equal(errorBody("request", field, "en").error.message, "name must be a string.");
  assert.equal(errorBody("request", field, "ja").error.message, "name must be a string.");
  const query = new ApiError(400, "invalid_query", "limitが範囲外です。", { field: "limit" });
  assert.equal(errorBody("request", query, "ja").error.message, "limitが範囲外です。");
  assert.equal(errorBody("request", query, "en").error.message, "limitが範囲外です。");
  const unknownReason = new ApiError(400, "validation_error", "child_ids is wrong.", { reason: { code: "toString", values: {} } });
  assert.equal(errorBody("request", unknownReason, "ja").error.message, "child_ids is wrong.");
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

test("projects and agents route messages come from their own tables in both languages", async () => {
  const { ProjectsRouteMessages } = await import("../../apps/server/dist/messages/routes-projects.js");
  const { AgentsRouteMessages } = await import("../../apps/server/dist/messages/routes-agents.js");
  for (const [table, key] of [[ProjectsRouteMessages, "registrationModeRequired"], [AgentsRouteMessages, Object.keys(AgentsRouteMessages)[0]]]) {
    const error = new ApiError(400, "validation_error", table[key]());
    assert.match(errorBody("request", error, "ja").error.message, JAPANESE);
    assert.doesNotMatch(errorBody("request", error, "en").error.message, JAPANESE);
  }
});

test("advisor and memory route errors are worded in the Owner language from their message tables", async () => {
  const { RoutesAdvisorMessages } = await import("../../apps/server/dist/messages/routes-advisor.js");
  const { RoutesMemoryMessages } = await import("../../apps/server/dist/messages/routes-memory.js");
  for (const table of [RoutesAdvisorMessages, RoutesMemoryMessages]) {
    for (const name of Object.keys(table)) {
      const error = new ApiError(400, "bad_request", table[name]({ max: 3, field: "f", name: "n", id: "i", index: 0 }));
      const ja = errorBody("request", error, "ja").error.message;
      const en = errorBody("request", error, "en").error.message;
      assert.match(ja, /[ぁ-んァ-ヶ一-龠]/u, name);
      assert.doesNotMatch(en, /[ぁ-んァ-ヶ一-龠]/u, name);
    }
  }
});

test("messages that left the Japanese-to-English map are worded from their tables in both languages", async () => {
  const { HttpCommonMessages } = await import("../../apps/server/dist/messages/http-common.js");
  for (const key of Object.keys(HttpCommonMessages)) {
    const error = new ApiError(400, "validation_error", HttpCommonMessages[key]({ field: "x", min: 0, max: 1 }));
    assert.match(errorBody("r", error, "ja").error.message, JAPANESE, key);
    assert.doesNotMatch(errorBody("r", error, "en").error.message, JAPANESE, key);
  }
});

test("prerequisite, settings, knowledge and channel errors follow the Owner language through their reason codes or code table", async () => {
  const { prerequisiteWorkIds } = await import("../../apps/server/dist/http-common.js");
  const { HumanReadableError } = await import("../../packages/core/dist/errors.js");
  const cycle = externalError(new HumanReadableError({
    code: "prerequisite_cycle", message: "These prerequisites would make Works wait on each other: A → B.", remediation: "Remove one.",
    details: { reason: { code: "work_prerequisite.cycle", values: { path: "A → B" } } },
  }), "op");
  assert.match(errorBody("r", cycle, "ja").error.message, /A → B/);
  assert.match(errorBody("r", cycle, "ja").error.message, JAPANESE);
  assert.doesNotMatch(errorBody("r", cycle, "en").error.message, JAPANESE);
  const ulid = "01M75MQWE4805PX495GTKT4426";
  const bad = { not_array: "x", duplicate: [ulid, ulid], too_many: Array.from({ length: 1000 }, (_, i) => `01M75MQWE4805PX495GT${String(i).padStart(6, "0")}`) };
  for (const [reason, value] of Object.entries(bad)) {
    let ids;
    try { prerequisiteWorkIds(value); } catch (error) { ids = error; }
    assert.equal(ids?.details?.reason?.code, `work_prerequisite.ids_${reason}`, reason);
    assert.match(errorBody("r", ids, "ja").error.message, JAPANESE, reason);
    assert.doesNotMatch(errorBody("r", ids, "en").error.message, JAPANESE, reason);
  }
  for (const code of ["prerequisite_work_not_found", "knowledge_move_failed", "integration_rate_limited", "channel_name_taken", "child_not_found", "verification_policy_storage_invalid"]) {
    const error = new ApiError(409, code, "English text from another package.");
    assert.match(errorBody("r", error, "ja").error.message, JAPANESE, code);
  }
  const storedPolicy = new ApiError(409, "verification_policy_storage_invalid", "保存済みの検証ポリシーの形式が不正です。");
  assert.doesNotMatch(errorBody("r", storedPolicy, "en").error.message, JAPANESE);
});

test("project folder registration errors are worded in the Owner language from their message table", async () => {
  const { browseProjectFolders, inspectProjectFolder } = await import("../../apps/server/dist/project-registration.js");
  const { ProjectRegistrationMessages } = await import("../../apps/server/dist/messages/project-registration.js");
  for (const run of [() => inspectProjectFolder("relative/folder"), () => browseProjectFolders("relative/folder")]) {
    const error = await run().then(() => assert.fail("expected a rejection"), (rejection) => rejection);
    assert.equal(error.code, "validation_error");
    assert.match(errorBody("r", error, "ja").error.message, JAPANESE);
    assert.doesNotMatch(errorBody("r", error, "en").error.message, JAPANESE);
  }
  for (const key of Object.keys(ProjectRegistrationMessages)) {
    const error = new ApiError(400, "validation_error", ProjectRegistrationMessages[key]());
    assert.match(errorBody("r", error, "ja").error.message, JAPANESE, key);
    assert.doesNotMatch(errorBody("r", error, "en").error.message, JAPANESE, key);
  }
});

test("Advisor workspace failures are worded in the Owner language from Core's error code", async () => {
  const { advisorWorkspaceErrorMessage } = await import("../../apps/server/dist/http-routes-advisor.js");
  const codes = ["project_unavailable", "base_not_found", "workspace_conflict", "sync_failed", "uncommitted_changes", "merge_conflict", "checkout_conflict"];
  const fallback = advisorWorkspaceErrorMessage(null).key;
  for (const code of [...codes, "toString", null]) {
    const error = new ApiError(409, "advisor_workspace_unavailable", advisorWorkspaceErrorMessage(code), { error_code: code, message: "English text from Core." });
    assert.match(errorBody("r", error, "ja").error.message, JAPANESE, String(code));
    assert.doesNotMatch(errorBody("r", error, "en").error.message, JAPANESE, String(code));
    assert.equal(advisorWorkspaceErrorMessage(code).key === fallback, !codes.includes(code), String(code));
  }
});

test("a channel name the provider rejects is worded in the Owner language and keeps the provider's text", async () => {
  const { channelCall } = await import("../../apps/server/dist/http-common.js");
  const { ChannelAdminError } = await import("../../packages/plugin-sdk/dist/index.js");
  for (const provider of ["slack", "discord"]) {
    const rejected = new ChannelAdminError("invalid_name", "Slack returned invalid_name_specials.", { provider_code: "invalid_name_specials" });
    const error = await channelCall(provider, "create", () => Promise.reject(rejected)).then(() => assert.fail("expected a rejection"), (rejection) => rejection);
    assert.equal(error.code, "validation_error");
    const ja = errorBody("r", error, "ja").error;
    const en = errorBody("r", error, "en").error;
    assert.match(ja.message, JAPANESE);
    assert.doesNotMatch(en.message, JAPANESE);
    assert.notEqual(en.message, rejected.message);
    assert.deepEqual(ja.details, { field: "name", provider, provider_code: "invalid_name_specials", provider_message: rejected.message });
  }
});

test("the folder permission hint follows the Owner language", async () => {
  const { listHostDirectories } = await import("../../apps/server/dist/fs-directories.js");
  const denied = { stat: () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })), readdir: () => Promise.resolve([]) };
  const error = await listHostDirectories("/", false, "/", {}, denied).then(() => assert.fail("expected a rejection"), (rejection) => rejection);
  assert.equal(error.code, "forbidden");
  const ja = errorBody("r", error, "ja").error.details.permission_hint;
  const en = errorBody("r", error, "en").error.details.permission_hint;
  for (const hint of [ja, en]) {
    assert.equal(hint.reason, "macos_privacy");
    assert.equal(hint.settings_paths.length, 2);
  }
  for (const text of [...ja.settings_paths, ja.steps]) assert.match(text, JAPANESE);
  for (const text of [...en.settings_paths, en.steps]) assert.ok(typeof text === "string" && text.length > 0 && !JAPANESE.test(text), text);
});
