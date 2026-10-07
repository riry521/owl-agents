import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import * as ruleStore from "../../packages/core/dist/rule-store.js";

const { parseRuleYaml, renderRuleFile } = ruleStore;

const roundTripTexts = [
  "Keep a clean worktree before merging.",
  "Don't run an unreviewed command.",
  'Use "git worktree" before cleanup.',
  `say "a #1" and 'b'`,
  `say "a" # not 'b'`,
  String.raw`C:\work\owl\rules`,
];

function instructionFile(text) {
  return { path: "fixture.yaml", level: "system", rules: [{ id: "round-trip", kind: "instruction", text }] };
}

test("rule YAML parser is exported and fixture strings round-trip through the actual parser", () => {
  assert.equal(typeof parseRuleYaml, "function");
  assert.equal(typeof renderRuleFile, "function");
  for (const text of roundTripTexts) {
    const rendered = renderRuleFile(instructionFile(text));
    const parsed = parseRuleYaml(rendered, "fixture.yaml");
    assert.deepEqual(parsed, instructionFile(text), text);
  }
  assert.match(renderRuleFile(instructionFile(roundTripTexts[0])), /text: "/u, "double quotes are the first serialization candidate");
});

test("the default system rules file loads the minimal-work rule as a system instruction", async () => {
  const path = resolve("rules/system/defaults.yaml");
  const file = parseRuleYaml(await readFile(path, "utf8"), path);
  assert.equal(file.level, "system");
  const rule = file.rules.find((r) => r.id === "minimal-work");
  assert.equal(rule?.kind, "instruction");
  assert.match(rule.text, /minimum/u);
});

test("the single quote candidate rescues text cut by the double quote candidate", () => {
  const text = `say "a #1" and 'b'`;
  const rendered = renderRuleFile(instructionFile(text));
  assert.match(rendered, /text: '/u);
  assert.equal(parseRuleYaml(rendered, "fixture.yaml").rules[0].text, text);
});

test("text that neither quote style can preserve and control characters are rejected", () => {
  for (const text of [`say "hi #1 and 'bye #2`, "line one\nline two", "tab\there"]) {
    assert.throws(() => renderRuleFile(instructionFile(text)), (error) => error?.code === "text_not_serializable");
  }
});

test("rendering existing rule files preserves every parsed field", async () => {
  const path = resolve("rules/system/defaults.yaml");
  const original = parseRuleYaml(await readFile(path, "utf8"), path);
  const roundTripped = parseRuleYaml(renderRuleFile(original), path);
  assert.deepEqual(roundTripped, original);
});
