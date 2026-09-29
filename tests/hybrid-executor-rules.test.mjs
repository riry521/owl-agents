import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return { request_id: createUlid(), idempotency_key: `test:${suffix}`, expected_version: expectedVersion, payload };
}

async function waitFor(read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("the Hybrid Executor receives the Task, the Worker's rules and the Owner guidance", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-hybrid-rules-"));
  await mkdir(join(root, "rules", "system"), { recursive: true });
  await writeFile(join(root, "rules/system/markers.yaml"), [
    "level: system",
    "rules:",
    "  - id: worker_marker",
    "    kind: instruction",
    '    text: "worker-rule-marker"',
    "",
  ].join("\n"));
  const bin = join(root, "bin");
  const prompts = join(root, "prompts");
  await mkdir(bin, { recursive: true });
  await mkdir(prompts, { recursive: true });
  await writeFile(join(bin, "claude"), [
    "#!/bin/sh",
    `cat > "${prompts}/$OWL_AGENT_RUN_ID.txt"`,
    `echo '{"type":"system","subtype":"init"}'`,
    `echo '{"type":"result","result":"subtask done"}'`,
    "",
  ].join("\n"));
  await chmod(join(bin, "claude"), 0o755);

  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  let core;
  t.after(async () => {
    process.env.PATH = originalPath;
    if (core) await core.stop({ force: true });
    db.close();
  });

  const workerRules = [];
  const agentRunner = {
    runManagerPlan: async (request) => request.context?.mode === "plan"
      ? { outcome: "success", report_valid: true, report: {
        event: "work.planned",
        work_rules: ["work-rule-marker"],
        tasks: [{ id: "T1", title: "Hybrid rules", type: "code", acceptance: "acceptance-marker", context: "context-marker", depends_on: [], replaces: [] }],
      } }
      : { outcome: "failed", message: "unexpected" },
    runWorker: async (request) => {
      workerRules.push(request.context.rules);
      if (request.context.hybrid_phase === "plan") {
        return { outcome: "success", report_valid: true, report: { subtasks: [{ subtask_id: "s1", title: "Do it", instruction: "Do the subtask" }] } };
      }
      return {
        outcome: "success",
        report_valid: true,
        report: {
          kind: "report", schema_version: "1.0.0", invocation_id: request.invocation_id, result: "success",
          work_done: "Done.", changes: [], verification: { passed: true, method: "Checked." }, remaining_issues: [], next_action: "none",
          needs_replanning: false, question_for_manager: null, verdict: "ok",
        },
      };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  await core.start();
  await core.setHybridMode(true);
  const created = await core.createWork(commandEnvelope({ title: "Hybrid rules", summary: "x", size: "normal", project_id: null }, "hr-create"));
  await core.startWork(created.data.work_id, commandEnvelope({ mode: "normal" }, "hr-start", created.version));

  const files = await waitFor(async () => {
    const names = await readdir(prompts);
    return names.length > 0 ? names : null;
  });
  assert.ok(files, "the Executor ran");
  await waitFor(() => workerRules.length >= 2);
  const childOutput = await waitFor(() => db.get("SELECT last_output_at FROM agent_runs WHERE origin = 'spawned'")?.last_output_at ?? null);
  assert.ok(childOutput);
  const prompt = await readFile(join(prompts, files[0]), "utf8");

  assert.match(prompt, /^Complete this subtask:\nDo the subtask\n/);
  assert.match(prompt, /\n## Task\nTitle: Hybrid rules\nAcceptance criteria:\nacceptance-marker\nContext:\ncontext-marker\n/);
  assert.match(prompt, /\n## Rules\nThese rules come from the operator's Rule Store and the Work\. They always win over the guidance below\.\n\[system\] worker-rule-marker\n\[work\] work-rule-marker\n/);
  assert.match(prompt, /\n## Owner guidance\n.*\nNone\.\n/);
  assert.ok(prompt.indexOf("## Rules") < prompt.indexOf("Write the least code that is correct."));
  for (const rules of workerRules) assert.equal(rules, "[system] worker-rule-marker\n[work] work-rule-marker", "plan and verdict see the Executor's rules");
});
