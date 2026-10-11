import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { detectTestRun, markerReader, reportCheckCommands, resolveTestRun } from "../../packages/core/dist/test-detection.js";
import { DEFAULT_TEST_DETECTION_RULES } from "../../packages/core/dist/test-detection-rules.js";
import { validateTestRunSettings } from "../../packages/shared/dist/test-run-settings.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures", "test-detection");
const repoRoot = join(here, "..", "..");
const pick = (actual, expected) => Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]));
const detectIn = (root, rules = DEFAULT_TEST_DETECTION_RULES) => detectTestRun(markerReader(root, rules.max_file_bytes), rules);

test("detection picks the run style, prepare command and mode per language fixture", () => {
  const cases = [
    ["node-runner", "node-test-runner", { mode: "per_file", prepare_argv: ["npm", "run", "build"] }],
    ["node-jest", "node-script", { mode: "whole", prepare_argv: ["npm", "run", "build"], whole_argv: ["npm", "test"] }],
    ["node-yarn", "node-script", { mode: "whole", prepare_argv: ["yarn", "run", "build"], whole_argv: ["yarn", "test"] }],
    ["python", "pytest", { mode: "whole", prepare_argv: [], whole_argv: ["{python}", "-m", "pytest"] }],
    ["go", "go", { mode: "whole", prepare_argv: [], whole_argv: ["go", "test", "./..."] }],
    ["rust", "cargo", { mode: "whole", prepare_argv: [], whole_argv: ["cargo", "test"] }],
  ];
  for (const [name, ruleId, settings] of cases) {
    const detection = detectIn(join(fixtures, name));
    assert.equal(detection.rule_id, ruleId, name);
    assert.equal(detection.enabled, true, name);
    assert.deepEqual(pick(detection.settings, settings), settings, name);
  }
});

test("detection disables projects without tests and says why", () => {
  for (const [name, ruleId, reason] of [["node-no-test", "node-no-test", "node_no_test_script"], ["empty", "none", "no_test_marker"]]) {
    const detection = detectIn(join(fixtures, name));
    assert.deepEqual([detection.rule_id, detection.enabled, detection.reason, detection.settings], [ruleId, false, reason, null], name);
  }
});

test("detection reads this repository as per-file with its prepare step", () => {
  const detection = detectIn(repoRoot);
  assert.equal(detection.rule_id, "node-test-runner");
  assert.equal(detection.settings.mode, "per_file");
  assert.deepEqual(detection.settings.prepare_argv, ["pnpm", "run", "test:prepare"]);
  // The root's own prepare script is what runs the build.
  assert.match(readFileSync(join(repoRoot, "scripts", "prepare-test-checkout.mjs"), "utf8"), /run\("pnpm", \["build"\]\)/);
});

test("a table without a matching rule is an error, not a made-up result", () => {
  assert.throws(() => detectIn(join(fixtures, "empty"), { ...DEFAULT_TEST_DETECTION_RULES, rules: [] }), /no matching rule/);
});

test("a rule added to the table is applied without changing the detector", () => {
  const rules = {
    ...DEFAULT_TEST_DETECTION_RULES,
    rules: [
      {
        id: "fictional",
        when: [{ file: "go.mod", contains: "example.com" }],
        result: { enabled: true, mode: "whole", whole_argv: ["{pm}", "fictional-test"], prepare: [{ when: [{ file: "go.mod" }], argv: ["fictional-prepare"] }] },
      },
      ...DEFAULT_TEST_DETECTION_RULES.rules,
    ],
  };
  const detection = detectIn(join(fixtures, "go"), rules);
  assert.equal(detection.rule_id, "fictional");
  const expected = { mode: "whole", prepare_argv: ["fictional-prepare"], whole_argv: ["npm", "fictional-test"] };
  assert.deepEqual(pick(detection.settings, expected), expected);
  assert.equal(detectIn(join(fixtures, "go")).rule_id, "go");
});

test("every regular expression in the default table compiles", () => {
  const patterns = [];
  const visit = (condition) => {
    if ("any" in condition) condition.any.forEach(visit);
    else if ("json_file" in condition) patterns.push(condition.matches, condition.not_matches);
  };
  for (const rule of DEFAULT_TEST_DETECTION_RULES.rules) {
    rule.when.forEach(visit);
    if (rule.result.enabled) rule.result.prepare.forEach((entry) => entry.when.forEach(visit));
  }
  for (const pattern of patterns.filter((item) => item !== undefined)) new RegExp(pattern, "u");
});

const detectFiles = (files) => detectTestRun((path) => files[path] ?? null);
const pkg = (test) => JSON.stringify({ scripts: { test, build: "tsc" } });

test("bun projects run bun test with bun test file patterns", () => {
  for (const files of [
    { "package.json": pkg("bun test"), "bun.lock": "" },
    { "package.json": pkg("bun test --coverage"), "bun.lockb": "" },
    { "package.json": pkg("bun test") },
  ]) {
    const detection = detectFiles(files);
    assert.equal(detection.rule_id, "bun-test");
    assert.deepEqual(detection.settings.whole_argv, ["bun", "test"]);
    assert.deepEqual(detection.settings.prepare_argv, ["bun", "run", "build"]);
    assert.ok(detection.settings.test_patterns.some((pattern) => pattern.includes("test") && pattern.includes("tsx")));
  }
});

test("bun.lock with another scripts.test runs the script, not bun's runner", () => {
  const detection = detectFiles({ "package.json": pkg("vitest run"), "bun.lock": "" });
  assert.deepEqual([detection.rule_id, detection.settings.whole_argv], ["bun-script", ["bun", "run", "test"]]);
});

test("npm, pnpm and yarn results are unchanged by the bun rules", () => {
  const cases = [
    [{ "package.json": pkg("node --test") }, "node-test-runner", null],
    [{ "package.json": pkg("jest") }, "node-script", ["npm", "test"]],
    [{ "package.json": pkg("jest"), "pnpm-lock.yaml": "" }, "node-script", ["pnpm", "test"]],
    [{ "package.json": pkg("jest"), "yarn.lock": "" }, "node-script", ["yarn", "test"]],
    [{ "package.json": pkg("jest"), "pnpm-lock.yaml": "", "bun.lock": "" }, "node-script", ["pnpm", "test"]],
    [{ "package.json": pkg("jest"), "yarn.lock": "", "bun.lockb": "" }, "node-script", ["yarn", "test"]],
  ];
  for (const [files, ruleId, argv] of cases) {
    const detection = detectFiles(files);
    assert.equal(detection.rule_id, ruleId);
    if (argv !== null) assert.deepEqual(detection.settings.whole_argv, argv);
  }
});

test("mode whole needs whole_argv when settings are written", () => {
  assert.deepEqual(validateTestRunSettings({ mode: "whole", whole_argv: ["go", "test"] }), []);
  assert.deepEqual(validateTestRunSettings({ mode: "whole" }), ["test_run.whole_argv is required when mode is whole"]);
});

const readyRecord = (testRun, overrides = {}) => ({
  status: "ready", test_run: testRun, executables: { python: { path: "/saved/venv/bin/python", version: "3.12.0" } }, sources: [],
  digests: { layout: "l", tests: "t", sources: "s", settings: "c" }, explicit_digest: null, confirmed_at: null,
  attempts: [], outside_installs: [], missing: [], trigger: "test", investigated_at: "2026-01-01T00:00:00.000Z", ...overrides,
});
const NOW = "2026-01-01T00:00:00.000Z";
const pythonRoot = join(fixtures, "python");

test("resolveTestRun: Owner's test_run beats a saved record, which beats marker detection", () => {
  const record = readyRecord({ mode: "whole", whole_argv: ["{python}", "-m", "unittest"] });
  const setup = { setup: record, match: "exact" };
  const explicit = resolveTestRun({ explicit_json: JSON.stringify({ file_argv: ["x", "{file}"] }), detected_json: null, root: pythonRoot, now: NOW, setup });
  assert.equal(explicit.source, "explicit");
  const recorded = resolveTestRun({ explicit_json: null, detected_json: null, root: pythonRoot, now: NOW, setup });
  assert.equal(recorded.source, "setup");
  assert.deepEqual(recorded.settings.whole_argv, ["/saved/venv/bin/python", "-m", "unittest"]);
  const detected = resolveTestRun({ explicit_json: null, detected_json: null, root: pythonRoot, now: NOW, setup: null });
  assert.equal(detected.source, "detected");
});

test("resolveTestRun: {python} comes from the record, else from default_executables, and setup_argvs go first", () => {
  const record = readyRecord({ mode: "whole", whole_argv: ["{python}", "-m", "pytest"], setup_argvs: [["{python}", "-m", "venv", ".venv"]] });
  const withRecord = resolveTestRun({ explicit_json: null, detected_json: null, root: pythonRoot, now: NOW, setup: { setup: record, match: "exact" } });
  assert.deepEqual(withRecord.settings.setup_argvs, [["/saved/venv/bin/python", "-m", "venv", ".venv"]]);
  const fallback = resolveTestRun({ explicit_json: null, detected_json: null, root: pythonRoot, now: NOW, default_executables: { python: "/default/python" } });
  assert.deepEqual(fallback.settings.whole_argv, ["/default/python", "-m", "pytest"]);
  const reported = reportCheckCommands({ configured: [], explicit_json: null, detected_json: null, root: pythonRoot, setup: { setup: record, match: "exact" } });
  assert.match(reported[0], /venv \.venv$/u);
  assert.equal(reported.some((line) => line.includes("python3")), false);
});

test("resolveTestRun: gate and adoption follow how the record matched", () => {
  const record = readyRecord({ mode: "whole", whole_argv: ["{python}", "-m", "pytest"], setup_argvs: [["{python}", "-m", "venv", ".venv"]] });
  const exact = resolveTestRun({ explicit_json: null, detected_json: null, root: pythonRoot, now: NOW, setup: { setup: record, match: "exact" } });
  assert.deepEqual([exact.gate, exact.adopt_on_pass, exact.setup_match], ["all", false, "exact"]);
  const stale = resolveTestRun({ explicit_json: null, detected_json: null, root: pythonRoot, now: NOW, setup: { setup: record, match: "stale" } });
  assert.deepEqual([stale.gate, stale.adopt_on_pass], ["all", false]);
  const repair = readyRecord({ setup_argvs: [["{python}", "-m", "pip", "install", "pytest"]] }, { explicit_digest: "d" });
  const repaired = resolveTestRun({ explicit_json: JSON.stringify({ mode: "whole", whole_argv: ["{python}", "-m", "pytest"] }), detected_json: null, root: pythonRoot, now: NOW, setup: { setup: repair, match: "explicit" } });
  assert.deepEqual(repaired.gate, { only: [["/saved/venv/bin/python", "-m", "pip", "install", "pytest"]] });
  assert.deepEqual(repaired.settings.setup_argvs, repaired.gate.only);
  const none = readyRecord(null, { status: "no_language" });
  assert.deepEqual(pick(resolveTestRun({ explicit_json: null, detected_json: null, root: pythonRoot, now: NOW, setup: { setup: none, match: "exact" } }), { enabled: false, reason: "setup_no_language" }), { enabled: false, reason: "setup_no_language" });
  const noTests = resolveTestRun({ explicit_json: null, detected_json: null, root: pythonRoot, now: NOW, setup: { setup: readyRecord(null, { status: "no_tests" }), match: "exact" } });
  assert.equal(noTests.reason, "setup_no_tests");
  const firstTests = resolveTestRun({ explicit_json: null, detected_json: null, root: pythonRoot, now: NOW, setup: { setup: readyRecord({ mode: "whole", whole_argv: ["{python}", "-m", "pytest"] }, { status: "no_tests" }), match: "tests_changed" } });
  assert.deepEqual([firstTests.enabled, firstTests.source, firstTests.settings.whole_argv[0], firstTests.adopt_on_pass], [true, "setup", "/saved/venv/bin/python", true]);
  const failing = resolveTestRun({ explicit_json: null, detected_json: null, root: pythonRoot, now: NOW, setup: { setup: readyRecord({ mode: "whole", whole_argv: ["{python}", "-m", "pytest"] }, { status: "tests_failing" }), match: "exact" } });
  assert.equal(failing.adopt_on_pass, true);
  const plainRepair = resolveTestRun({ explicit_json: JSON.stringify({ mode: "whole", whole_argv: ["make", "test"] }), detected_json: null, root: pythonRoot, now: NOW, setup: null });
  assert.deepEqual(plainRepair.gate, { only: [] });
});
