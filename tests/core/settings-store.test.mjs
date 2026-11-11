// Import settings-store first: it must load on its own without an import cycle through state-reducer.
import {
  DEFAULT_OWNER_ID,
  readSetting,
  saveSetting,
  storedSettingJson,
  storedSettingRow,
  upsertSetting,
  validatedSetting,
} from "../../packages/core/dist/settings-store.js";
import assert from "node:assert/strict";
import { test } from "node:test";

import { HumanReadableError } from "../../packages/core/dist/errors.js";
import { SettingsValidationError } from "../../packages/shared/dist/settings-validation.js";
import { createTestCore } from "../helpers/core.mjs";
import { openTestDatabase } from "../helpers/db.mjs";

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const DEFAULTS = { size: 1 };

class SampleValidationError extends SettingsValidationError {}

function validate(input) {
  if (input === "other") throw new RangeError("not a settings error");
  if (typeof input?.size !== "number") throw new SampleValidationError("size must be a number.", "size");
  return { size: input.size };
}

function spec(overrides = {}) {
  return {
    key: "sample_setting",
    defaults: DEFAULTS,
    read: (value, warn) => {
      warn("read called");
      return value;
    },
    warnPrefix: "sample: ",
    readFailure: "Could not read sample",
    validate,
    event: { type: "settings.sample_updated", idempotencyPrefix: "settings-sample" },
    ...overrides,
  };
}

async function setup(t) {
  const { db } = await openTestDatabase(t);
  const writeLane = db.createWriteLane();
  const warn = t.mock.method(console, "warn", () => {});
  return { db, writeLane, warn };
}

const countOf = (db, table) => db.get(`SELECT COUNT(*) AS n FROM ${table}`).n;

test("readSetting returns the defaults object itself when no row exists", async (t) => {
  const { db, warn } = await setup(t);
  assert.equal(readSetting(db, spec()), DEFAULTS);
  assert.equal(warn.mock.callCount(), 0);
});

test("readSetting warns with the [owl-core] tag and the warnPrefix", async (t) => {
  const { db, writeLane, warn } = await setup(t);
  await writeLane.transact((tx) => upsertSetting(tx, { key: "sample_setting", valueJson: '{"size":2}' }));
  assert.deepEqual(readSetting(db, spec()), { size: 2 });
  assert.equal(warn.mock.calls[0].arguments[0], "[owl-core] sample: read called");
  readSetting(db, spec({ warnPrefix: undefined }));
  assert.equal(warn.mock.calls[1].arguments[0], "[owl-core] read called");
});

test("readSetting warns readFailure and returns the defaults when the reader or the read function throws", async (t) => {
  const { db, writeLane, warn } = await setup(t);
  const brokenReader = { get: () => { throw new Error("select failed"); } };
  assert.equal(readSetting(brokenReader, spec()), DEFAULTS);
  assert.equal(warn.mock.calls[0].arguments[0], "[owl-core] Could not read sample");
  await writeLane.transact((tx) => upsertSetting(tx, { key: "sample_setting", valueJson: "{}" }));
  assert.equal(readSetting(db, spec({ read: () => { throw new Error("boom"); } })), DEFAULTS);
  assert.equal(warn.mock.callCount(), 2);
});

test("saveSetting stores the row, the owner, the event and one websocket outbox row", async (t) => {
  const { db, writeLane } = await setup(t);
  const value = await saveSetting(writeLane, spec({ event: { type: "settings.sample_updated", idempotencyPrefix: "settings-sample", payload: (v) => ({ wrapped: v.size }) } }), { size: 3, extra: true });
  assert.deepEqual(value, { size: 3 });
  const row = db.get("SELECT owner_id, schema_version, value_json FROM settings WHERE key = 'sample_setting'");
  assert.equal(row.owner_id, DEFAULT_OWNER_ID);
  assert.equal(row.schema_version, "1.0.0");
  assert.equal(row.value_json, JSON.stringify(value));
  assert.ok(db.get("SELECT id FROM owners WHERE id = ?", DEFAULT_OWNER_ID));
  const event = db.get("SELECT type, idempotency_key, payload_json FROM events WHERE type = 'settings.sample_updated'");
  assert.match(event.idempotency_key, new RegExp(`^settings-sample:${ULID}$`));
  assert.deepEqual(JSON.parse(event.payload_json), { wrapped: 3 });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM outbox_deliveries WHERE provider = 'websocket'").n, 1);
});

test("saveSetting uses the value itself as payload and lets the prefix depend on the value", async (t) => {
  const { db, writeLane } = await setup(t);
  await saveSetting(writeLane, spec({ event: { type: "settings.sample_updated", idempotencyPrefix: (v) => `settings-sample:${v.size}` } }), { size: 7 });
  const event = db.get("SELECT idempotency_key, payload_json FROM events WHERE type = 'settings.sample_updated'");
  assert.match(event.idempotency_key, new RegExp(`^settings-sample:7:${ULID}$`));
  assert.deepEqual(JSON.parse(event.payload_json), { size: 7 });
});

test("a second upsert changes value_json and updated_at but keeps the first schema_version", async (t) => {
  const { db, writeLane } = await setup(t);
  await writeLane.transact((tx) => upsertSetting(tx, { key: "k", valueJson: "1", now: "2026-01-01T00:00:00.000Z", schemaVersion: "2.0.0" }));
  await writeLane.transact((tx) => upsertSetting(tx, { key: "k", valueJson: "2", now: "2026-02-01T00:00:00.000Z", schemaVersion: "3.0.0" }));
  assert.deepEqual(storedSettingRow(db, "k"), { value_json: "2", updated_at: "2026-02-01T00:00:00.000Z" });
  assert.equal(db.get("SELECT schema_version FROM settings WHERE key = 'k'").schema_version, "2.0.0");
});

test("validatedSetting turns a SettingsValidationError into a validation_error with its field and rethrows others as they are", () => {
  assert.deepEqual(validatedSetting(validate, { size: 4 }), { size: 4 });
  assert.throws(
    () => validatedSetting(validate, {}),
    (error) => error instanceof HumanReadableError && error.code === "validation_error" && error.details.field === "size" && error.message === "size must be a number.",
  );
  const original = new RangeError("same object");
  assert.throws(() => validatedSetting(() => { throw original; }, null), (error) => error === original);
});

const { coreReasonMessage } = await import("../../apps/server/dist/messages/core-reasons/index.js");
const shared = (name) => import(`../../packages/shared/dist/${name}.js`);
const dependencySummary = await shared("dependency-summary-settings");
const planUsage = await shared("plan-usage-settings");
const reviewLimit = await shared("review-limit-settings");
const knowledge = await shared("knowledge-automation");
const remake = await shared("remake-limit-settings");
const routing = await shared("review-routing-settings");
const planQuality = await shared("plan-quality-settings");

const REASON_CASES = [
  [dependencySummary.DEPENDENCY_SUMMARY_SETTINGS_KEY, dependencySummary.validateDependencySummarySettings, { max_chars: 0 }, "settings.integer_range", { field: "max_chars", min: 1 }],
  [planUsage.PLAN_USAGE_SETTINGS_KEY, planUsage.validatePlanUsageSettings, { claude_usage_api_enabled: true, poll_interval_minutes: 3 }, "settings.one_of", { field: "poll_interval_minutes", allowed: "2, 5, 10, 15, 30, 60" }],
  [planUsage.PLAN_USAGE_SETTINGS_KEY, planUsage.validatePlanUsageSettings, { claude_usage_api_enabled: true }, "settings.exact_keys", { field: "payload", keys: "claude_usage_api_enabled, poll_interval_minutes" }],
  [planUsage.PLAN_USAGE_SETTINGS_KEY, planUsage.validatePlanUsageSettings, { claude_usage_api_enabled: "yes", poll_interval_minutes: 5 }, "settings.boolean", { field: "claude_usage_api_enabled" }],
  [planUsage.PLAN_USAGE_SETTINGS_KEY, planUsage.validatePlanUsageSettings, "x", "settings.not_object", { field: "payload" }],
  // The lower bound depends on another field: plan_review_rounds 5 needs total_review_attempts >= 6.
  [reviewLimit.REVIEW_LIMIT_SETTINGS_KEY, reviewLimit.validateReviewLimitSettings, { plan_review_rounds: 5, total_review_attempts: 3 }, "settings.integer_min", { field: "total_review_attempts", min: 6 }],
  [knowledge.KNOWLEDGE_AUTOMATION_SETTINGS_KEY, knowledge.validateKnowledgeAutomationSettings, { librarian_times: [] }, "settings.keys", { field: "payload", required: "librarian_times, research_autosave" }],
  [knowledge.KNOWLEDGE_AUTOMATION_SETTINGS_KEY, knowledge.validateKnowledgeAutomationSettings, { librarian_times: ["25:00"], research_autosave: true }, "settings.hh_mm_list", { field: "librarian_times" }],
  [knowledge.KNOWLEDGE_AUTOMATION_SETTINGS_KEY, knowledge.validateKnowledgeAutomationSettings, { librarian_times: [], research_autosave: true, research_source_links_max: 3, research_source_links: 4 }, "settings.integer_range", { field: "research_source_links", min: 0, max: 3 }],
  [remake.REMAKE_LIMIT_SETTINGS_KEY, remake.validateRemakeLimitSettings, { ...remake.DEFAULT_REMAKE_LIMIT_SETTINGS, verification_paths: [""] }, "settings.glob_list", { field: "verification_paths", max_length: 500 }],
  [remake.REMAKE_LIMIT_SETTINGS_KEY, remake.validateRemakeLimitSettings, { ...remake.DEFAULT_REMAKE_LIMIT_SETTINGS, checked_task_types: ["code", "code"] }, "settings.distinct_one_of_list", { field: "checked_task_types", allowed: "research, design, code, config, doc, test" }],
  [routing.REVIEW_ROUTING_SETTINGS_KEY, routing.validateReviewRoutingSettings, { ...routing.DEFAULT_REVIEW_ROUTING_SETTINGS, sensitive_paths: { "": ["a/**"] } }, "settings.named_groups", { field: "sensitive_paths", max_groups: 50, max_name_length: 100 }],
  [planQuality.PLAN_QUALITY_SETTINGS_KEY, planQuality.validatePlanQualitySettings, { ...planQuality.DEFAULT_PLAN_QUALITY_SETTINGS, component_patterns: ["("] }, "settings.regex_list", { field: "component_patterns" }],
];

for (const [key, validator, input, code, expected] of REASON_CASES) {
  test(`saving ${key} that breaks a condition rejects with reason ${code} carrying the field and condition values, and the ja/en sentences carry them in one language`, async (t) => {
    const { db, writeLane } = await setup(t);
    let caught;
    await assert.rejects(saveSetting(writeLane, spec({ key, validate: validator }), input), (error) => {
      caught = error;
      return true;
    });
    assert.equal(countOf(db, "settings"), 0);
    assert.ok(caught instanceof HumanReadableError && caught.code === "validation_error");
    assert.equal(caught.details.field, expected.field);
    assert.equal(caught.details.reason.code, code);
    const { values } = caught.details.reason;
    for (const [name, value] of Object.entries(expected)) assert.equal(values[name], value);
    const ja = coreReasonMessage("ja", code, values);
    const en = coreReasonMessage("en", code, values);
    for (const value of Object.values(values)) {
      assert.ok(ja.includes(String(value)) && en.includes(String(value)), `${code} sentences include ${value}`);
    }
    assert.match(ja, /[ぁ-ん]/);
    assert.ok(!ja.includes(caught.message), "the English message is not embedded in the ja sentence");
    assert.doesNotMatch(ja, /\b(must|exactly|integer|object|array|contain|valid)\b/i);
    assert.doesNotMatch(en, /[ぁ-んァ-ン一-龥]/);
  });
}

test("saveSetting writes no row and no event when validation fails", async (t) => {
  const { db, writeLane } = await setup(t);
  await assert.rejects(saveSetting(writeLane, spec(), {}), (error) => error instanceof HumanReadableError && error.details.field === "size");
  await assert.rejects(saveSetting(writeLane, spec(), "other"), RangeError);
  assert.equal(countOf(db, "settings"), 0);
  assert.equal(countOf(db, "events"), 0);
});

test("storedSettingJson and storedSettingRow return undefined without a row and the stored text with one", async (t) => {
  const { db, writeLane } = await setup(t);
  assert.equal(storedSettingJson(db, "missing"), undefined);
  assert.equal(storedSettingRow(db, "missing"), undefined);
  await writeLane.transact((tx) => upsertSetting(tx, { key: "present", valueJson: '"x"', now: "2026-03-01T00:00:00.000Z" }));
  assert.equal(storedSettingJson(db, "present"), '"x"');
  assert.equal(storedSettingRow(db, "present").updated_at, "2026-03-01T00:00:00.000Z");
});

test("readSetting warns readFailure and returns the defaults when the stored JSON is invalid", async (t) => {
  const { warn } = await setup(t);
  // The settings table has a json_valid CHECK, so a reader stub supplies the invalid text.
  const reader = { get: () => ({ value_json: "{not json" }) };
  assert.equal(readSetting(reader, spec()), DEFAULTS);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(warn.mock.calls[0].arguments[0], "[owl-core] Could not read sample");
});

test("a restarted Core starts and reads a stored row that still carries a removed limit key, keeping the kept values", async (t) => {
  const { DEFAULT_REMAKE_LIMIT_SETTINGS } = await import("../../packages/shared/dist/remake-limit-settings.js");
  const { DEFAULT_PLAN_QUALITY_SETTINGS } = await import("../../packages/shared/dist/plan-quality-settings.js");
  const { workVerification } = await import("../../packages/core/dist/assurance-settings.js");
  const { planQualitySettings } = await import("../../packages/core/dist/plan-quality-settings.js");
  const { root, db, core: first } = await createTestCore(t, {}, { start: true });
  const store = (key, value) => first.writeLane.transact((tx) => upsertSetting(tx, { key, valueJson: JSON.stringify(value) }));
  await store("remake_limits", { ...DEFAULT_REMAKE_LIMIT_SETTINGS, lineage_review_attempts: 7, non_functional_remakes: 2, base_sync_lineage_review_attempts: 9, base_sync_lineage_worker_runs: 10 });
  await store("work_verification", { enabled: false, max_manager_repairs: 5 });
  await store("plan_quality", { ...DEFAULT_PLAN_QUALITY_SETTINGS, max_repair_requests: 3 });
  await first.stop();

  const { core } = await createTestCore(t, { db, owlRoot: root }, { start: true });
  const remake = await core.getRemakeLimitSettings();
  assert.equal(remake.lineage_review_attempts, 7, "a kept value survives");
  assert.equal(remake.lineage_worker_runs, DEFAULT_REMAKE_LIMIT_SETTINGS.lineage_worker_runs);
  for (const key of ["non_functional_remakes", "base_sync_lineage_review_attempts", "base_sync_lineage_worker_runs"]) assert.equal(key in remake, false);
  assert.equal(workVerification(db).enabled, false, "a kept value survives");
  assert.equal("max_manager_repairs" in workVerification(db), false);
  assert.deepEqual(planQualitySettings(db), DEFAULT_PLAN_QUALITY_SETTINGS);
});

test("saveSetting rejects with validation_error for a settings error and with the same object for others", async (t) => {
  const { writeLane } = await setup(t);
  await assert.rejects(saveSetting(writeLane, spec(), {}), (error) => error.code === "validation_error");
  const original = new RangeError("same object");
  await assert.rejects(saveSetting(writeLane, spec({ validate: () => { throw original; } }), {}), (error) => error === original);
});
