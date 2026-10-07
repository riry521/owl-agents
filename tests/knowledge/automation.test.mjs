import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS,
  DEFAULT_LIBRARIAN_TIMES,
  KNOWLEDGE_AUTOMATION_SETTINGS_KEY,
  LIBRARIAN_TIME_PATTERN,
  MAX_LIBRARIAN_TIMES,
  KnowledgeAutomationValidationError,
  readKnowledgeAutomationSettings,
  validateKnowledgeAutomationSettings,
} from "../../packages/shared/dist/index.js";

test("knowledge automation defaults and valid values", () => {
  assert.equal(KNOWLEDGE_AUTOMATION_SETTINGS_KEY, "knowledge_automation");
  assert.deepEqual(DEFAULT_LIBRARIAN_TIMES, ["03:00", "15:00"]);
  assert.equal(MAX_LIBRARIAN_TIMES, 24);
  assert.equal(LIBRARIAN_TIME_PATTERN.test("23:59"), true);
  assert.deepEqual(DEFAULT_KNOWLEDGE_AUTOMATION_SETTINGS, {
    librarian_times: ["03:00", "15:00"],
    research_autosave: true,
    research_source_links: 5,
    research_source_links_max: 20,
    research_tags_min: 3,
    research_tags_max: 5,
  });
  assert.deepEqual(validateKnowledgeAutomationSettings({ librarian_times: [], research_autosave: false }), {
    librarian_times: [],
    research_autosave: false,
  });
});

test("validation removes duplicate times and sorts them", () => {
  assert.deepEqual(validateKnowledgeAutomationSettings({
    librarian_times: ["15:00", "03:00", "15:00", "00:30"],
    research_autosave: true,
  }), {
    librarian_times: ["00:30", "03:00", "15:00"],
    research_autosave: true,
  });
});

test("validation rejects malformed times, more than 24 unique times, extra keys, and non-booleans", () => {
  const invalid = (payload) => assert.throws(
    () => validateKnowledgeAutomationSettings(payload),
    KnowledgeAutomationValidationError,
  );
  invalid({ librarian_times: ["9:00"], research_autosave: true });
  invalid({ librarian_times: new Array(1), research_autosave: true });
  invalid({
    librarian_times: Array.from({ length: 25 }, (_, i) => `${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`),
    research_autosave: true,
  });
  assert.throws(
    () => validateKnowledgeAutomationSettings({ librarian_times: [], research_autosave: true, extra: true }),
    (error) => error instanceof KnowledgeAutomationValidationError && error.field === "payload",
  );
  assert.throws(
    () => validateKnowledgeAutomationSettings({ librarian_times: [], research_autosave: "true" }),
    (error) => error instanceof KnowledgeAutomationValidationError && error.field === "research_autosave",
  );
});

test("stored settings fall back per field and warn", () => {
  const warnings = [];
  assert.deepEqual(readKnowledgeAutomationSettings({
    librarian_times: ["15:00", "03:00"],
    research_autosave: "yes",
  }, (message) => warnings.push(message)), {
    librarian_times: ["03:00", "15:00"],
    research_autosave: true,
    research_source_links: 5,
    research_source_links_max: 20,
    research_tags_min: 3,
    research_tags_max: 5,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /research_autosave/u);

  warnings.length = 0;
  assert.deepEqual(readKnowledgeAutomationSettings({
    librarian_times: ["9:00"],
    research_autosave: false,
  }, (message) => warnings.push(message)), {
    librarian_times: ["03:00", "15:00"],
    research_autosave: false,
    research_source_links: 5,
    research_source_links_max: 20,
    research_tags_min: 3,
    research_tags_max: 5,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /librarian_times/u);
});

test("research_source_links is optional, bounded, and read with a default", () => {
  assert.equal(validateKnowledgeAutomationSettings({ librarian_times: [], research_autosave: true, research_source_links: 2 }).research_source_links, 2);
  for (const bad of [-1, 1.5, "3", 21]) {
    assert.throws(() => validateKnowledgeAutomationSettings({ librarian_times: [], research_autosave: true, research_source_links: bad }), KnowledgeAutomationValidationError);
  }
  const wide = { librarian_times: [], research_autosave: true, research_source_links: 30, research_source_links_max: 40 };
  assert.equal(validateKnowledgeAutomationSettings(wide).research_source_links_max, 40);
  assert.throws(() => validateKnowledgeAutomationSettings({ ...wide, research_source_links_max: 10 }), KnowledgeAutomationValidationError);
  assert.equal(readKnowledgeAutomationSettings({ ...wide, research_source_links_max: 3, research_source_links: 2 }).research_source_links_max, 3);
  assert.equal(readKnowledgeAutomationSettings({ librarian_times: [], research_autosave: true, research_source_links: 3 }).research_source_links, 3);
});

test("research_tags_max alone below the default min is accepted and applied", () => {
  const base = { librarian_times: [], research_autosave: true };
  const settings = validateKnowledgeAutomationSettings({ ...base, research_tags_max: 2 });
  const read = readKnowledgeAutomationSettings(settings);
  assert.deepEqual([read.research_tags_min, read.research_tags_max], [2, 2]);
});
