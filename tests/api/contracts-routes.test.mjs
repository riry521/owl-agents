import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { repoRoot } from "../helpers/paths.mjs";

const openapi = readFileSync(join(repoRoot, "contracts/openapi/owl-api-v1.yaml"), "utf8");
const http = readFileSync(join(repoRoot, "apps/server/src/http.ts"), "utf8");

/** Return the indented YAML block that starts at `header` (exclusive of following siblings). */
function yamlBlock(text, header) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === header);
  assert.notEqual(start, -1, `missing OpenAPI block ${header.trim()}`);
  const indent = header.length - header.trimStart().length;
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length > 0 && line.length - line.trimStart().length <= indent) break;
    block.push(line);
  }
  return block.join("\n");
}

test("OpenAPI documents GET /events with after/before/limit/order and its page shape", () => {
  const events = yamlBlock(openapi, "  /api/v1/events:");
  assert.match(events, /\n    get:\n/u);
  for (const name of ["after", "before", "limit", "order"]) {
    assert.match(events, new RegExp(`\\n          name: ${name}\\n`, "u"), name);
  }
  assert.match(events, /- asc\n\s+- desc/u);
  assert.match(events, /EventListResponse/u);
  const list = yamlBlock(openapi, "    EventListResponse:");
  for (const key of ["events", "cursor", "has_more"]) assert.match(list, new RegExp(`\\n            - ${key}\\n`, "u"), key);
  const frame = yamlBlock(openapi, "    EventFrame:");
  for (const key of ["event_id", "sequence", "cursor", "type", "schema_version", "work_id", "task_id", "agent_run_id", "created_at", "payload"]) {
    assert.match(frame, new RegExp(`\\n        ${key}:\\n`, "u"), key);
  }
});

test("OpenAPI documents POST /works/{work_id}/reopen with an optional non-blank reason", () => {
  const reopen = yamlBlock(openapi, "  /api/v1/works/{work_id}/reopen:");
  assert.match(reopen, /\n    post:\n/u);
  assert.match(reopen, /ReopenWorkCommand/u);
  assert.match(reopen, /'400':[\s\S]*validation_error/u);
  const payload = yamlBlock(openapi, "    ReopenWorkPayload:");
  assert.doesNotMatch(payload, /required:/u, "reason is optional");
  assert.match(payload, /minLength: 1\n\s+maxLength: 1000/u);
  assert.match(payload, /additionalProperties: false/u);
});

test("OpenAPI archive and delete work routes match the server actions", () => {
  const works = yamlBlock(openapi, "  /api/v1/works:");
  assert.match(works, /name: archived\n\s+required: false\n\s+schema:\n\s+type: string\n\s+enum:\n\s+- exclude\n\s+- include\n\s+- only\n\s+default: exclude/u);

  const deleteWork = yamlBlock(openapi, "  /api/v1/works/{work_id}:");
  assert.match(deleteWork, /\n    delete:\n/u);
  assert.match(deleteWork, /EmptyCommand/u);
  assert.match(deleteWork, /DeleteWorkResponse/u);
  const archive = yamlBlock(openapi, "  /api/v1/works/{work_id}/archive:");
  const unarchive = yamlBlock(openapi, "  /api/v1/works/{work_id}/unarchive:");
  assert.match(archive, /ArchiveWorkResponse/u);
  assert.match(unarchive, /UnarchiveWorkResponse/u);
  assert.match(http, /workActionMatch && method === "POST"/u);
  assert.ok(http.includes("(start|pause|resume|cancel|reopen|archive|unarchive)"));
  assert.match(http, /workDeleteMatch && method === "DELETE"/u);

  for (const header of ["    WorkSummary:", "    WorkDetail:"]) {
    const schema = yamlBlock(openapi, header);
    assert.match(schema, /\n        - archived_at\n/u);
    assert.match(schema, /\n        archived_at:\n          anyOf:\n            - \$ref: '#\/components\/schemas\/RFC3339'\n            - type: 'null'\n/u);
  }
  const cleanupError = yamlBlock(openapi, "    WorktreeCleanupIssue:");
  for (const field of ["path", "ignored_count", "ignored_paths"]) {
    assert.match(cleanupError, new RegExp(`\\n        - ${field}\\n`, "u"), field);
  }
});

test("OpenAPI IntegrationSettingsResponse matches what GET /settings/integrations returns", () => {
  const data = yamlBlock(openapi, "    IntegrationSettingsData:");
  assert.match(data, /\n        - integrations\n/u);
  assert.match(data, /\$ref: '#\/components\/schemas\/IntegrationStatus'/u);
  assert.doesNotMatch(data, /enabled|phase/u);
  const response = yamlBlock(openapi, "    IntegrationSettingsResponse:");
  assert.match(response, /\n        - request_id\n/u);
  // Shape served by apps/server (http.ts: { request_id, data: { integrations } }).
  const status = yamlBlock(openapi, "    IntegrationStatus:");
  for (const key of ["provider", "configured", "conversation_channel_id", "notification_channel_id", "last_tested_at", "last_test_ok"]) {
    assert.match(status, new RegExp(`\\n        ${key}:\\n`, "u"), key);
  }
  const testRoute = yamlBlock(openapi, "  /api/v1/settings/integrations/{provider}/test:");
  assert.match(testRoute, /IntegrationTestResponse/u);
});

test("OpenAPI documents GET /works/{work_id}/branch-status and the server serves it", () => {
  const route = yamlBlock(openapi, "  /api/v1/works/{work_id}/branch-status:");
  assert.match(route, /\n    get:\n/u);
  assert.match(route, /WorkBranchStatusResponse/u);
  assert.match(route, /'404':/u);
  const response = yamlBlock(openapi, "    WorkBranchStatusResponse:");
  assert.match(response, /- present\n\s+- absent\n\s+- unknown/u);
  assert.match(response, /additionalProperties: false/u);
  assert.match(http, /\/works\/\(\[\^\/\]\+\)\/branch-status/u);
  const detail = yamlBlock(openapi, "    WorkDetail:");
  assert.doesNotMatch(detail, /has_unmerged_changes/u);
});

test("OpenAPI and server routes expose design document list and detail endpoints", () => {
  const list = yamlBlock(openapi, "  /api/v1/works/{work_id}/designs:");
  const detail = yamlBlock(openapi, "  /api/v1/works/{work_id}/designs/{task_id}:");
  assert.match(list, /operationId: listWorkDesigns/u);
  assert.match(list, /WorkDesignListResponse/u);
  assert.match(list, /'404':/u);
  assert.match(detail, /operationId: getWorkDesign/u);
  assert.match(detail, /WorkDesignResponse/u);
  assert.match(detail, /design_document_not_found/u);
  assert.match(http, /works\/\(\[\^\/\]\+\)\/designs/u);
  assert.match(http, /getWorkDesigns\(workId\)/u);
  assert.match(http, /getWorkDesign\(workId, taskId\)/u);
});

test("OpenAPI documents provider pause listing", () => {
  const list = yamlBlock(openapi, "  /api/v1/providers/pauses:");
  assert.match(list, /operationId: listProviderPauses/u);
  assert.match(list, /ProviderPauseListResponse/u);
  assert.match(http, /providers\/pauses/u);
  const view = yamlBlock(openapi, "    ProviderPauseView:");
  for (const field of ["provider", "label", "state", "paused_at", "resume_at", "resume_source", "reported_resets_at", "backoff_step", "last_error", "last_role"]) {
    assert.match(view, new RegExp(`\\n        - ${field}\\n`, "u"), field);
    assert.match(view, new RegExp(`\\n        ${field}:\\n`, "u"), field);
  }
  assert.match(view, /enum: \[paused, probing\]/u);
  assert.match(view, /enum: \[reported, backoff\]/u);
  assert.doesNotMatch(view, /waiting_tasks|deferred_reviews/u);
  assert.match(yamlBlock(openapi, "    ProviderPauseListResponse:"), /ProviderPauseView/u);
});

test("OpenAPI project edit and deletion routes match the server handlers", () => {
  const impact = yamlBlock(openapi, "  /api/v1/projects/{project_id}/deletion-impact:");
  const project = yamlBlock(openapi, "  /api/v1/projects/{project_id}:");
  assert.match(impact, /operationId: getProjectDeletionImpact/u);
  assert.match(impact, /ProjectDeletionImpactResponse/u);
  assert.match(impact, /project_not_found/u);
  assert.match(project, /operationId: updateProject/u);
  assert.match(project, /UpdateProjectCommand/u);
  assert.match(project, /project_has_running_works/u);
  const update = project.match(/\n    patch:\n([\s\S]*?)(?=\n    delete:)/u)?.[1] ?? "";
  assert.match(update, /'400':[\s\S]*validation_error/u);
  assert.doesNotMatch(update, /project_path_conflict/u);
  assert.match(project, /operationId: deleteProject/u);
  assert.match(project, /DeleteProjectCommand/u);
  assert.match(project, /project_deletion_impact_changed/u);

  const updatePayload = yamlBlock(openapi, "    UpdateProjectPayload:");
  for (const field of ["name", "canonical_path"]) {
    assert.match(updatePayload, new RegExp(`\\n        ${field}:\\n`, "u"), field);
  }
  assert.match(updatePayload, /additionalProperties: false/u);
  assert.match(yamlBlock(openapi, "    DeleteProjectPayload:"), /confirmed_work_count/u);
  const impactSchema = yamlBlock(openapi, "    ProjectDeletionImpact:");
  for (const field of ["project_id", "work_count", "running_work_count", "active_agent_count", "backlog_item_count", "running_works", "blockers", "deletable"]) {
    assert.match(impactSchema, new RegExp(`\\n        - ${field}\\n`, "u"), field);
  }
  assert.match(http, /projectImpactMatch && method === "GET"/u);
  assert.match(http, /projectMatch && method === "PATCH"/u);
  assert.match(http, /projectMatch && method === "DELETE"/u);
  assert.match(http, /getProjectDeletionImpact\(projectId\)/u);
  assert.match(http, /updateProject\(projectId,/u);
  assert.match(http, /deleteProject\(projectId,/u);
});

test("OpenAPI documents the owner provider pause resume route and nullable pause response", () => {
  const route = yamlBlock(openapi, "  /api/v1/providers/pauses/{provider}/resume:");
  assert.match(route, /operationId: resumeProviderPause/u);
  assert.match(route, /ownerBearer/u);
  assert.match(route, /name: provider/u);
  assert.doesNotMatch(route, /requestBody:/u);
  assert.match(route, /ProviderPauseResumeResponse/u);
  assert.match(route, /provider_pause_not_found/u);
  const response = yamlBlock(openapi, "    ProviderPauseResumeResponse:");
  assert.match(response, /ProviderPauseView/u);
  assert.match(response, /type: 'null'/u);
  assert.match(response, /- pause/u);
});

test("OpenAPI documents GET/PUT /settings/knowledge-storage as the server serves them", () => {
  assert.match(http, /pathname === `\$\{API_PREFIX\}\/settings\/knowledge-storage` && method === "GET"/u);
  assert.match(http, /pathname === `\$\{API_PREFIX\}\/settings\/knowledge-storage` && method === "PUT"/u);
  const route = yamlBlock(openapi, "  /api/v1/settings/knowledge-storage:");
  const getOp = yamlBlock(route, "    get:");
  const putOp = yamlBlock(route, "    put:");
  assert.match(putOp, /UpdateKnowledgeStorageCommand/u);
  const response = (op, status) => yamlBlock(op, `        '${status}':`);
  assert.match(response(getOp, "503"), /- dependency_unavailable\n/u);
  assert.doesNotMatch(getOp, /knowledge_storage_unavailable/u);
  const putCodes = { "400": ["validation_error"], "409": ["idempotency_conflict", "knowledge_storage_busy", "knowledge_storage_moving"], "422": ["validation_error", "knowledge_target_invalid"], "500": ["knowledge_move_failed"], "503": ["knowledge_storage_unavailable"] };
  for (const [status, codes] of Object.entries(putCodes)) {
    for (const code of codes) assert.match(response(putOp, status), new RegExp(`- ${code}\\n`, "u"), `${status} ${code}`);
  }
  assert.match(response(putOp, "422"), /\$ref: '#\/components\/schemas\/KnowledgeStorageUpdateValidationErrorResponse'/u);
  const invalid = yamlBlock(openapi, "    KnowledgeStorageUpdateValidationErrorResponse:");
  assert.match(invalid, /enum: \[same_as_current, nested, reserved, not_directory, not_empty, parent_missing, not_writable, relink_requires_unavailable\]/u);
  for (const name of ["KnowledgeStorageStatus", "KnowledgeStorageResponse", "UpdateKnowledgeStorageCommand", "KnowledgeStorageMoveResponse"]) {
    yamlBlock(openapi, `    ${name}:`);
  }
  const command = yamlBlock(openapi, "    UpdateKnowledgeStorageCommand:");
  assert.match(command, /required: \[path\]/u);
  assert.match(command, /mode: \{ \$ref: '#\/components\/schemas\/KnowledgeStorageMoveMode' \}/u);
  assert.match(command, /additionalProperties: false/u);
  assert.match(yamlBlock(openapi, "    KnowledgeStorageMoveMode:"), /enum: \[move, relink\]/u);
});

test("OpenAPI documents the Work and Decision screen view routes", () => {
  const workView = yamlBlock(openapi, "  /api/v1/works/{work_id}/view:");
  assert.match(workView, /WorkViewResponse/u);
  assert.match(workView, /name: conversation_limit/u);
  assert.match(yamlBlock(openapi, "  /api/v1/decisions/{decision_id}/view:"), /DecisionViewResponse/u);
  assert.match(yamlBlock(openapi, "    WorkView:"), /- decisions/u);
  assert.match(yamlBlock(openapi, "    DecisionView:"), /- blocked_tasks/u);
});

test("OpenAPI documents the Board, Backlog, Tokens and Settings screen view routes", () => {
  assert.match(yamlBlock(openapi, "  /api/v1/board/view:"), /name: cursor[\s\S]*BoardViewResponse/u);
  assert.match(yamlBlock(openapi, "  /api/v1/backlog/linkable-works:"), /name: project_id[\s\S]*LinkableWorksResponse/u);
  assert.match(yamlBlock(openapi, "  /api/v1/backlog/view:"), /BacklogViewResponse/u);
  assert.match(yamlBlock(openapi, "  /api/v1/tokens/view:"), /TokensViewResponse/u);
  assert.match(yamlBlock(openapi, "  /api/v1/settings/view:"), /SettingsViewResponse/u);
  assert.match(yamlBlock(openapi, "    BoardView:"), /- next_cursor/u);
});

test("OpenAPI TaskDetail declares prerequisite and stop_reason with the same types as TaskSummary", () => {
  const detail = yamlBlock(openapi, "    TaskDetail:");
  const summary = yamlBlock(openapi, "    TaskSummary:");
  assert.match(detail, /additionalProperties: false/u);
  for (const name of ["prerequisite", "stop_reason"]) {
    const field = (block) => block.match(new RegExp(`\\n        ${name}:\\n(?:          .*\\n?)+`, "u"))?.[0];
    assert.ok(field(detail), name);
    assert.equal(field(detail), field(summary), name);
  }
});

test("a real GET /tasks/{task_id} response fits the OpenAPI TaskDetail (required keys present, no key outside its properties)", async (t) => {
  const { root, db, core } = await createTestCore(t, {}, { prefix: "owl-api-taskdetail-", start: true });
  const server = await startTestHttpServer(t, { core: new ExternalCoreAdapter(core, db, root, join(root, "data")), webOut: root, owlRoot: root }, { token: "taskdetail-token" });
  if (!server) return t.skip("listen not permitted");
  const created = await core.createWork({ request_id: createUlid(), idempotency_key: `w:${createUlid()}`, expected_version: 0, payload: { title: "w", summary: "s", size: "normal", project_id: null } });
  const taskId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => tx.run(
    "INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at) VALUES (?, ?, 't', 'code', 'waiting', 'normal', '', 'a', ?, ?)",
    taskId, created.data.work_id, now, now,
  ));
  const data = (await (await server.request("GET", `/api/v1/tasks/${taskId}`)).json()).data;

  const detail = yamlBlock(openapi, "    TaskDetail:");
  const properties = [...yamlBlock(detail, "      properties:").matchAll(/^ {8}(\w+):/gmu)].map((m) => m[1]);
  const required = [...yamlBlock(detail, "      required:").matchAll(/^ {8}- (\w+)/gmu)].map((m) => m[1]);
  assert.ok(properties.includes("prerequisite") && properties.includes("stop_reason"));
  for (const key of required) assert.ok(key in data, `missing ${key}`);
  assert.deepEqual(Object.keys(data).filter((key) => !properties.includes(key)), [], "additionalProperties: false");

  // prerequisite and stop_reason must be present in the response and typed as the schema declares.
  assert.ok("prerequisite" in data && "stop_reason" in data);
  assert.match(yamlBlock(detail, "        prerequisite:"), /\$ref: '#\/components\/schemas\/TaskPrerequisite'\n\s+- type: 'null'/u);
  assert.ok(data.prerequisite === null || (typeof data.prerequisite === "object" && !Array.isArray(data.prerequisite)));
  assert.match(yamlBlock(detail, "        stop_reason:"), /type: \[string, 'null'\]/u);
  assert.ok(data.stop_reason === null || typeof data.stop_reason === "string");
  // Properties typed by $ref: ULID/RFC3339 are strings, Version is an integer; depends_on is an array of strings.
  for (const name of properties) {
    const ref = yamlBlock(detail, `        ${name}:`).match(/^        \w+:\n {10}\$ref: '#\/components\/schemas\/(\w+)'/u)?.[1];
    if (ref === "ULID" || ref === "RFC3339") assert.equal(typeof data[name], "string", name);
    if (ref === "Version") assert.ok(Number.isInteger(data[name]), name);
  }
  assert.ok(Array.isArray(data.depends_on) && data.depends_on.every((id) => typeof id === "string"));
});

test("OpenAPI documents POST /advisor/workspace and AdvisorWorkspacePreparation, and the server serves it", () => {
  const route = yamlBlock(openapi, "  /api/v1/advisor/workspace:");
  assert.match(route, /^    post:/mu);
  assert.match(route, /AdvisorWorkspacePreparation/u);
  assert.match(yamlBlock(openapi, "    AdvisorWorkspacePreparation:"), /- worktree_path/u);
  assert.match(http, /pathname === ADVISOR_WORKSPACE_API_PATH/u);
});
