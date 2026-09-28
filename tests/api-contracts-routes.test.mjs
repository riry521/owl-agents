import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
