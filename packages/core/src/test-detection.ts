import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { DEFAULT_TEST_RUN_SETTINGS, readTestRunSettings, type TestRunSettings } from "../../shared/dist/test-run-settings.js";
import { testRunSettingsFromJson } from "./test-runs.js";

import {
  DEFAULT_TEST_DETECTION_RULES,
  type TestDetectionCondition,
  type TestDetectionPrepare,
  type TestDetectionRules,
} from "./test-detection-rules.js";

/** Returns a root-relative file's text, or null when it is absent, unreadable, outside the root or too large. */
export type MarkerReader = (path: string) => string | null;

export function markerReader(root: string, maxBytes: number): MarkerReader {
  return (path) => {
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    try {
      if (statSync(target).size > maxBytes) return null;
      return readFileSync(target, "utf8");
    } catch {
      return null;
    }
  };
}

export interface TestDetection {
  readonly rule_id: string;
  readonly enabled: boolean;
  /** null when enabled. */
  readonly reason: string | null;
  /** null when disabled. "{pm}" is already resolved. */
  readonly settings: TestRunSettings | null;
  /** sha256 (hex) over every file the table refers to. */
  readonly marker_digest: string;
  /** sha256 (hex) of JSON.stringify(rules). */
  readonly rules_version: string;
}

function readJsonValue(text: string | null, keyPath: readonly string[]): string | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  for (const key of keyPath) {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, key)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" ? value : null;
}

/** null when the pattern does not compile (a broken table entry never holds). */
function regexTest(pattern: string, text: string): boolean | null {
  try {
    return new RegExp(pattern, "u").test(text);
  } catch {
    return null;
  }
}

function holds(read: MarkerReader, condition: TestDetectionCondition): boolean {
  if ("any" in condition) return condition.any.some((inner) => holds(read, inner));
  if ("not" in condition) return !holds(read, condition.not);
  if ("json_file" in condition) {
    const value = readJsonValue(read(condition.json_file), condition.key_path);
    if (value === null) return false;
    if (condition.matches !== undefined && regexTest(condition.matches, value) !== true) return false;
    if (condition.not_matches !== undefined && regexTest(condition.not_matches, value) !== false) return false;
    return true;
  }
  const text = read(condition.file);
  if (text === null) return false;
  return condition.contains === undefined || text.includes(condition.contains);
}

function referencedFiles(rules: TestDetectionRules): string[] {
  const files = new Set<string>(rules.package_managers.map((entry) => entry.file));
  const visit = (condition: TestDetectionCondition): void => {
    if ("any" in condition) condition.any.forEach(visit);
    else if ("not" in condition) visit(condition.not);
    else files.add("json_file" in condition ? condition.json_file : condition.file);
  };
  const visitPrepare = (prepare: readonly TestDetectionPrepare[]): void => prepare.forEach((entry) => entry.when.forEach(visit));
  for (const rule of rules.rules) {
    rule.when.forEach(visit);
    if (rule.result.enabled) visitPrepare(rule.result.prepare);
  }
  return [...files].sort();
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export function testDetectionRulesVersion(rules: TestDetectionRules): string {
  return sha256(JSON.stringify(rules));
}

export function testDetectionMarkerDigest(read: MarkerReader, rules: TestDetectionRules): string {
  const hash = createHash("sha256");
  for (const file of referencedFiles(rules)) hash.update(`${file}\0${read(file) ?? "\u0000absent"}\n`);
  return hash.digest("hex");
}

export function detectTestRun(read: MarkerReader, rules: TestDetectionRules = DEFAULT_TEST_DETECTION_RULES): TestDetection {
  const manager = rules.package_managers.find((entry) => read(entry.file) !== null)?.name ?? rules.default_package_manager;
  const resolveArgv = (argv: readonly string[]): string[] => argv.map((item) => item.replaceAll("{pm}", manager));
  const base = { marker_digest: testDetectionMarkerDigest(read, rules), rules_version: testDetectionRulesVersion(rules) };
  const rule = rules.rules.find((candidate) => candidate.when.every((condition) => holds(read, condition)));
  if (rule === undefined) throw new Error("test detection rules have no matching rule (add a catch-all rule with when: [])");
  const result = rule.result;
  if (!result.enabled) return { rule_id: rule.id, enabled: false, reason: result.reason, settings: null, ...base };
  const prepare_argv = resolveArgv(result.prepare.find((entry) => entry.when.every((condition) => holds(read, condition)))?.argv ?? []);
  const settings: TestRunSettings = result.mode === "whole"
    ? { ...DEFAULT_TEST_RUN_SETTINGS, mode: "whole", prepare_argv, whole_argv: resolveArgv(result.whole_argv), ...(result.test_patterns === undefined ? {} : { test_patterns: result.test_patterns }) }
    : {
        ...DEFAULT_TEST_RUN_SETTINGS,
        mode: "per_file",
        prepare_argv,
        ...(result.file_argv === undefined ? {} : { file_argv: result.file_argv }),
        ...(result.test_patterns === undefined ? {} : { test_patterns: result.test_patterns }),
      };
  return { rule_id: rule.id, enabled: true, reason: null, settings, ...base };
}

export interface StoredTestDetection extends TestDetection {
  readonly detected_at: string;
}

export type TestRunResolution =
  | { readonly enabled: true; readonly source: "explicit" | "detected"; readonly settings: TestRunSettings; readonly save: StoredTestDetection | null }
  | { readonly enabled: false; readonly source: "explicit" | "detected"; readonly reason: string; readonly save: StoredTestDetection | null };

function storedDetection(json: string | null): StoredTestDetection | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as StoredTestDetection) : null;
  } catch {
    return null;
  }
}

/**
 * How to run a Project's tests in `root`: the Owner's explicit test_run first, then the saved detection while the
 * rules and the marker files are unchanged, otherwise a fresh detection (returned in `save` for the caller to store).
 */
export function resolveTestRun(input: {
  readonly explicit_json: string | null;
  readonly detected_json: string | null;
  readonly root: string;
  readonly rules?: TestDetectionRules;
  readonly now: string;
  readonly warn?: (message: string) => void;
}): TestRunResolution {
  const rules = input.rules ?? DEFAULT_TEST_DETECTION_RULES;
  if (input.explicit_json !== null) {
    const settings = testRunSettingsFromJson(input.explicit_json, input.warn);
    if (settings === null) return { enabled: false, source: "explicit", reason: "invalid_settings", save: null };
    if (settings.mode === "off") return { enabled: false, source: "explicit", reason: "explicit_off", save: null };
    return { enabled: true, source: "explicit", settings, save: null };
  }
  const read = markerReader(input.root, rules.max_file_bytes);
  const saved = storedDetection(input.detected_json);
  const current = saved !== null && saved.rules_version === testDetectionRulesVersion(rules) && saved.marker_digest === testDetectionMarkerDigest(read, rules);
  const detection = current ? saved : detectTestRun(read, rules);
  const save = current ? null : { ...detection, detected_at: input.now };
  if (!detection.enabled || detection.settings === null) return { enabled: false, source: "detected", reason: detection.reason ?? "no_test_marker", save };
  return { enabled: true, source: "detected", settings: readTestRunSettings(detection.settings, input.warn), save };
}
