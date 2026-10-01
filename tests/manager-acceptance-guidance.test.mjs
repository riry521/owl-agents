import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentRunner } from "../packages/agent-runtime/dist/index.js";

const TEMPLATE_HEADING = "## Output template\n";

function renderedTemplate(prompt) {
  const start = prompt.indexOf(TEMPLATE_HEADING);
  assert.notEqual(start, -1, "prompt has an Output template section");
  const body = prompt.slice(start + TEMPLATE_HEADING.length);
  const jsonStart = body.indexOf("\n{") + 1;
  const jsonEnd = body.indexOf("\n}\n") + 2;
  return JSON.parse(body.slice(jsonStart, jsonEnd));
}

function fillTemplate(value) {
  if (typeof value === "string") return /^<.+>$/.test(value) ? `filled ${value.slice(1, -1)}` : value;
  if (Array.isArray(value)) return value.map(fillTemplate);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fillTemplate(entry)]));
  }
  return value;
}

async function managerPrompt(mode) {
  const calls = [];
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        calls.push(request);
        return {
          adapter: request.adapter,
          stdout: JSON.stringify(fillTemplate(renderedTemplate(request.prompt))),
          stderr: "",
          exit_code: 0,
          signal: null,
          format: "plain-text",
        };
      },
    },
  });
  await runner.runManagerPlan({
    invocation_id: `manager-${mode}`,
    work_id: "work-1",
    task_id: null,
    attempt: 1,
    context: { mode, work: { id: "work-1", title: "Archive Works" } },
  });
  return calls[0].prompt;
}

for (const mode of ["plan", "replan"]) {
  test(`Manager ${mode} prompt keeps report-format requirements out of acceptance criteria`, async () => {
    const prompt = await managerPrompt(mode);
    assert.match(prompt, /Do not put report-format requirements in acceptance criteria/);
    assert.match(prompt, /verification that can be run and checked \(tests, commands, file state\)/);
    assert.match(prompt, /never as report-format requirements/);
  });
}
