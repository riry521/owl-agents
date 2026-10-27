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

const UNITS = ["file", "folder", "package"];
const output = (over = {}) => ({
  verdict: "ready",
  setup_argvs: [],
  setup_inputs: [],
  setup_outputs: [],
  test_run: { mode: "whole", whole_argv: ["{python}", "-m", "pytest", "-q"], file_argv: [], prepare_argv: [], test_patterns: ["**/test_*.py"], cwd: ".", unit: "file", unit_argv: [], unit_markers: [] },
  executables: [{ name: "python", path: ".venv/bin/python", probe_argv: ["{python}", "--version"] }],
  confirm_files: [],
  probe_argvs: [],
  sources: ["README.md"],
  attempts: UNITS.map((unit) => ({ argv: ["{python}", "-m", "pytest", unit], cwd: ".", exit_code: 1, summary: "failed", unit })),
  installed: [],
  outside_installs: [],
  missing: [],
  notes: "whole: this runner cannot run a single file",
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

test("the prompt makes per_file the default and setup_argvs safe to repeat", () => {
  const prompt = buildTestSetupInvestigationPrompt(request());
  assert.match(prompt, /mode per_file runs one unit at a time\. Try the units in this order: file, folder, package\. Stop at the first unit that works and do not skip a unit/u);
  assert.match(prompt, /Choose mode whole only when none of the units works; then write in notes what you tried for each unit/u);
  assert.match(prompt, /10\. Write every command you ran and its result in attempts\. For a command that ran tests as one unit, write that unit in the attempt's unit/u);
  assert.match(prompt, /unit is file, and unit_argv and unit_markers are empty/u);
  assert.match(prompt, /must not delete or rebuild an environment that is already in place/u);
  assert.match(prompt, /venv --clear/u);
});

test("the prompt asks for the setup's dependency files and made paths", () => {
  const prompt = buildTestSetupInvestigationPrompt(request());
  assert.match(prompt, /setup_inputs/u);
  assert.match(prompt, /setup_outputs/u);
  assert.match(prompt, /re-runs the setup when an input's content changes or an output is missing/u);
});

test("parseTestSetupResponse accepts whole only with a reason in notes", () => {
  assert.throws(() => parseTestSetupResponse(answer(output({ notes: " " })), { mode: "find" }), OutputFormatError);
  assert.equal(parseTestSetupResponse(answer(output()), { mode: "find" }).test_run.mode, "whole");
  const perFile = { mode: "per_file", whole_argv: [], file_argv: ["{python}", "-m", "pytest", "{file}"], prepare_argv: [], test_patterns: ["**/test_*.py"], cwd: ".", unit: "file", unit_argv: [], unit_markers: [] };
  assert.equal(parseTestSetupResponse(answer(output({ notes: "", test_run: perFile, attempts: [output().attempts[0]], confirm_files: ["tests/test_app.py"] })), { mode: "find" }).test_run.mode, "per_file");
});

const unitRun = (unit, over = {}) => ({ mode: "per_file", whole_argv: [], file_argv: ["{python}", "-m", "pytest", "{file}"], prepare_argv: [], test_patterns: ["**/test_*.py"], cwd: ".", unit, unit_argv: unit === "file" ? [] : ["{python}", "-m", "pytest", "{unit}"], unit_markers: unit === "package" ? ["unit.marker"] : [], ...over });
const tried = (...units) => units.map((unit) => ({ argv: ["x"], cwd: ".", exit_code: 0, summary: "", unit }));
const parsed = (over) => parseTestSetupResponse(answer(output({ notes: "finer units fail", confirm_files: ["a"], ...over })), { mode: "find" });
const rejects = (over, start) => assert.throws(() => parsed(over), (error) => error instanceof OutputFormatError && error.message.startsWith(start), start);

test("parseTestSetupResponse checks the unit order, the chosen unit and the unit fields", () => {
  for (const units of [["file", "folder"], ["file", "file", "folder"], ["file", "folder", "folder"]]) {
    assert.equal(parsed({ test_run: unitRun("folder"), attempts: tried(...units) }).test_run.unit, "folder");
  }
  const blank = { argv: ["setup"], cwd: ".", exit_code: 0, summary: "", unit: "" };
  assert.equal(parsed({ test_run: unitRun("folder"), attempts: [...tried("file"), blank, ...tried("folder")] }).test_run.unit, "folder");
  assert.equal(parsed({ test_run: unitRun("package"), attempts: tried("file", "folder", "package") }).test_run.unit, "package");
  assert.equal(parsed({ test_run: unitRun("file"), attempts: [...tried("file"), { argv: ["setup"], cwd: ".", exit_code: 0, summary: "", unit: "" }], notes: "" }).test_run.unit, "file");
  rejects({ test_run: unitRun("folder"), attempts: tried("folder") }, "attempts: try the units in the order file, folder, package: no attempt with unit file before choosing folder");
  rejects({ test_run: unitRun("folder"), attempts: tried("folder", "file") }, "attempts: try the units in the order file, folder, package: an attempt with unit file comes after an attempt with unit folder");
  rejects({ test_run: unitRun("folder"), attempts: tried("file", "folder", "package") }, "attempts: stop at the first unit that works: an attempt with unit package comes after choosing folder");
  rejects({ test_run: unitRun("package"), attempts: tried("file", "package") }, "attempts: try the units in the order file, folder, package: no attempt with unit folder before choosing package");
  rejects({ test_run: unitRun("package"), attempts: tried("file", "folder") }, "attempts: try the units in the order file, folder, package: no attempt with unit package before choosing package");
  rejects({ attempts: tried("package", "folder", "file") }, "attempts: try the units in the order file, folder, package: an attempt with unit folder comes after an attempt with unit package");
  rejects({ attempts: tried("file", "package") }, "attempts: mode whole needs an attempt for every unit (file, folder, package): no attempt with unit folder");
  rejects({ test_run: { ...output().test_run, unit: "folder" } }, "test_run.unit: must be file when mode is whole");
  rejects({ verdict: "no_tests", test_run: unitRun("folder"), attempts: [], probe_argvs: [["x"]] }, "test_run.unit: must be file when verdict is no_tests");
  rejects({ test_run: unitRun("folder"), attempts: tried("file", "folder"), notes: " " }, "notes: required when test_run.unit is folder or package");
  rejects({ test_run: unitRun("folder", { unit_argv: ["x", "{unit}", "{unit}"] }), attempts: tried("file", "folder") }, "test_run.unit_argv: must contain {unit} exactly once and no {file}");
  rejects({ test_run: unitRun("folder", { unit_argv: ["x", "{unit}", "{file}"] }), attempts: tried("file", "folder") }, "test_run.unit_argv: must contain {unit} exactly once and no {file}");
  rejects({ test_run: unitRun("package", { unit_markers: [] }), attempts: tried("file", "folder", "package") }, "test_run.unit_markers: required when unit is package");
  rejects({ notes: " " }, "notes: required when test_run.mode is whole: write why no unit (file, folder, package) can be run alone, or use per_file");
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
