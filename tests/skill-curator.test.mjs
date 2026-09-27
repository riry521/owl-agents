import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAgentRunner, createStubAgentRunner } from "../packages/agent-runtime/dist/index.js";
import { CURATOR_OUTPUT_SCHEMA, parseCuratorOutput } from "../packages/agent-runtime/dist/curator.js";
import { createCliProvider } from "../packages/agent-runtime/dist/provider.js";
import { providerSchema, validateRoleOutput } from "../packages/agent-runtime/dist/role-contract.js";
import { buildAgentPermissionArgs, RULE_ROLES } from "../packages/shared/dist/index.js";
import { openDatabase } from "../packages/db/dist/index.js";
import { SkillBox } from "../packages/core/dist/skill-box.js";
import { normalizeJudgement, prefilterProposal, routeJudgement, selectSkillCandidates, SkillCurator, SKILL_CURATOR_DEBOUNCE_MS } from "../packages/core/dist/skill-curator.js";
import { parseSkillMd, renderSkillMd } from "../packages/core/dist/skill-files.js";
import { createExternalAgentRunner } from "../apps/server/dist/agent-runner.js";

const migrations = join(process.cwd(), "packages/db/migrations");

const result = {
  proposal_id: "proposal-1",
  decision: "create",
  judgement: { reusable: 2, work_specific: 0.1, relation: "different", confidence: 0.9 },
  skill: {
    name: "release-procedure",
    description: "Repeatable release steps.",
    tags: ["release"],
    files: [{ path: "SKILL.md", content: "# Release\n\nCheck the version and publish." }],
  },
  archive: [],
  reason: "The steps are reusable.",
};

test("Curator output has one strict shared schema and rejects missing or extra fields", () => {
  const schema = providerSchema(CURATOR_OUTPUT_SCHEMA);
  assert.deepEqual(schema.required, ["results"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.results.items.required, ["proposal_id", "decision", "judgement", "skill", "archive", "reason"]);
  assert.equal(schema.properties.results.items.additionalProperties, false);
  assert.equal(validateRoleOutput(CURATOR_OUTPUT_SCHEMA, { results: [result] }), null);
  assert.match(parseCuratorOutput({ results: [{ ...result, extra: true }] }).error, /not_allowed/u);
  assert.match(parseCuratorOutput({ results: [{ ...result, reason: undefined }] }).error, /reason:expected_string/u);
});

test("Curator runs use the strict provider schema and a temporary working directory", async () => {
  const calls = [];
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    cwd: "/worktree/should-not-be-used",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        calls.push(request);
        assert.deepEqual(request.structured_output_schema.required, ["results"]);
        return { adapter: request.adapter, stdout: JSON.stringify({ results: [result] }), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  const response = await runner.runCurator({ proposals: [], candidates: [], usages: [], with_judgement: true });
  assert.deepEqual(response, { ok: true, results: [result] });
  assert.notEqual(calls[0].cwd, "/worktree/should-not-be-used");
  assert.equal(calls[0].role, "curator");
  assert.equal(calls[0].signal, undefined, "Curator bypasses agent run cancellation management");
});

test("Claude and Codex receive the Curator schema through their structured output flags", async (t) => {
  for (const adapter of ["claude-cli/v1", "codex"]) {
    const root = await mkdtemp(join(tmpdir(), `owl-curator-schema-${adapter.replaceAll("/", "-")}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = join(root, "fake-harness");
    const capture = join(root, "capture.json");
    const output = JSON.stringify({ results: [result] });
    const script = [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `const capture = ${JSON.stringify(capture)};`,
      `const output = ${JSON.stringify(output)};`,
      'const args = process.argv.slice(2);',
      'const flag = args.includes("--json-schema") ? "--json-schema" : args.includes("--output-schema") ? "--output-schema" : null;',
      'const value = flag ? args[args.indexOf(flag) + 1] : null;',
      'const schema = flag === "--json-schema" ? JSON.parse(value) : flag === "--output-schema" ? JSON.parse(fs.readFileSync(value, "utf8")) : null;',
      'fs.writeFileSync(capture, JSON.stringify({ flag, schema, cwd: process.cwd() }));',
      'process.stdin.resume();',
      'process.stdin.on("end", () => {',
      'const response = args[0] === "exec" ? JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: output } }) + "\\n" : JSON.stringify({ type: "result", result: output });',
      'process.stdout.write(response);',
      '});',
      "",
    ].join("\n");
    await writeFile(executable, script, "utf8");
    await chmod(executable, 0o755);
    const provider = createCliProvider({
      adapter,
      executablePath: executable,
      model: "test-model",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const curatorResult = await createAgentRunner({
      adapter,
      provider,
      model: "test-model",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      outputLogDir: null,
    }).runCurator({ proposals: [], candidates: [], usages: [], with_judgement: true });
    assert.equal(curatorResult.ok, true, `${adapter}: ${curatorResult.error ?? ""}`);
    const captured = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(captured.flag, adapter.startsWith("codex") ? "--output-schema" : "--json-schema");
    assert.deepEqual(captured.schema.required, ["results"]);
    assert.deepEqual(captured.schema.properties.results.items.required, ["proposal_id", "decision", "judgement", "skill", "archive", "reason"]);
    assert.equal(captured.schema.properties.results.items.properties.skill.required.includes("name"), true);
    assert.equal(captured.cwd.includes("owl-curator-"), true);
  }
});

test("the stub runner has no Curator, so proposals stay pending without spending attempts", async (t) => {
  const runner = createStubAgentRunner();
  assert.equal(runner.runCurator, undefined);
  const { root, db } = await curatorDatabase(t);
  await addPendingProposal(db, "proposal-stub", validProposal);
  const warnings = [];
  const curator = new SkillCurator({
    db,
    skillBox: new SkillBox({ db, owlRoot: root }),
    agentRunner: runner,
    logger: { warn: (message) => warnings.push(message), error() {} },
  });
  await curator.tick();
  await curator.tick();
  const row = db.get("SELECT status, attempts FROM skill_proposals WHERE id = ?", "proposal-stub");
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(warnings.filter((line) => /Curator is unavailable/u.test(line)).length, 2);
});

test("the server's external agent runner exposes the Curator", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-external-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = await createExternalAgentRunner(root, false);
  assert.equal(typeof runner.runCurator, "function");
  const stub = await createExternalAgentRunner(root, true);
  assert.equal(stub.runCurator, undefined);
});

test("curator is a shared rule and permission role", () => {
  assert.ok(RULE_ROLES.includes("curator"));
  assert.doesNotThrow(() => buildAgentPermissionArgs("curator", "claude", { owlRoot: process.cwd() }));
});

test("proposal prefilter rejects empty fields and procedures shorter than forty characters", () => {
  assert.equal(prefilterProposal({ summary: "", steps_or_diff: "A".repeat(50), evidence: "Evidence" }), "proposal_fields_empty");
  assert.equal(prefilterProposal({ summary: "Summary", steps_or_diff: "A".repeat(39), evidence: "Evidence" }), "procedure_too_short");
  assert.equal(prefilterProposal({ summary: "Summary", steps_or_diff: "A".repeat(40), evidence: "Evidence" }), null);
});

test("judgement normalization and one routing function handle modes, thresholds, and relations", () => {
  const judgement = normalizeJudgement({ reusable: 1, work_specific: 0.49, relation: "different", confidence: 0.5 });
  assert.ok(judgement);
  assert.deepEqual(routeJudgement(judgement, "autonomous", 0.5, "new"), { route: "write", operation: "create" });
  assert.deepEqual(routeJudgement(judgement, "conservative", 0.5, "new"), { route: "awaiting_approval", operation: "create" });
  assert.deepEqual(routeJudgement({ ...judgement, relation: "same" }, "autonomous", 0.5, "new"), { route: "write", operation: "update" });
  assert.deepEqual(routeJudgement({ ...judgement, relation: "extends" }, "autonomous", 0.5, "new"), { route: "write", operation: "update" });
  assert.equal(routeJudgement({ ...judgement, work_specific: 0.5 }, "autonomous", 0.5, "new").route, "rejected");
  assert.equal(routeJudgement({ ...judgement, confidence: 0.49 }, "autonomous", 0.5, "new").route, "rejected");
  assert.equal(normalizeJudgement({ reusable: 3, work_specific: 0, relation: "different", confidence: 1 }), null);
});

test("candidate selection returns at most three matching skills across scopes and states", () => {
  const skills = [
    { name: "release-procedure", description: "publish releases", tags: ["release"], scope: "global", state: "active" },
    { name: "release-checklist", description: "verify release artifacts", tags: ["release"], scope: "project:other", state: "archived" },
    { name: "release-rollback", description: "roll back a release", tags: ["release"], scope: "project:third", state: "active" },
    { name: "database-migration", description: "migrate schemas", tags: ["database"], scope: "project:other", state: "active" },
  ];
  const selected = selectSkillCandidates({ summary: "Release checklist", steps_or_diff: "Publish a release and verify its artifacts.", evidence: "The release procedure repeated." }, skills);
  assert.deepEqual(selected.map((skill) => skill.name), ["release-checklist", "release-procedure", "release-rollback"]);
});

async function curatorDatabase(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-curator-core-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db };
}

async function addPendingProposal(db, id, payload) {
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO skill_proposals (id, kind, target_skill, payload_json, project_id, status, attempts, created_at, updated_at)
     VALUES (?, 'new', NULL, ?, NULL, 'pending', 0, ?, ?)`,
    id,
    JSON.stringify(payload),
    now,
    now,
  ));
}

async function addScopedProposal(db, id, payload, projectId) {
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO skill_proposals (id, kind, target_skill, payload_json, project_id, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    id,
    payload.kind,
    payload.target,
    JSON.stringify(payload),
    projectId,
    now,
    now,
  ));
}

const reusableJudgement = { reusable: 1.5, work_specific: 0.1, relation: "different", confidence: 0.8 };
const validProposal = { kind: "new", target: null, summary: "Capture release steps", steps_or_diff: "Review the source, run the required checks, and record the result for the next release.", evidence: "The same release procedure was used in more than one task." };
const rejectedResult = (id, judgement = reusableJudgement) => ({ proposal_id: id, decision: "reject", judgement, skill: null, archive: [], reason: "No safe reusable procedure was identified." });

test("the writing request carries a compact full index and only three mapped candidate files", async (t) => {
  const { root, db } = await curatorDatabase(t);
  const skillBox = new SkillBox({ db, owlRoot: root });
  for (const name of ["release-checklist", "release-guidelines", "release-workflow", "release-reference"]) {
    const scope = "global";
    await skillBox.applyRevision({
      name,
      files: { "SKILL.md": renderSkillMd({ name, description: "Reusable release procedure.", tags: ["release"], scope }, `# ${name}\n\nReview and verify the release.`) },
      meta: { description: "Reusable release procedure.", tags: ["release"], scope },
      actor: "user",
      action: "create",
      reason: "seed",
      trial: false,
    });
  }
  const otherName = "database-migration";
  await skillBox.applyRevision({
    name: otherName,
    files: { "SKILL.md": renderSkillMd({ name: otherName, description: "Database migrations.", tags: ["database"], scope: "global" }, "# Database migration\n\nUpdate a schema.") },
    meta: { description: "Database migrations.", tags: ["database"], scope: "global" },
    actor: "user",
    action: "create",
    reason: "seed",
    trial: false,
  });
  await addPendingProposal(db, "proposal-candidate-map", validProposal);
  let request;
  const curator = new SkillCurator({
    db,
    skillBox,
    agentRunner: { runCurator: async (input) => { request = input; return { ok: false, error: "offline" }; } },
  });
  await curator.processPending();
  assert.equal(request.skill_index.length, 5);
  assert.ok(request.skill_index.some((skill) => skill.name === otherName));
  assert.equal(request.candidates.length, 3);
  assert.deepEqual(request.proposals[0].candidate_skill_names, request.candidates.map((skill) => skill.name));
  assert.ok(request.proposals[0].candidate_skill_names.every((name) => name.startsWith("release-")));
});

test("a TypeSafe judgement that rejects the proposal does not call the LLM", async (t) => {
  const { root, db } = await curatorDatabase(t);
  await addPendingProposal(db, "proposal-typesafe-reject", validProposal);
  let llmCalls = 0;
  const skillBox = new SkillBox({ db, owlRoot: root });
  const curator = new SkillCurator({
    db,
    skillBox,
    getTypesafeApiKey: () => "test-key",
    typeSafeJudge: async () => ({ reusable: 0, work_specific: 0.1, relation: "different", confidence: 0.9 }),
    agentRunner: { runCurator: async () => { llmCalls += 1; return { ok: true, results: [] }; } },
  });
  await curator.processPending();
  assert.equal(llmCalls, 0);
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = ?", "proposal-typesafe-reject").status, "rejected");
  const rejected = skillBox.listProposals("rejected").find((proposal) => proposal.id === "proposal-typesafe-reject");
  assert.equal(rejected.judgement.reason, "The procedure is not reusable across multiple Works.");
  assert.equal(rejected.judgement.confidence, 0.9);
});

test("a failed TypeSafe request falls back to the LLM judgement in the same writing call", async (t) => {
  const { root, db } = await curatorDatabase(t);
  await addPendingProposal(db, "proposal-typesafe-fallback", validProposal);
  const requests = [];
  const skillBox = new SkillBox({ db, owlRoot: root });
  const curator = new SkillCurator({
    db,
    skillBox,
    getTypesafeApiKey: () => "test-key",
    typeSafeJudge: async () => { throw new Error("offline"); },
    agentRunner: { runCurator: async (request) => { requests.push(request); return { ok: true, results: [rejectedResult("proposal-typesafe-fallback", { reusable: 0, work_specific: 0.1, relation: "different", confidence: 0.8 })] }; } },
  });
  await curator.processPending();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].with_judgement, true);
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = ?", "proposal-typesafe-fallback").status, "rejected");
});

test("without a TypeSafe key, the writing call includes the LLM judgement", async (t) => {
  const { root, db } = await curatorDatabase(t);
  await addPendingProposal(db, "proposal-no-typesafe", validProposal);
  const requests = [];
  const skillBox = new SkillBox({ db, owlRoot: root });
  const curator = new SkillCurator({
    db,
    skillBox,
    agentRunner: { runCurator: async (request) => { requests.push(request); return { ok: true, results: [rejectedResult("proposal-no-typesafe", { reusable: 0, work_specific: 0.1, relation: "different", confidence: 0.8 })] }; } },
  });
  await curator.processPending();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].with_judgement, true);
});

test("the proposal debounce defaults to five seconds", () => {
  assert.equal(SKILL_CURATOR_DEBOUNCE_MS, 5000);
});

function curatedResult(id, name, files = [{ path: "SKILL.md", content: "# Release procedure\n\nCheck the version and publish the release." }], extra = {}) {
  return {
    proposal_id: id,
    decision: "create",
    judgement: reusableJudgement,
    skill: { name, description: "Repeatable release steps.", tags: ["release"], files },
    archive: [],
    reason: "The sequence can be reused.",
    ...extra,
  };
}

test("a bad file path affects only its proposal in a five proposal batch", async (t) => {
  const { root, db } = await curatorDatabase(t);
  const ids = Array.from({ length: 5 }, (_, index) => `batch-${index + 1}`);
  for (const id of ids) await addPendingProposal(db, id, { ...validProposal, summary: `Release procedure ${id}` });
  const skillBox = new SkillBox({ db, owlRoot: root });
  const curator = new SkillCurator({
    db,
    skillBox,
    agentRunner: { runCurator: async () => ({
      ok: true,
      results: ids.map((id, index) => curatedResult(id, `release-process-${index + 1}`, index === 0
        ? [{ path: "../outside.md", content: "unsafe" }]
        : undefined)),
    }) },
  });
  await curator.processPending();
  assert.equal(db.get("SELECT COUNT(*) AS count FROM skills").count, 4);
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = ?", ids[0]).status, "pending");
  assert.equal(db.get("SELECT attempts FROM skill_proposals WHERE id = ?", ids[0]).attempts, 1);
  assert.deepEqual(db.all("SELECT status FROM skill_proposals WHERE id <> ? ORDER BY id", ids[0]).map((row) => row.status), ["applied", "applied", "applied", "applied"]);
});

test("Core regenerates frontmatter and chooses new skill scope from its source project", async (t) => {
  const { root, db } = await curatorDatabase(t);
  await addScopedProposal(db, "proposal-project-scope", validProposal, "project-42");
  await addScopedProposal(db, "proposal-global-scope", validProposal, null);
  const suppliedFrontmatter = "---\nname: forged-name\ndescription: Forged description.\nscope: global\ntags: [forged]\n---\n\n# Release procedure\n\nCheck the version and publish the release.";
  const skillBox = new SkillBox({ db, owlRoot: root });
  const curator = new SkillCurator({
    db,
    skillBox,
    agentRunner: { runCurator: async () => ({ ok: true, results: [
      curatedResult("proposal-project-scope", "safe-release", [{ path: "SKILL.md", content: suppliedFrontmatter }]),
      curatedResult("proposal-global-scope", "global-release"),
    ] }) },
  });
  await curator.processPending();
  const projectMd = await skillBox.readFile("safe-release", "SKILL.md");
  const projectParsed = parseSkillMd(projectMd);
  assert.equal(projectParsed.name, "safe-release");
  assert.equal(projectParsed.description, "Repeatable release steps.");
  assert.deepEqual(projectParsed.tags, ["release"]);
  assert.equal(projectParsed.scope, "project:project-42");
  assert.doesNotMatch(projectParsed.body, /name: forged-name/u);
  assert.equal(parseSkillMd(await skillBox.readFile("global-release", "SKILL.md")).scope, "global");
});

test("scripts wait for approval and approval applies the saved writing without another LLM call", async (t) => {
  const { root, db } = await curatorDatabase(t);
  await addPendingProposal(db, "proposal-script", validProposal);
  let llmCalls = 0;
  const skillBox = new SkillBox({ db, owlRoot: root });
  const curator = new SkillCurator({
    db,
    skillBox,
    agentRunner: { runCurator: async () => {
      llmCalls += 1;
      return { ok: true, results: [curatedResult("proposal-script", "release-helper", [
        { path: "SKILL.md", content: "# Release helper\n\nCheck the version and publish the release." },
        { path: "scripts/release.sh", content: "#!/bin/sh\nprintf release\n" },
      ])] };
    } },
  });
  await curator.processPending();
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = ?", "proposal-script").status, "awaiting_approval");
  assert.equal(db.get("SELECT name FROM skills WHERE name = ?", "release-helper"), undefined);
  const waiting = skillBox.listProposals("awaiting_approval").find((proposal) => proposal.id === "proposal-script");
  assert.equal(typeof waiting.judgement.reusability, "number");
  assert.equal(typeof waiting.judgement.confidence, "number");
  await curator.approveProposal("proposal-script");
  assert.equal(llmCalls, 1);
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = ?", "proposal-script").status, "applied");
  assert.equal(await skillBox.readFile("release-helper", "scripts/release.sh"), "#!/bin/sh\nprintf release\n");
});

test("a conservative TypeSafe approval proceeds to writing only after approval", async (t) => {
  const { root, db } = await curatorDatabase(t);
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('skills', 'owner:default', '1.0.0', ?, ?)", JSON.stringify({ mode: "conservative", confidence_threshold: 0.5 }), now);
  });
  await addPendingProposal(db, "proposal-conservative", validProposal);
  let llmCalls = 0;
  const skillBox = new SkillBox({ db, owlRoot: root });
  const curator = new SkillCurator({
    db,
    skillBox,
    getTypesafeApiKey: () => "test-key",
    typeSafeJudge: async () => reusableJudgement,
    agentRunner: { runCurator: async () => {
      llmCalls += 1;
      return { ok: true, results: [curatedResult("proposal-conservative", "conservative-release")] };
    } },
  });
  await curator.processPending();
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = ?", "proposal-conservative").status, "awaiting_approval");
  assert.equal(llmCalls, 0);
  await curator.approveProposal("proposal-conservative");
  assert.equal(llmCalls, 1);
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = ?", "proposal-conservative").status, "applied");
});

test("merge writes the integration to its target and archives each named skill", async (t) => {
  const { root, db } = await curatorDatabase(t);
  await addPendingProposal(db, "proposal-merge", { ...validProposal, summary: "Release procedure merge" });
  const skillBox = new SkillBox({ db, owlRoot: root });
  for (const name of ["release-procedure", "release-obsolete"]) {
    const scope = "global";
    await skillBox.applyRevision({
      name,
      files: { "SKILL.md": renderSkillMd({ name, description: "Release steps.", tags: ["release"], scope }, `# ${name}\n\nUse the verified release sequence.`) },
      meta: { description: "Release steps.", tags: ["release"], scope },
      actor: "user",
      action: "create",
      reason: "seed",
      trial: false,
    });
  }
  const curator = new SkillCurator({
    db,
    skillBox,
    agentRunner: { runCurator: async () => ({ ok: true, results: [{
      proposal_id: "proposal-merge",
      decision: "merge",
      judgement: { ...reusableJudgement, relation: "extends" },
      skill: { name: "release-procedure", description: "Release steps.", tags: ["release"], files: [{ path: "SKILL.md", content: "# Integrated release procedure\n\nRun the checks and publish the verified version." }] },
      archive: ["release-obsolete"],
      reason: "The older procedure is now covered by the integrated skill.",
    }] }) },
  });
  await curator.processPending();
  assert.equal(skillBox.listRevisions("release-procedure")[0].action, "merge");
  assert.equal(skillBox.getSkill("release-obsolete").state, "archived");
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = ?", "proposal-merge").status, "applied");
});

async function seedSkill(skillBox, name, body = `# ${name}\n\nUse the verified release sequence.`) {
  return skillBox.applyRevision({
    name,
    files: { "SKILL.md": renderSkillMd({ name, description: "Release steps.", tags: ["release"], scope: "global" }, body) },
    meta: { description: "Release steps.", tags: ["release"], scope: "global" },
    actor: "user",
    action: "create",
    reason: "seed",
    trial: false,
  });
}

async function useConservativeMode(db) {
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('skills', 'owner:default', '1.0.0', ?, ?)", JSON.stringify({ mode: "conservative", confidence_threshold: 0.5 }), now);
  });
}

test("a create never overwrites an existing skill with the same name", async (t) => {
  const { root, db } = await curatorDatabase(t);
  const skillBox = new SkillBox({ db, owlRoot: root });
  await seedSkill(skillBox, "unrelated-skill");
  const before = await skillBox.readFile("unrelated-skill", "SKILL.md");
  await addPendingProposal(db, "proposal-name-taken", validProposal);
  const curator = new SkillCurator({
    db,
    skillBox,
    agentRunner: { runCurator: async () => ({ ok: true, results: [curatedResult("proposal-name-taken", "unrelated-skill")] }) },
  });
  await curator.processPending();
  const row = db.get("SELECT status, attempts, last_error FROM skill_proposals WHERE id = ?", "proposal-name-taken");
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /skill_name_taken/u);
  assert.equal(await skillBox.readFile("unrelated-skill", "SKILL.md"), before);
  assert.equal(skillBox.listRevisions("unrelated-skill").length, 1);
});

test("a failed approval write keeps the approval, counts the attempt, and surfaces the error", async (t) => {
  const { root, db } = await curatorDatabase(t);
  await useConservativeMode(db);
  await addPendingProposal(db, "proposal-approval-fails", validProposal);
  const skillBox = new SkillBox({ db, owlRoot: root });
  const curator = new SkillCurator({
    db,
    skillBox,
    getTypesafeApiKey: () => "test-key",
    typeSafeJudge: async () => reusableJudgement,
    agentRunner: { runCurator: async () => ({ ok: false, error: "provider_failed" }) },
  });
  await curator.processPending();
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = ?", "proposal-approval-fails").status, "awaiting_approval");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.rejects(() => curator.approveProposal("proposal-approval-fails"), /provider_failed/u);
    const row = db.get("SELECT status, attempts, last_error FROM skill_proposals WHERE id = ?", "proposal-approval-fails");
    assert.equal(row.attempts, attempt);
    assert.equal(row.last_error, "provider_failed");
    assert.equal(row.status, attempt < 3 ? "awaiting_approval" : "rejected");
  }
});

test("approving a saved write fails when its target skill changed after the proposal", async (t) => {
  const { root, db } = await curatorDatabase(t);
  const skillBox = new SkillBox({ db, owlRoot: root });
  await seedSkill(skillBox, "release-procedure");
  await addPendingProposal(db, "proposal-stale", { ...validProposal, kind: "update", target: "release-procedure" });
  const curator = new SkillCurator({
    db,
    skillBox,
    agentRunner: { runCurator: async () => ({ ok: true, results: [curatedResult("proposal-stale", "release-procedure", [
      { path: "SKILL.md", content: "# Release procedure\n\nRun the helper and publish the release." },
      { path: "scripts/release.sh", content: "#!/bin/sh\nprintf release\n" },
    ], { decision: "update", judgement: { ...reusableJudgement, relation: "extends" } })] }) },
  });
  await curator.processPending();
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = ?", "proposal-stale").status, "awaiting_approval");
  await skillBox.applyRevision({
    name: "release-procedure",
    files: { "SKILL.md": renderSkillMd({ name: "release-procedure", description: "Release steps.", tags: ["release"], scope: "global" }, "# Edited by hand\n\nA newer procedure.") },
    meta: { description: "Release steps.", tags: ["release"], scope: "global" },
    actor: "user",
    action: "update",
    reason: "manual edit",
    trial: false,
  });
  const edited = await skillBox.readFile("release-procedure", "SKILL.md");
  await assert.rejects(() => curator.approveProposal("proposal-stale"), /skill_changed_since_proposal/u);
  assert.equal(await skillBox.readFile("release-procedure", "SKILL.md"), edited);
  const row = db.get("SELECT status, last_error FROM skill_proposals WHERE id = ?", "proposal-stale");
  assert.equal(row.status, "awaiting_approval");
  assert.match(row.last_error, /skill_changed_since_proposal/u);
});

test("stopping the Curator does not wait for an in-flight provider call and starts no further runs", async (t) => {
  const { root, db } = await curatorDatabase(t);
  await addPendingProposal(db, "proposal-stop", validProposal);
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const curator = new SkillCurator({
    db,
    skillBox: new SkillBox({ db, owlRoot: root }),
    agentRunner: { runCurator: () => { calls += 1; started(); return new Promise(() => {}); } },
  });
  const run = curator.processPending();
  await startedPromise;
  curator.stop();
  await run;
  await curator.processPending();
  assert.equal(calls, 1);
  assert.equal(db.get("SELECT status FROM skill_proposals WHERE id = ?", "proposal-stop").status, "pending");
});
