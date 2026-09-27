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
