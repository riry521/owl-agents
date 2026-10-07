import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { repoRoot } from "../helpers/paths.mjs";

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

function compileProjectManagement() {
  const modulePath = join(repoRoot, "apps/web/lib/project-management.ts");
  const { outputText } = ts.transpileModule(readFileSync(modulePath, "utf8"), {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(modulePath);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(dirname(modulePath));
  loaded._compile(outputText, modulePath);
  return loaded.exports;
}

const projectManagementModule = compileProjectManagement();
let listedEvents = [];

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
    if (request === "@/lib/project-management") return projectManagementModule;
    if (request === "@/lib/view-loader") return { useView: () => { const data = hookValues.shift(); const error = hookValues.shift(); return { data, error: error || null, loading: false, refresh: async () => {} }; } };
    if (request === "@/lib/api-client") return { listEvents: async () => listedEvents, listEventsPage: async () => ({ events: listedEvents, cursor: null, has_more: false }) };
    if (request === "@/lib/i18n") return { useLocale: () => ({ t: (key, vars) => ({ "activity.systemAlert": "System alert", "activity.alertBranchCleanupFailed": "Branch cleanup failed" }[key] ?? (vars ? `${key}(${Object.values(vars).join(",")})` : key)) }) };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    loaded._compile(outputText, modulePath);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports;
}

const { default: ActivityLog, WorkPostMergeEvents, appendPostMergeEvents } = compileActivityLog();

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

test("Activity Log shows post-merge command queued and succeeded with a quoted command and seconds", () => {
  hookValues = [[
    { event_id: "pm-q", type: "work.post_merge_command_queued", payload: { argv: ["pnpm", "build"] }, created_at: new Date().toISOString() },
    { event_id: "pm-ok", type: "work.post_merge_command_succeeded", payload: { argv: ["node", "-e", "a b"], exit_code: 0, duration_ms: 93512 }, created_at: new Date().toISOString() },
  ], ""];

  const markup = renderToStaticMarkup(React.createElement(ActivityLog));

  assert.match(markup, /⏳/u);
  assert.match(markup, /activity\.workPostMergeQueued/);
  assert.match(markup, /activity\.workPostMergeSucceeded/);
  assert.match(markup, /pnpm build</);
  assert.ok(markup.includes("node -e &#x27;a b&#x27; · activity.durationSeconds(94)"));
});

test("Activity Log shows a failed post-merge command's exit code and output tail", () => {
  hookValues = [[
    { event_id: "pm-ng", type: "system.alert", payload: { kind: "work_post_merge_command_failed", message: "Build failed.", exit_code: 2, stdout_tail: "out", stderr_tail: "TS2304 boom" }, created_at: new Date().toISOString() },
  ], ""];

  const markup = renderToStaticMarkup(React.createElement(ActivityLog));

  assert.match(markup, /activity\.alertWorkPostMergeFailed/);
  assert.match(markup, /activity\.exitCode: 2/);
  assert.match(markup, /TS2304 boom/);
});

test("Work screen section lists only that Work's post-merge command events", () => {
  const now = new Date().toISOString();
  listedEvents = [
    { event_id: "w-ng", type: "system.alert", work_id: "work-A", payload: { kind: "work_post_merge_command_failed", message: "Build failed.", exit_code: 3, stderr_tail: "tail-A" }, created_at: now },
    { event_id: "w-other", type: "work.post_merge_command_succeeded", work_id: "work-B", payload: { argv: ["other"] }, created_at: now },
    { event_id: "w-push", type: "work.pushed", work_id: "work-A", payload: {}, created_at: now },
  ];
  // the component's own filter (work_id and post-merge event type) runs on the unfiltered page
  const filtered = appendPostMergeEvents([], listedEvents, "work-A");
  // event_id is not rendered, so check the filter result itself: other Work and work.pushed are dropped
  assert.deepEqual(filtered.map((e) => e.event_id), ["w-ng"]);
  hookValues = [filtered];

  const markup = renderToStaticMarkup(React.createElement(WorkPostMergeEvents, { workId: "work-A", refreshToken: 0 }));

  assert.match(markup, /activity\.postMergeHistory/);
  assert.match(markup, /activity\.exitCode: 3/);
  assert.match(markup, /tail-A/);
  assert.doesNotMatch(markup, /other/);
  assert.doesNotMatch(markup, /w-push/);
  hookValues = [appendPostMergeEvents([], listedEvents, "work-C")];
  assert.equal(renderToStaticMarkup(React.createElement(WorkPostMergeEvents, { workId: "work-A", refreshToken: 0 })), "");
});

test("Work screen section shows an error, not nothing, when the history failed to load", () => {
  // useState order: events, nextCursor, loading, loadFailed
  hookValues = [[], null, false, "history down"];
  const failed = renderToStaticMarkup(React.createElement(WorkPostMergeEvents, { workId: "work-A", refreshToken: 0 }));
  assert.match(failed, /activity\.postMergeLoadError: history down/);
  assert.match(failed, /role="alert"/);
  hookValues = [];
  assert.equal(renderToStaticMarkup(React.createElement(WorkPostMergeEvents, { workId: "work-A", refreshToken: 0 })), "");
});

test("post-merge activity strings exist in both languages", () => {
  for (const lang of ["ja", "en"]) {
    const { activity } = JSON.parse(readFileSync(join(repoRoot, `apps/web/lib/i18n/${lang}.json`), "utf8"));
    for (const key of ["workPostMergeQueued", "workPostMergeSucceeded", "alertWorkPostMergeFailed", "exitCode", "durationSeconds", "postMergeHistory", "postMergeLoadOlder", "postMergeLoadError"]) assert.ok(activity[key], `${lang} ${key}`);
  }
});

test("Work screen offers older history and shows a failure found on the second page", () => {
  const now = new Date().toISOString();
  const page1 = [{ event_id: "o1", type: "work.post_merge_command_succeeded", work_id: "work-B", payload: {}, created_at: now }];
  const page2 = [
    { event_id: "w-old", type: "system.alert", work_id: "work-A", payload: { kind: "work_post_merge_command_failed", message: "Build failed.", exit_code: 7, stderr_tail: "old-tail" }, created_at: now },
  ];
  assert.deepEqual(appendPostMergeEvents([], page1, "work-A"), []);
  // has_more with no matches yet: the button is rendered
  hookValues = [[], "cursor-1"];
  assert.match(renderToStaticMarkup(React.createElement(WorkPostMergeEvents, { workId: "work-A", refreshToken: 0 })), /activity\.postMergeLoadOlder/);
  // appended page 2 (duplicates dropped) shows exit code and output tail
  const merged = appendPostMergeEvents(appendPostMergeEvents([], page2, "work-A"), page2, "work-A");
  assert.equal(merged.length, 1);
  hookValues = [merged];
  const markup = renderToStaticMarkup(React.createElement(WorkPostMergeEvents, { workId: "work-A", refreshToken: 0 }));
  assert.match(markup, /activity\.exitCode: 7/);
  assert.match(markup, /old-tail/);
  assert.doesNotMatch(markup, /postMergeLoadOlder/);
});
