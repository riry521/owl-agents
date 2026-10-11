import assert from "node:assert/strict";
import { test } from "node:test";

import { OutputFormatError } from "../../packages/agent-runtime/dist/output-resubmit.js";
import { buildTestSetupInvestigationPrompt, parseTestSetupResponse } from "../../packages/agent-runtime/dist/test-setup-investigation.js";
import { DEFAULT_TEST_SETUP_SETTINGS } from "../../packages/shared/dist/test-setup-settings.js";

const request = (over = {}) => ({
  invocation_id: "01TESTINVOCATION",
  project: { id: "P1", name: "Sample" },
  scope: "project",
  checkout: "/tmp/sample",
  trigger: "project_registered",
  mode: "find",
  explicit_test_run: null,
  first_candidate: { rule_id: "python-pytest", mode: "whole", prepare_argv: [], argv: ["{python}", "-m", "pytest", "-q"] },
  current: { status: "tests_failing", marker: "CURRENT_RECORD_MARKER" },
  failure: null,
  approved_installs: [["brew", "install", "jq"]],
  bootstrap: DEFAULT_TEST_SETUP_SETTINGS.bootstrap,
  role: "worker",
  timeout_ms: 1000,
  env: {},
  ...over,
});

const output = (over = {}) => ({
  verdict: "ready",
  setup_argvs: [],
  test_run: { mode: "whole", whole_argv: ["{python}", "-m", "pytest", "-q"], file_argv: [], prepare_argv: [], test_patterns: ["**/test_*.py"], cwd: "." },
  executables: [{ name: "python", path: ".venv/bin/python", probe_argv: ["{python}", "--version"] }],
  confirm_files: [],
  probe_argvs: [],
  sources: ["README.md"],
  attempts: [],
  installed: [],
  outside_installs: [],
  missing: [],
  notes: "",
  ...over,
});

const answer = (value) => ({ adapter: "claude", stdout: JSON.stringify({ type: "result", result: typeof value === "string" ? value : JSON.stringify(value) }), format: "provider-json" });

test("the prompt carries the steps, the first candidate, the current record, approved commands and the bootstrap", () => {
  const prompt = buildTestSetupInvestigationPrompt(request());
  for (let step = 1; step <= 11; step += 1) assert.match(prompt, new RegExp(`${step}\\. `, "u"), `step ${step}`);
  assert.match(prompt, /python-pytest/u);
  assert.match(prompt, /CURRENT_RECORD_MARKER/u);
  assert.match(prompt, /brew/u);
  assert.match(prompt, /run it yourself; Core records the command/u);
  assert.match(prompt, /pip install -e <path outside the Project>\) needs no approval: run it yourself/u);
  assert.doesNotMatch(prompt, /do not run them/u);
  assert.doesNotMatch(prompt, /put it with a reason in outside_installs/u);
  assert.match(prompt, /needs_owner = the environment needs something you cannot do automatically/u);
  assert.match(prompt, /- python: Create a virtual environment in \.venv/u);
  assert.match(prompt, /setup_argvs in test_run\.cwd \(not the checkout root\)/u);
  assert.match(prompt, /mode is find/u);
  assert.doesNotMatch(prompt, /mode is repair_explicit/u);
});

test("repair_explicit tells the agent to keep the Owner's command", () => {
  const prompt = buildTestSetupInvestigationPrompt(request({ mode: "repair_explicit", explicit_test_run: { whole_argv: ["make", "test"] } }));
  assert.match(prompt, /mode is repair_explicit: do not change the command in explicit_test_run/u);
  assert.match(prompt, /make/u);
});

test("parseTestSetupResponse accepts one valid object, with or without a json fence", () => {
  assert.equal(parseTestSetupResponse(answer(output())).verdict, "ready");
  assert.equal(parseTestSetupResponse(answer(`\`\`\`json\n${JSON.stringify(output())}\n\`\`\``)).verdict, "ready");
});

test("parseTestSetupResponse rejects malformed output with OutputFormatError", () => {
  const bad = [
    ["not json", answer("no json here")],
    ["unknown verdict", answer(output({ verdict: "great" }))],
    ["missing field", answer({ verdict: "ready" })],
    ["probe not starting with its name", answer(output({ executables: [{ name: "python", path: ".venv/bin/python", probe_argv: ["python3", "--version"] }] }))],
    ["empty setup command", answer(output({ setup_argvs: [[]] }))],
    ["ready without test_run", answer(output({ test_run: null }))],
  ];
  for (const [label, response] of bad) assert.throws(() => parseTestSetupResponse(response, { mode: "find" }), OutputFormatError, label);
  assert.throws(() => parseTestSetupResponse(answer(output()), { mode: "repair_explicit" }), OutputFormatError, "repair_explicit must not return a test_run");
  assert.equal(parseTestSetupResponse(answer(output({ test_run: null })), { mode: "repair_explicit" }).test_run, null);
});
