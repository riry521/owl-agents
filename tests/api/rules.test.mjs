import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { RuleStore } from "../../packages/core/dist/rule-store.js";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const RULES = {
  "system/defaults.yaml": `level: system
rules:
  - id: no_reset
    kind: block_command
    pattern: "git reset --hard"
    message: "Hard resets are forbidden."
  - id: same_text_a
    kind: instruction
    text: "Run the tests."
`,
  "role/advisor.yaml": `level: role
role: advisor
rules:
  - id: advisor_no_publish
    kind: block_command
    pattern: "npm publish"
    message: "Advisors do not publish."
  - id: same_text_b
    kind: instruction
    text: "Run the tests."
`,
};

async function startServer(t) {
  const root = await tempDir(t, "owl-api-rules-");
  for (const [relative, content] of Object.entries(RULES)) {
    const target = path.join(root, "rules", relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const ruleStore = new RuleStore(root);
  await ruleStore.load();
  const server = await startTestHttpServer(t, { core: { ready: true }, webOut: root, owlRoot: root, ruleStore }, { token: "test-api-token" });
  if (!server) return null;
  return {
    root,
    get: (route) => server.request("GET", `/api/v1${route}`),
    post: (route, body) => server.request("POST", `/api/v1${route}`, body),
  };
}

test("GET /rules reports roles, every prompt rule once and the load status", async (t) => {
  const api = await startServer(t);
  if (!api) return t.skip("localhost listen is unavailable");
  const response = await api.get("/rules");
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.status.generation, 1);
  assert.equal(data.status.error, null);
  const ids = data.prompt_rules.map((rule) => rule.id);
  assert.deepEqual([...ids].sort(), ["advisor_no_publish", "no_reset", "same_text_a", "same_text_b"]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(data.files.find((file) => file.path.endsWith("advisor.yaml")).role, "advisor");
  assert.equal(data.files.find((file) => file.path.endsWith("defaults.yaml")).role, null);
  assert.equal(data.block_rules.find((rule) => rule.id === "advisor_no_publish").role, "advisor");
  assert.equal(data.block_rules.find((rule) => rule.id === "no_reset").role, null);
});

test("POST /rules/check applies role rules only to that role and validates role and cwd", async (t) => {
  const api = await startServer(t);
  if (!api) return t.skip("localhost listen is unavailable");
  const check = async (body) => {
    const response = await api.post("/rules/check", body);
    return { status: response.status, body: await response.json() };
  };

  const advisor = await check({ command: "npm publish", role: "advisor", cwd: api.root });
  assert.equal(advisor.status, 200);
  assert.equal(advisor.body.data.blocked, true);
  assert.deepEqual(advisor.body.data.rule, { id: "advisor_no_publish", level: "role", role: "advisor", message: "Advisors do not publish." });

  const worker = await check({ command: "npm publish", role: "worker" });
  assert.equal(worker.body.data.blocked, false);

  const system = await check({ command: "git reset --hard" });
  assert.equal(system.body.data.blocked, true);
  assert.equal(system.body.data.rule.role, null);

  for (const body of [
    { command: "ls", role: "bogus" },
    { command: "ls", cwd: "relative/dir" },
    { command: "ls", cwd: 7 },
  ]) {
    const invalid = await check(body);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "validation_error");
  }
});
