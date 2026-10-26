import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADVISOR_WINDOW_SETTINGS_KEY,
  AdvisorWindowSettingsValidationError,
  DEFAULT_ADVISOR_WINDOW_SETTINGS,
  defaultChannelName,
  isValidChannelNamePrefix,
  normalizeChannelName,
  readAdvisorWindowSettings,
  validateAdvisorWindowSettings,
} from "../../packages/shared/dist/advisor-window-settings.js";
import { createTestCore } from "../helpers/core.mjs";

const ALLOWED = /^[\p{L}\p{N}_-]*$/u;
const settingsWith = (patch) => ({ ...DEFAULT_ADVISOR_WINDOW_SETTINGS, ...patch });
const fieldOf = (patch) => {
  try {
    validateAdvisorWindowSettings(settingsWith(patch));
  } catch (error) {
    assert.ok(error instanceof AdvisorWindowSettingsValidationError);
    return error.field;
  }
  return null;
};

test("the default window settings pass validation and are what a missing or broken stored value reads as", () => {
  assert.deepEqual(validateAdvisorWindowSettings(DEFAULT_ADVISOR_WINDOW_SETTINGS), DEFAULT_ADVISOR_WINDOW_SETTINGS);
  const warnings = [];
  assert.deepEqual(readAdvisorWindowSettings({ idle_timeout_seconds: "soon" }, (message) => warnings.push(message)), DEFAULT_ADVISOR_WINDOW_SETTINGS);
  assert.deepEqual(readAdvisorWindowSettings(null), DEFAULT_ADVISOR_WINDOW_SETTINGS);
  assert.equal(warnings.length, 1);
});

test("channel name prefixes may be empty or end in one separator, and nothing else odd", () => {
  for (const prefix of ["", "owl-", "team_", "owl", "a-b-"]) assert.equal(isValidChannelNamePrefix(prefix), true, prefix);
  for (const prefix of ["-owl", "o--wl", "Owl-", "owl!", "owl ", "a".repeat(21), "owl--"]) assert.equal(isValidChannelNamePrefix(prefix), false, prefix);
  assert.equal(isValidChannelNamePrefix("a".repeat(20)), true);
});

test("out-of-range values and a max length not above the prefix length are rejected with the field", () => {
  assert.equal(fieldOf({ channel_name_prefix: "-owl" }), "channel_name_prefix");
  assert.equal(fieldOf({ channel_name_prefix: "owl-", channel_name_max_length: 4 }), "channel_name_max_length");
  assert.equal(fieldOf({ channel_name_prefix: "owl-", channel_name_max_length: 5 }), null);
  assert.equal(fieldOf({ idle_timeout_seconds: 59 }), "idle_timeout_seconds");
  assert.equal(fieldOf({ idle_timeout_seconds: 604_801 }), "idle_timeout_seconds");
  assert.equal(fieldOf({ channel_name_max_length: 81 }), "channel_name_max_length");
  assert.equal(fieldOf({ history_handoff_messages: -1 }), "history_handoff_messages");
  assert.equal(fieldOf({ project_backlog_limit: 201 }), "project_backlog_limit");
  assert.equal(fieldOf({ handoff_summary_max_chars: 99 }), "handoff_summary_max_chars");
  assert.equal(fieldOf({ idle_timeout_seconds: 60.5 }), "idle_timeout_seconds");
  assert.throws(() => validateAdvisorWindowSettings({ ...DEFAULT_ADVISOR_WINDOW_SETTINGS, extra: 1 }), AdvisorWindowSettingsValidationError);
  assert.throws(() => validateAdvisorWindowSettings([]), AdvisorWindowSettingsValidationError);
});

test("normalizeChannelName keeps only allowed characters, the max length and no dash at either end", () => {
  const settings = { channel_name_max_length: 12 };
  for (const input of ["My Project", "-leading", "trailing-", "a  b..c/d", "日本語 プロジェクト", "!!!", "Ünï-Cödé", "x".repeat(40), "a-" + "b".repeat(9) + "-c"]) {
    const name = normalizeChannelName(input, settings);
    assert.match(name, ALLOWED, input);
    assert.ok(Array.from(name).length <= settings.channel_name_max_length, input);
    assert.ok(!name.startsWith("-") && !name.endsWith("-"), `${input} -> ${name}`);
  }
  assert.equal(normalizeChannelName("My Project", { channel_name_max_length: 80 }), "my-project");
});

test("defaultChannelName is the prefix directly followed by the normalized project name", () => {
  for (const channel_name_prefix of ["owl-", "team_", ""]) {
    const settings = { channel_name_prefix, channel_name_max_length: 40 };
    for (const name of ["Billing API", "日本語 プロジェクト", "-leading dash", "a  b"]) {
      const result = defaultChannelName(name, "01HZZZZZZZZZZZZZZZZZZZZZZZ", settings);
      assert.ok(result.startsWith(channel_name_prefix), result);
      assert.equal(result, `${channel_name_prefix}${normalizeChannelName(name, settings)}`);
      assert.equal(normalizeChannelName(result, settings), result, "renormalizing changes nothing");
      assert.ok(Array.from(result).length <= settings.channel_name_max_length);
    }
  }
});

test("a long name is cut to exactly the max length without a trailing dash, and a symbols-only name uses the project id", () => {
  const settings = { channel_name_prefix: "owl-", channel_name_max_length: 20 };
  const long = defaultChannelName("word ".repeat(30), "01HABCDEFGHJKMNPQRSTVWXYZ0", settings);
  assert.equal(Array.from(long).length, 20);
  assert.ok(long.startsWith("owl-") && !long.endsWith("-"));
  const cutAtDash = defaultChannelName("abcdefgh ijklmnop", "01HABCDEFGHJKMNPQRSTVWXYZ0", settings);
  assert.ok(!cutAtDash.endsWith("-"), cutAtDash);
  assert.equal(defaultChannelName("!!! ???", "01HABCDEFGHJKMNPQRSTVWXYZ0", settings), `owl-${"01HABCDEFGHJKMNPQRSTVWXYZ0".slice(-8).toLowerCase()}`);
});

test("Core stores the settings under the advisor_windows key and reads them back", async (t) => {
  const { core, db } = await createTestCore(t, { version: "advisor-window-settings-test" });
  assert.deepEqual(await core.getAdvisorWindowSettings(), DEFAULT_ADVISOR_WINDOW_SETTINGS);
  const next = settingsWith({ idle_timeout_seconds: 900, channel_name_prefix: "team_", channel_name_max_length: 30 });
  assert.deepEqual(await core.setAdvisorWindowSettings(next), next);
  assert.deepEqual(JSON.parse(db.get("SELECT value_json FROM settings WHERE key = ?", ADVISOR_WINDOW_SETTINGS_KEY).value_json), next);
  assert.deepEqual(await core.getAdvisorWindowSettings(), next);
  await assert.rejects(core.setAdvisorWindowSettings(settingsWith({ channel_name_prefix: "-owl" })), (error) => error?.code === "validation_error");
  assert.deepEqual(await core.getAdvisorWindowSettings(), next);
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE settings SET value_json = ? WHERE key = ?", JSON.stringify({ idle_timeout_seconds: 1 }), ADVISOR_WINDOW_SETTINGS_KEY);
    return null;
  });
  assert.deepEqual(await core.getAdvisorWindowSettings(), DEFAULT_ADVISOR_WINDOW_SETTINGS);
});
