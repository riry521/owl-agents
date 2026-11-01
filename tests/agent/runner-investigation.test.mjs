import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { serverRunnerModuleWithout } from "../helpers/server-runner.mjs";
import { tempDir } from "../helpers/temp.mjs";

import { createExternalAgentRunner } from "../../apps/server/dist/agent-runner.js";

const ENV_KEYS = [
  "PATH",
  "HOME",
  "OWL_PROVIDER",
  "OWL_PROVIDER_ID",
  "OWL_PROVIDER_ADAPTER",
  "OWL_PROVIDER_EXECUTABLE",
  "OWL_CLAUDE_EXECUTABLE",
  "OWL_CODEX_EXECUTABLE",
];

async function withEnvironment(values, run) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("project investigation returns ok:false when delegate initialization throws", async (t) => {
  const root = await tempDir(t, "owl-agent-runner-init-");
  await withEnvironment({ OWL_PROVIDER: "real" }, async () => {
    const runner = await createExternalAgentRunner(root, false);
    const result = await runner.runProjectInvestigation({});
    assert.equal(result.ok, false);
    assert.match(result.error, /^provider_failed:/u);
    assert.match(result.error, /PATH/u);
  });
});

test("project investigation returns ok:false when the delegate throws", async (t) => {
  const root = await tempDir(t, "owl-agent-runner-delegate-");
  const executable = path.join(root, "fake-claude");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);
  await withEnvironment({
    HOME: root,
    PATH: "/usr/bin:/bin",
    OWL_PROVIDER: "real",
    OWL_PROVIDER_ADAPTER: "claude-cli/v1",
    OWL_PROVIDER_EXECUTABLE: executable,
  }, async () => {
    const runner = await createExternalAgentRunner(root, false);
    const request = new Proxy({}, {
      get(_target, key) {
        if (key === "invocation_id") throw new Error("delegate boom");
        return undefined;
      },
    });
    const result = await runner.runProjectInvestigation(request);
    assert.deepEqual([result.ok, result.error], [false, "provider_failed:delegate boom"]);
  });
});

test("observer registration logs the error when delegate initialization fails", async (t) => {
  const root = await tempDir(t, "owl-agent-runner-observer-");
  await withEnvironment({ OWL_PROVIDER: "real" }, async () => {
    const runner = await createExternalAgentRunner(root, false);
    const logged = [];
    const original = console.error;
    console.error = (...args) => { logged.push(args); };
    try {
      runner.setProcessObserver(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      console.error = original;
    }
    assert.ok(logged.some((args) => /setProcessObserver/u.test(String(args[0])) && args[1] instanceof Error && /PATH/u.test(args[1].message)));
  });
});

test("decision explanation passes through the wrapped runner and reports unavailable when the delegate lacks it", async (t) => {
  const root = await tempDir(t, "owl-agent-runner-explanation-");
  const executable = path.join(root, "fake-claude");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);
  const environment = {
    HOME: root,
    PATH: "/usr/bin:/bin",
    OWL_PROVIDER: "real",
    OWL_PROVIDER_ADAPTER: "claude-cli/v1",
    OWL_PROVIDER_EXECUTABLE: executable,
  };
  await withEnvironment(environment, async () => {
    const runner = await createExternalAgentRunner(root, false);
    assert.equal(typeof runner.runDecisionExplanation, "function");
    // The fake provider prints nothing, so the real delegate answers with its own failure, not the wrapper's.
    const passed = await runner.runDecisionExplanation({
      kind: "partial_limit", language: "en", task: { title: "t", acceptance_criteria: [] }, reports: [], verification: null, rules: null, forbidden_terms: [], timeout_ms: 5000,
    });
    assert.equal(passed.ok, false);
    assert.notEqual(passed.error, "decision_explanation_unavailable");
  });
  const oldModule = await serverRunnerModuleWithout(t, ["runDecisionExplanation"]);
  await withEnvironment(environment, async () => {
    const runner = await oldModule.createExternalAgentRunner(root, false);
    assert.deepEqual(await runner.runDecisionExplanation({}), { ok: false, error: "decision_explanation_unavailable" });
  });
});

test("decision answer triage is available for a real runtime and unavailable when the delegate lacks the method", async (t) => {
  const root = await tempDir(t, "owl-agent-runner-triage-");
  const executable = path.join(root, "fake-claude");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);
  const environment = {
    HOME: root,
    PATH: "/usr/bin:/bin",
    OWL_PROVIDER: "real",
    OWL_PROVIDER_ADAPTER: "claude-cli/v1",
    OWL_PROVIDER_EXECUTABLE: executable,
  };
  const oldModule = await serverRunnerModuleWithout(t, ["runDecisionAnswerTriage"]);
  await withEnvironment(environment, async () => {
    const runner = await createExternalAgentRunner(root, false);
    assert.equal(typeof runner.runDecisionAnswerTriage, "function");
    assert.equal(await runner.decisionAnswerTriageAvailable(), true);
    const old = await oldModule.createExternalAgentRunner(root, false);
    assert.equal(typeof old.runDecisionAnswerTriage, "function");
    assert.equal(await old.decisionAnswerTriageAvailable(), false);
    assert.deepEqual(await old.runDecisionAnswerTriage({}), { ok: false, error: "decision_answer_triage_unavailable" });
  });
});
