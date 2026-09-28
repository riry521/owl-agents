import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(repoRoot, "apps/web/package.json"));
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
let hookValues = [];
const componentReact = {
  ...React,
  useState(initial) {
    const value = hookValues.length > 0 ? hookValues.shift() : initial;
    return [value, () => {}];
  },
  useEffect() {},
  useCallback(callback) { return callback; },
  useRef(initial) { return { current: initial }; },
};

function compileFormat() {
  const modulePath = join(repoRoot, "apps/web/lib/format.ts");
  const { outputText } = ts.transpileModule(readFileSync(modulePath, "utf8"), {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const stubs = {
    "@/lib/i18n/ja.json": JSON.parse(readFileSync(join(repoRoot, "apps/web/lib/i18n/ja.json"), "utf8")),
    "@/lib/i18n/en.json": JSON.parse(readFileSync(join(repoRoot, "apps/web/lib/i18n/en.json"), "utf8")),
    "@/lib/work-detail-safety.mjs": {},
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, modulePath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

const formatModule = compileFormat();

function compileActivityLog() {
  const modulePath = join(repoRoot, "apps/web/components/ActivityLog.tsx");
  const source = readFileSync(modulePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "react") return componentReact;
    if (request === "@/lib/format") return formatModule;
    if (request === "@/lib/api-client") return { listEvents: async () => [] };
    if (request === "@/lib/i18n") return { useLocale: () => ({ t: (key) => ({ "activity.systemAlert": "System alert", "activity.alertBranchCleanupFailed": "Branch cleanup failed" }[key] ?? key) }) };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, modulePath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports.default;
}

const ActivityLog = compileActivityLog();

test("Activity Log titles a system alert by its kind and shows its message", () => {
  hookValues = [[{
    event_id: "event-1",
    type: "system.alert",
    work_id: "work-123456",
    payload: { kind: "work_merge_branch_cleanup_failed", message: "Could not remove worktree /repo/.owl-workspaces/work-123456: git worktree is busy." },
    created_at: new Date().toISOString(),
  }], ""];

  const markup = renderToStaticMarkup(React.createElement(ActivityLog));

  assert.match(markup, /Branch cleanup failed/);
  assert.doesNotMatch(markup, /System alert/);
  assert.match(markup, /Could not remove worktree \/repo\/\.owl-workspaces\/work-123456: git worktree is busy\./);
});

test("Activity Log falls back to a generic title for an alert kind it does not know", () => {
  hookValues = [[{
    event_id: "event-2",
    type: "system.alert",
    work_id: null,
    payload: { kind: "something_new", message: "Something happened." },
    created_at: new Date().toISOString(),
  }], ""];

  const markup = renderToStaticMarkup(React.createElement(ActivityLog));

  assert.match(markup, /System alert/);
  assert.match(markup, /Something happened\./);
});

test("Activity Log labels automatic push alerts and shows their reasons", () => {
  const pushAlertCases = [
    ["work_push_failed", "activity.alertWorkPushFailed", "Push rejected: non-fast-forward."],
    ["work_push_blocked_by_hook", "activity.alertWorkPushBlocked", "Push rejected by pre-push hook."],
    ["work_push_skipped_no_upstream", "activity.alertWorkPushSkipped", "No upstream is configured."],
  ];
  const events = pushAlertCases.map(([kind, , message], index) => ({
    event_id: `push-alert-${index}`,
    type: "system.alert",
    payload: { kind, message },
    created_at: new Date().toISOString(),
  }));
  hookValues = [events, ""];

  const markup = renderToStaticMarkup(React.createElement(ActivityLog));

  for (const [, labelKey, message] of pushAlertCases) {
    assert.ok(markup.includes(labelKey));
    assert.ok(markup.includes(message));
  }
});

test("Activity Log labels a successful push and shows its remote branch", () => {
  hookValues = [[{
    event_id: "push-event",
    type: "work.pushed",
    payload: { remote: "origin", remote_branch: "main" },
    created_at: new Date().toISOString(),
  }], ""];

  const markup = renderToStaticMarkup(React.createElement(ActivityLog));

  assert.match(markup, /activity\.workPushed/);
  assert.match(markup, /⬆️/u);
  assert.match(markup, /origin\/main/);
});

test("Activity Log shows an agent event's model and effort instead of its provider", () => {
  hookValues = [[
    { event_id: "deferred-1", type: "reviewer.deferred", payload: { provider: "anthropic", model: "claude-opus-5-5", effort: "low" }, created_at: new Date().toISOString() },
    { event_id: "deferred-2", type: "reviewer.deferred", payload: { provider: "openai", model: "gpt-5.4", effort: null }, created_at: new Date().toISOString() },
    // Recorded before payloads carried model: the API attaches the AgentRun's model/effort.
    { event_id: "deferred-3", type: "reviewer.deferred", agent_run_id: "run-3", agent_run: { model: "claude-sonnet-5", effort: "high" }, payload: { provider: "claude" }, created_at: new Date().toISOString() },
    { event_id: "limited-4", type: "reviewer.rate_limited", agent_run_id: "run-4", agent_run: { model: "gpt-5.4", effort: "medium" }, payload: { provider: "codex" }, created_at: new Date().toISOString() },
  ], ""];

  const markup = renderToStaticMarkup(React.createElement(ActivityLog));

  assert.match(markup, /Opus5\.5-low/);
  assert.match(markup, /GPT-5\.4</);
  assert.match(markup, /Sonnet5-high/);
  assert.match(markup, /GPT-5\.4-medium/);
  assert.doesNotMatch(markup, /anthropic|openai|>claude<|>codex</);
});
