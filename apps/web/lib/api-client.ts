/**
 * The only data-access module imported by the screens.
 *
 * REST paths and envelopes follow the Owl API v1 contract and the
 * contracts/openapi/owl-api-v1.yaml artifact. The static bundle gets the
 * actual API and WebSocket locations from runtime-config at browser startup.
 */
import type {
  AgentActivity,
  AgentRun,
  AgentsView,
  ArchiveWorkResult,
  BacklogItem,
  BacklogStatus,
  BoardView,
  CreateProjectInput,
  DeleteProjectResult,
  DeleteWorkResult,
  Decision,
  DecisionAnswerPayload,
  DecisionAnswerResult,
  DecisionView,
  Message,
  Project,
  ProjectDeletionImpact,
  ProjectFolderBrowserResult,
  ProjectFolderInspection,
  ProjectSetupInput,
  UpdateProjectInput,
  Report,
  RoleModelSetting,
  RoleModelSettingInput,
  ModelPreset,
  CreateModelPresetInput,
  UpdateModelPresetInput,
  RuntimeConfig,
  TaskSummary,
  ULID,
  UnarchiveWorkResult,
  WorkDetail,
  WorkDetailView,
  WorkListOptions,
  WorkSummary,
  KnowledgeEntry,
  KnowledgeSearchResult,
  IntegrationStatus,
  IntegrationTestResult,
  IssueBacklogWorkInput,
  IssueBacklogWorkResult,
  ExecutorConfig,
  ProviderInfo,
  ProviderPauseView,
  SaveProviderPayload,
  AdvisorSessionInfo,
  AdvisorFolders,
  AdvisorFoldersInput,
  DirectoryListing,
  SkillActivity,
  SkillListFilter,
  SkillListItem,
  SkillRecord,
  SkillDetailData,
  SkillRevision,
  SkillProposal,
  SkillProposalStatus,
  SkillProposalCommandResult,
  RuleProposal,
  RuleProposalStatus,
  RuleProposalCommandResult,
  RuleProposalCreateResult,
  RuleProposalRole,
  SkillSettings,
  SkillState,
  ProcessSkillsSettingsData,
  KnowledgeAutomationSettingsInput,
  KnowledgeAutomationSettingsData,
} from '@/lib/types';
import { runOrdinals } from '@/lib/format';
import type { Locale } from '@/lib/i18n';
import { normalizeWorkDetailData } from '@/lib/work-detail-safety.mjs';

type ApiEnvelope<T> = {
  request_id: string;
  data: T;
  version: number;
};

type TaskDetailResponse = {
  request_id: string;
  data: TaskSummary;
  report: Report | null;
  version: number;
};

type CreateWorkData = {
  work_id: ULID;
  state: 'memo' | 'ready';
  state_version: number;
};

type StartWorkData = {
  work_id: ULID;
  state: 'running';
  started: boolean;
};

type PauseWorkData = {
  work_id: ULID;
  state: 'paused';
  signal: 'pause_requested';
};

type ResumeWorkData = {
  work_id: ULID;
  state: 'running';
};

type CancelWorkData = {
  work_id: ULID;
  state: 'cancelled';
  cancel_requested: boolean;
};

export type CreateWorkInput = {
  title: string;
  summary: string;
  size: 'small' | 'normal' | 'large';
  project_id: string | null;
};

export type CreateWorkResult = CreateWorkData & { version: number };
export type StartWorkResult = StartWorkData & { version: number };

export type RealtimeStatus = 'connecting' | 'connected' | 'polling';

const RUNTIME_CONFIG_PATH = '/api/v1/runtime-config.json';
const POLL_INTERVAL_MS = 5_000;
const WS_CONNECT_TIMEOUT_MS = 5_000;
const LIVE_STATUSES = new Set<AgentRun['status']>(['launch_pending', 'spawned', 'running', 'cancel_requested']);

export type ApiRequestErrorKind = 'not_found' | 'server_error' | 'network_error' | 'bad_data' | 'request_error';

/** Typed API failure exposed to callers of the data-access functions. */
export class ApiRequestError extends Error {
  readonly code: string;
  readonly kind: ApiRequestErrorKind;
  readonly status: number | null;
  readonly details: Record<string, unknown>;
  readonly rawMessage: string;

  constructor(code: string, rawMessage: string, status: number | null, details: Record<string, unknown> = {}) {
    // Keep the machine-readable code in Error.message so screens can map it
    // to human language. The server's raw message is deliberately log-only.
    super(code);
    this.name = 'ApiRequestError';
    this.code = code;
    this.kind = apiRequestErrorKind(code, status);
    this.status = status;
    this.details = details;
    this.rawMessage = rawMessage;
  }
}

function apiRequestErrorKind(code: string, status: number | null): ApiRequestErrorKind {
  if (status === 404) return 'not_found';
  if ((status !== null && status >= 500) || code === 'server_error') return 'server_error';
  if (code.endsWith('_not_found')) return 'not_found';
  if (
    code === 'network_error' ||
    code === 'runtime_config_unavailable' ||
    code === 'request_timeout' ||
    code === 'core_not_ready' ||
    code === 'dependency_unavailable'
  ) return 'network_error';
  if (
    code === 'invalid_response' ||
    code === 'invalid_runtime_config' ||
    code === 'invalid_query' ||
    code === 'contract_invalid'
  ) return 'bad_data';
  return 'request_error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeWorkSummary(work: WorkSummary): WorkSummary {
  return {
    ...work,
    display_number: typeof work.display_number === 'number' && Number.isFinite(work.display_number)
      ? work.display_number
      : null,
    project_id: typeof work.project_id === 'string' ? work.project_id : null,
  };
}

function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new ApiRequestError('request_id_unavailable', 'ブラウザが安全なリクエストIDを生成できません。', null);
  }
  return globalThis.crypto.randomUUID();
}

function resolveApiUrl(apiBase: string, path: string): string {
  const cleanPath = path.replace(/^\//, '');
  if (/^https?:\/\//.test(apiBase)) {
    return new URL(cleanPath, apiBase.endsWith('/') ? apiBase : `${apiBase}/`).toString();
  }
  return `${apiBase.replace(/\/$/, '')}/${cleanPath}`;
}

function resolveWebSocketUrl(wsUrl: string): string {
  if (/^wss?:\/\//.test(wsUrl)) return wsUrl;
  if (typeof window === 'undefined') {
    throw new ApiRequestError('websocket_unavailable', 'ブラウザの接続先を確認できません。', null);
  }
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/${wsUrl.replace(/^\//, '')}`;
}

function validateRuntimeConfig(value: unknown): RuntimeConfig {
  if (
    !isRecord(value) ||
    value.base_path !== '/owl/' ||
    value.api_base !== '/api/v1' ||
    typeof value.ws_url !== 'string' ||
    value.ws_url.length === 0 ||
    value.schema_version !== '1.0.0'
  ) {
    throw new ApiRequestError('invalid_runtime_config', '実行時設定の形式が正しくありません。', null);
  }
  return value as unknown as RuntimeConfig;
}

async function parseJson(response: Response, context: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    console.error(`[Owl] ${context}: response body could not be read`, { error });
    throw new ApiRequestError('network_error', 'サーバーとの通信が中断されました。', response.status);
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    console.error(`[Owl] ${context}: JSONを解釈できませんでした`, { error, raw });
    const code = !response.ok && response.status >= 500 ? 'server_error' : 'invalid_response';
    throw new ApiRequestError(code, 'サーバーから受け取ったデータを解釈できません。', response.status);
  }
}

function apiErrorFromBody(body: unknown, status: number, url: string): ApiRequestError {
  const errorBody = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = errorBody && typeof errorBody.code === 'string' ? errorBody.code : 'request_failed';
  const rawMessage = errorBody && typeof errorBody.message === 'string' ? errorBody.message : 'API request failed';
  const details = errorBody && isRecord(errorBody.details) ? errorBody.details : {};
  console.error('[Owl] API request failed', { url, status, code, message: rawMessage, details, body });
  return new ApiRequestError(code, rawMessage, status, details);
}

function isWorkDetailPath(path: string): boolean {
  return /^\/?works\/[^/?]+$/.test(path.split('?')[0]);
}

async function requestRuntimeConfig(): Promise<RuntimeConfig> {
  let response: Response;
  try {
    response = await fetch(RUNTIME_CONFIG_PATH, { cache: 'no-store', headers: { Accept: 'application/json' } });
  } catch (error) {
    console.error('[Owl] runtime-config request failed', error);
    throw new ApiRequestError('runtime_config_unavailable', '実行時設定を取得できません。', null);
  }

  const body = await parseJson(response, 'runtime-config response');
  if (!response.ok) throw apiErrorFromBody(body, response.status, RUNTIME_CONFIG_PATH);
  return validateRuntimeConfig(body);
}

let runtimeConfigPromise: Promise<RuntimeConfig> | null = null;

function runtimeConfig(): Promise<RuntimeConfig> {
  if (!runtimeConfigPromise) {
    let pending: Promise<RuntimeConfig>;
    pending = requestRuntimeConfig().catch((error: unknown) => {
      if (runtimeConfigPromise === pending) runtimeConfigPromise = null;
      throw error;
    });
    runtimeConfigPromise = pending;
  }
  return runtimeConfigPromise;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = await runtimeConfig();
  const url = resolveApiUrl(config.api_base, path);
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: 'no-store', headers });
  } catch (error) {
    console.error('[Owl] API network request failed', { url, error });
    throw new ApiRequestError('network_error', 'サーバーへ接続できません。', null);
  }

  let body: unknown;
  try {
    body = await parseJson(response, `${init.method ?? 'GET'} ${url}`);
  } catch (error) {
    if (
      response.status === 404 &&
      isWorkDetailPath(path) &&
      error instanceof ApiRequestError &&
      error.code === 'invalid_response'
    ) {
      throw new ApiRequestError('work_not_found', 'Workが見つかりません。', 404);
    }
    throw error;
  }
  if (!response.ok) {
    const apiError = apiErrorFromBody(body, response.status, url);
    if (response.status === 404 && isWorkDetailPath(path)) {
      throw new ApiRequestError('work_not_found', apiError.rawMessage, 404, apiError.details);
    }
    throw apiError;
  }
  if (body === null) {
    console.error('[Owl] API request returned an empty success body', { url, status: response.status });
    throw new ApiRequestError('invalid_response', 'サーバーから空の応答が返りました。', response.status);
  }
  return body as T;
}

async function listAll<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (;;) {
    const query = new URLSearchParams({ ...params, limit: '200' });
    if (cursor) query.set('cursor', cursor);
    const page = await requestJson<unknown>(`${path}?${query.toString()}`);
    if (
      !isRecord(page) ||
      !Array.isArray(page.data) ||
      typeof page.has_more !== 'boolean' ||
      (page.has_more && (typeof page.cursor !== 'string' || page.cursor.length === 0))
    ) {
      throw new ApiRequestError('invalid_response', '一覧データの形式が正しくありません。', null);
    }
    items.push(...page.data as T[]);
    if (!page.has_more) return items;
    const nextCursor = page.cursor as string;
    if (seenCursors.has(nextCursor)) {
      throw new ApiRequestError('invalid_response', '一覧データの続き位置が繰り返されています。', null);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

async function command<T>(
  path: string,
  payload: object,
  expectedVersion: number,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST',
): Promise<ApiEnvelope<T>> {
  const requestId = createRequestId();
  const idempotencyKey = createRequestId();
  return requestJson<ApiEnvelope<T>>(path, {
    method,
    body: JSON.stringify({
      request_id: requestId,
      idempotency_key: idempotencyKey,
      expected_version: expectedVersion,
      payload,
    }),
  });
}

async function listDecisions(): Promise<Decision[]> {
  const statuses: Decision['status'][] = ['open', 'resolved', 'cancelled'];
  const pages = await Promise.all(statuses.map((status) => listAll<Decision>('/decisions', { status })));
  return pages.flat();
}

async function reportsForTasks(tasks: TaskSummary[]): Promise<Report[]> {
  const details = await Promise.all(
    tasks.map((task) => requestJson<TaskDetailResponse>(`/tasks/${encodeURIComponent(task.id)}?include_report=true`)),
  );
  return details.flatMap((detail) => (detail.report ? [detail.report] : []));
}

function isApiError(error: unknown, code: string): boolean {
  return error instanceof ApiRequestError && error.code === code;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'work_not_found';
}

function workDtoFromResponse(response: unknown, requestedId: string): Record<string, unknown> {
  if (!isRecord(response) || !isRecord(response.data)) {
    throw new ApiRequestError('invalid_response', 'Work詳細の応答形式が正しくありません。', null);
  }
  const work = response.data;
  if (
    work.id !== requestedId ||
    typeof work.title !== 'string' || work.title.trim().length === 0 ||
    typeof work.state !== 'string' || work.state.trim().length === 0
  ) {
    throw new ApiRequestError('invalid_response', 'Work詳細に必要な情報がありません。', null);
  }
  return work;
}

// ---- public API ------------------------------------------------------------

/** GET /api/v1/runtime-config.json. */
export function getRuntimeConfig(): Promise<RuntimeConfig> {
  return runtimeConfig();
}

/** GET /api/v1/works + GET /api/v1/decisions?status=open. */
export async function getBoard(options: WorkListOptions = {}): Promise<BoardView> {
  const [works, open_decisions] = await Promise.all([
    listAll<WorkSummary>('/works', options.archived ? { archived: options.archived } : {}),
    listAll<Decision>('/decisions', { status: 'open' }),
  ]);
  return { works: works.map(normalizeWorkSummary), open_decisions };
}

export type WorkBranchStatus = 'present' | 'absent' | 'unknown';

export interface WorkDesignSummary {
  task_id: ULID;
  title: string;
  updated_at: string;
  size_bytes: number;
}

export interface WorkDesignDetail {
  task_id: ULID;
  title: string;
  markdown: string;
  updated_at: string;
}

/** GET /api/v1/works/{id}/designs. */
export async function getWorkDesigns(id: ULID): Promise<{ designs: WorkDesignSummary[] }> {
  const response = await requestJson<{ data?: { designs?: WorkDesignSummary[] } }>(`/works/${encodeURIComponent(id)}/designs`);
  return { designs: response.data?.designs ?? [] };
}

/** GET /api/v1/works/{id}/designs/{task_id}; a missing document is a 404 error. */
export async function getWorkDesign(id: ULID, taskId: ULID): Promise<WorkDesignDetail> {
  const response = await requestJson<{ data?: WorkDesignDetail }>(`/works/${encodeURIComponent(id)}/designs/${encodeURIComponent(taskId)}`);
  if (!response.data) throw new Error('Design document response did not include data.');
  return response.data;
}

/** GET /api/v1/backlog. */
export async function listBacklog(
  filter: { status?: BacklogStatus; project_id?: string } = {},
): Promise<BacklogItem[]> {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.project_id) params.set('project_id', filter.project_id);
  const queryString = params.toString();
  const query = queryString ? `?${queryString}` : '';
  const response = await requestJson<{ request_id: string; data: BacklogItem[] }>(`/backlog${query}`);
  return response.data;
}

/** GET /api/v1/works/{work_id}/backlog. */
export async function listWorkBacklog(workId: ULID): Promise<BacklogItem[]> {
  const response = await requestJson<{ request_id: string; data: BacklogItem[] }>(
    `/works/${encodeURIComponent(workId)}/backlog`,
  );
  return response.data;
}

/** POST /api/v1/backlog/dismiss with the Owner command envelope. */
export async function dismissBacklogItems(itemIds: string[]): Promise<BacklogItem[]> {
  const response = await command<{ items: BacklogItem[] }>(
    '/backlog/dismiss',
    { item_ids: itemIds },
    0,
    'POST',
  );
  return response.data.items;
}

/** POST /api/v1/backlog/issue-work with the Owner command envelope. */
export async function issueBacklogWork(input: IssueBacklogWorkInput): Promise<IssueBacklogWorkResult> {
  const response = await command<IssueBacklogWorkResult>(
    '/backlog/issue-work',
    {
      item_ids: input.item_ids,
      title: input.title.trim(),
      summary: input.summary.trim(),
      size: input.size,
    },
    0,
    'POST',
  );
  return response.data;
}

/** GET /api/v1/works/{id}/branch-status: whether the Work's branches hold changes outside the Project base. */
export async function getWorkBranchStatus(id: ULID): Promise<WorkBranchStatus> {
  const response = await requestJson<unknown>(`/works/${encodeURIComponent(id)}/branch-status`);
  const data = typeof response === 'object' && response !== null ? (response as { data?: unknown }).data : null;
  const status = typeof data === 'object' && data !== null ? (data as { unmerged_changes?: unknown }).unmerged_changes : null;
  return status === 'present' || status === 'absent' ? status : 'unknown';
}

/**
 * GET /api/v1/works/{id} plus the contract-defined task, agent, report, and
 * decision endpoints needed by the existing Work Detail aggregate. A missing
 * Work resolves to null; other failures reject with ApiRequestError.kind set
 * to server_error, network_error, bad_data, or request_error.
 */
export async function getWorkDetail(id: ULID): Promise<WorkDetailView | null> {
  try {
    const [workResponse, tasks, runs, decisions] = await Promise.all([
      requestJson<unknown>(`/works/${encodeURIComponent(id)}`),
      listAll<TaskSummary>(`/works/${encodeURIComponent(id)}/tasks`),
      listAll<AgentRun>('/agents', { work_id: id }),
      listDecisions(),
    ]);
    const work = workDtoFromResponse(workResponse, id);
    const initial = normalizeWorkDetailData({
      // The REST envelope and Work identity/title/state are required. Older
      // Cores may omit progress, so the frontend derives it from the Task pages.
      work,
      tasks,
      runs,
      reports: [],
      decisions,
      // WorkDetail has no conversation_id and the frozen contract exposes no
      // work-to-conversation lookup. Do not invent an endpoint or fabricate
      // messages; the aggregate remains contract-shaped until that mapping is
      // added to the API artifact.
      messages: [],
    }, id);
    const reports = await reportsForTasks(initial.tasks);
    return normalizeWorkDetailData({
      ...initial,
      reports,
      decisions: initial.decisions.filter((decision) => decision.work_id === id),
    }, id);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    if (error instanceof ApiRequestError) throw error;
    console.error('[Owl] Work detail request failed unexpectedly', error);
    throw new ApiRequestError('server_error', 'Work詳細を取得できませんでした。', null, { operation: 'getWorkDetail' });
  }
}

/** GET /api/v1/decisions (all statuses) plus the related Work and Tasks. */
export async function getDecision(id: ULID): Promise<DecisionView | null> {
  const decisions = await listDecisions();
  const decision = decisions.find((candidate) => candidate.id === id);
  if (!decision) return null;

  try {
    const [workResponse, tasks] = await Promise.all([
      requestJson<ApiEnvelope<WorkDetail>>(`/works/${encodeURIComponent(decision.work_id)}`),
      listAll<TaskSummary>(`/works/${encodeURIComponent(decision.work_id)}/tasks`),
    ]);
    const blocked = new Set(decision.blocked_task_ids);
    return {
      decision,
      work: normalizeWorkDetailData({ work: workResponse.data }, decision.work_id).work,
      blocked_tasks: tasks.filter((task) => blocked.has(task.id)),
    };
  } catch (error) {
    if (isApiError(error, 'work_not_found')) return null;
    throw error;
  }
}

/** POST /api/v1/works with the command envelope. */
export async function createWork(input: CreateWorkInput): Promise<CreateWorkResult> {
  const response = await command<CreateWorkData>(
    '/works',
    {
      title: input.title.trim(),
      summary: input.summary.trim(),
      size: input.size,
      project_id: input.project_id,
    },
    0,
  );
  return { ...response.data, version: response.version };
}

/** POST /api/v1/works/{work_id}/start with the command envelope. */
export async function startWork(
  workId: ULID,
  expectedVersion: number,
  mode: 'normal' | 'small',
): Promise<StartWorkResult> {
  const response = await command<StartWorkData>(
    `/works/${encodeURIComponent(workId)}/start`,
    { mode },
    expectedVersion,
  );
  return { ...response.data, version: response.version };
}

/** POST /api/v1/works/{work_id}/pause with the command envelope. */
export async function pauseWork(workId: ULID, expectedVersion: number, reason = ''): Promise<PauseWorkData> {
  const response = await command<PauseWorkData>(
    `/works/${encodeURIComponent(workId)}/pause`,
    { reason },
    expectedVersion,
  );
  return response.data;
}

/** POST /api/v1/works/{work_id}/resume with the command envelope. */
export async function resumeWork(workId: ULID, expectedVersion: number): Promise<ResumeWorkData> {
  const response = await command<ResumeWorkData>(
    `/works/${encodeURIComponent(workId)}/resume`,
    {},
    expectedVersion,
  );
  return response.data;
}

/** POST /api/v1/works/{work_id}/cancel with the command envelope. */
export async function cancelWork(
  workId: ULID,
  expectedVersion: number,
  reason: string,
  force = false,
): Promise<CancelWorkData> {
  const response = await command<CancelWorkData>(
    `/works/${encodeURIComponent(workId)}/cancel`,
    { reason, force },
    expectedVersion,
  );
  return response.data;
}

/** POST /api/v1/works/{work_id}/reopen: returns a completed Work to running for follow-up work. */
export async function reopenWork(
  workId: ULID,
  expectedVersion: number,
  reason = '',
): Promise<{ work_id: ULID; state: string }> {
  const response = await command<{ work_id: ULID; state: string }>(
    `/works/${encodeURIComponent(workId)}/reopen`,
    // reason is optional but must be non-blank when sent.
    reason.trim() ? { reason } : {},
    expectedVersion,
  );
  return response.data;
}

/** POST /api/v1/works/{id}/archive with the command envelope. */
export async function archiveWork(workId: ULID, expectedVersion: number): Promise<ArchiveWorkResult> {
  const response = await command<ArchiveWorkResult>(
    `/works/${encodeURIComponent(workId)}/archive`,
    {},
    expectedVersion,
  );
  return response.data;
}

/** POST /api/v1/works/{id}/unarchive with the command envelope. */
export async function unarchiveWork(workId: ULID, expectedVersion: number): Promise<UnarchiveWorkResult> {
  const response = await command<UnarchiveWorkResult>(
    `/works/${encodeURIComponent(workId)}/unarchive`,
    {},
    expectedVersion,
  );
  return response.data;
}

/** DELETE /api/v1/works/{id} with the command envelope. */
export async function deleteWork(workId: ULID, expectedVersion: number): Promise<DeleteWorkResult> {
  const response = await command<DeleteWorkResult>(
    `/works/${encodeURIComponent(workId)}`,
    {},
    expectedVersion,
    'DELETE',
  );
  return response.data;
}

/** POST /api/v1/decisions/{id}/answer with the command envelope. */
export async function answerDecision(id: ULID, payload: DecisionAnswerPayload): Promise<DecisionAnswerResult> {
  const current = await getDecision(id);
  if (!current) {
    throw new ApiRequestError('decision_not_found', '判断が見つかりません。', null);
  }
  const response = await command<DecisionAnswerResult>(
    `/decisions/${encodeURIComponent(id)}/answer`,
    payload,
    current.decision.state_version,
  );
  return response.data;
}

/**
 * GET /api/v1/settings/models. The envelope's
 * top-level `version` is the settings row's version; callers must keep it
 * and pass it back on updateModelSettings so the PUT can optimistically lock
 * against the version they actually read.
 */
export async function getModelSettings(): Promise<{ roles: RoleModelSetting[]; version: number }> {
  const response = await requestJson<ApiEnvelope<{ roles: RoleModelSetting[] }>>('/settings/models');
  return { ...response.data, version: response.version };
}

/**
 * PUT /api/v1/settings/models. `expectedVersion` must be the `version`
 * from the last getModelSettings() response; passing a stale value yields
 * `version_conflict`, surfaced to the screen as an ordinary save error.
 */
export async function updateModelSettings(
  roles: RoleModelSettingInput[],
  expectedVersion: number,
): Promise<{ roles: RoleModelSetting[]; version: number }> {
  const response = await command<{ roles: RoleModelSetting[] }>('/settings/models', { roles }, expectedVersion, 'PUT');
  return { ...response.data, version: response.version };
}

export async function getModelPresets(): Promise<{ presets: ModelPreset[]; version: number }> {
  const response = await requestJson<ApiEnvelope<{ presets: ModelPreset[] }>>('/settings/model-presets');
  return { ...response.data, version: response.version };
}

export async function createModelPreset(input: CreateModelPresetInput, expectedVersion: number): Promise<{ preset: ModelPreset; presets: ModelPreset[]; version: number }> {
  const response = await command<{ preset: ModelPreset; presets: ModelPreset[] }>('/settings/model-presets', input, expectedVersion);
  return { ...response.data, version: response.version };
}

export async function updateModelPreset(id: string, input: UpdateModelPresetInput, expectedVersion: number): Promise<{ preset: ModelPreset; presets: ModelPreset[]; version: number }> {
  const response = await command<{ preset: ModelPreset; presets: ModelPreset[] }>(`/settings/model-presets/${encodeURIComponent(id)}`, input, expectedVersion, 'PUT');
  return { ...response.data, version: response.version };
}

export async function deleteModelPreset(id: string, expectedVersion: number): Promise<{ presets: ModelPreset[]; version: number }> {
  const response = await command<{ presets: ModelPreset[] }>(`/settings/model-presets/${encodeURIComponent(id)}`, {}, expectedVersion, 'DELETE');
  return { ...response.data, version: response.version };
}

// ---- Integrations API -------------------------------------------------------

export async function getIntegrations(): Promise<IntegrationStatus[]> {
  const response = await requestJson<ApiEnvelope<{ integrations: IntegrationStatus[] }>>('/settings/integrations');
  return response.data.integrations;
}

export async function saveIntegration(
  provider: 'slack' | 'discord',
  config: {
    bot_token?: string;
    app_token?: string;
    signing_secret?: string;
    conversation_channel_id: string;
    notification_channel_id: string;
  },
): Promise<IntegrationStatus> {
  const response = await command<IntegrationStatus>(
    `/settings/integrations/${encodeURIComponent(provider)}`,
    config,
    0,
    'PUT',
  );
  return response.data;
}

export async function testIntegration(provider: 'slack' | 'discord'): Promise<IntegrationTestResult> {
  const response = await requestJson<{ request_id: string; data: IntegrationTestResult }>(
    `/settings/integrations/${encodeURIComponent(provider)}/test`,
    { method: 'POST' },
  );
  return response.data;
}

export async function deleteIntegration(provider: 'slack' | 'discord'): Promise<void> {
  await requestJson(`/settings/integrations/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
    body: JSON.stringify({
      request_id: createRequestId(),
      idempotency_key: createRequestId(),
      expected_version: 0,
      payload: {},
    }),
  });
}

/** GET /api/v1/projects. */
export async function listProjects(): Promise<Project[]> {
  return listAll<Project>('/projects');
}

/** POST /api/v1/projects with the command envelope. */
export async function createProject(input: CreateProjectInput): Promise<Project> {
  const response = await command<Project>('/projects', input, 0);
  return response.data;
}

/** PATCH /api/v1/projects/{id} with the command envelope. */
export async function updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
  const response = await command<Project>(`/projects/${encodeURIComponent(id)}`, input, 0, 'PATCH');
  return response.data;
}

/** GET /api/v1/projects/{id}/deletion-impact. */
export async function getProjectDeletionImpact(id: string): Promise<ProjectDeletionImpact> {
  const response = await requestJson<{ request_id: string; data: ProjectDeletionImpact }>(`/projects/${id}/deletion-impact`);
  return response.data;
}

/** DELETE /api/v1/projects/{id} with the command envelope. */
export async function deleteProject(id: string, confirmedWorkCount: number): Promise<DeleteProjectResult> {
  const response = await command<DeleteProjectResult>(
    `/projects/${id}`,
    { confirmed_work_count: confirmedWorkCount },
    0,
    'DELETE',
  );
  return response.data;
}

/** Inspect a local folder before registering it as a Project. */
export async function inspectProjectFolder(path: string): Promise<ProjectFolderInspection> {
  const response = await requestJson<ApiEnvelope<ProjectFolderInspection>>('/projects/inspect', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
  return response.data;
}

/** List local child folders under the Owl user's home directory. */
export async function browseProjectFolders(path?: string): Promise<ProjectFolderBrowserResult> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const response = await requestJson<ApiEnvelope<ProjectFolderBrowserResult>>(`/projects/folders${query}`);
  return response.data;
}

/** Register an existing repository, initialize a new project, or prepare Git for an existing folder. */
export async function setupProject(input: ProjectSetupInput): Promise<Project> {
  const response = await command<Project>('/projects/setup', input, 0);
  return response.data;
}

/** GET /api/v1/conversations/{id}/messages. */
export async function listMessages(conversationId: string): Promise<Message[]> {
  try {
    return await listAll<Message>(`/conversations/${encodeURIComponent(conversationId)}/messages`);
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'conversation_not_found') return [];
    throw error;
  }
}

/** POST /api/v1/conversations/{id}/messages with the command envelope. */
export async function postMessage(conversationId: string, body: string): Promise<{ message_id: string }> {
  const response = await command<{ message_id: string; advisor_run_id: string | null }>(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    { body, attachment_ids: [] },
    0,
  );
  return response.data;
}

/** GET /api/v1/agents and contract-defined Task/Work lookups for the Agents view. */
export async function getAgents(): Promise<AgentsView> {
  const [rawRuns, workSummaries, projects] = await Promise.all([
    listAll<AgentRun>('/agents'),
    listAll<WorkSummary>('/works', { archived: 'include' }),
    listAll<Project>('/projects').catch(() => [] as Project[]),
  ]);
  const works = workSummaries.map(normalizeWorkSummary);
  const runs = rawRuns.map(withRunLineage);
  const taskIds = [...new Set(runs.flatMap((run) => (run.task_id ? [run.task_id] : [])))];
  const taskResults = await Promise.allSettled(
    taskIds.map((taskId) => requestJson<TaskDetailResponse>(`/tasks/${encodeURIComponent(taskId)}`)),
  );
  const tasks = new Map<string, TaskDetailResponse["data"]>();
  for (let i = 0; i < taskIds.length; i++) {
    const result = taskResults[i];
    if (result.status === 'fulfilled') tasks.set(result.value.data.id, result.value.data);
  }
  const workById = new Map(works.map((work) => [work.id, work]));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const workIdOf = (run: AgentRun): string | null =>
    run.work_id ?? (run.task_id ? tasks.get(run.task_id)?.work_id ?? null : null);
  const ordinals = runOrdinals(runs, workIdOf);
  const toActivity = (run: AgentRun): AgentActivity => {
    const task = run.task_id ? tasks.get(run.task_id) ?? null : null;
    const workId = workIdOf(run);
    const work = workId ? workById.get(workId) ?? null : null;
    return {
      run,
      ordinal: ordinals.get(run.id) ?? 1,
      last_output_at: run.last_output_at,
      task,
      work,
      project_name: work?.project_id ? projectNames.get(work.project_id) ?? null : null,
    };
  };

  // Child runs (Hybrid executors / observed subagents) are nested under their
  // parent on screen, so only runs whose parent is unknown count as top-level.
  const runIds = new Set(runs.map((run) => run.id));
  const isChild = (run: AgentRun) =>
    run.parent_agent_id !== null && run.parent_agent_id !== run.id && runIds.has(run.parent_agent_id);
  const topLevel = runs.filter((run) => !isChild(run));
  const running = topLevel.filter((run) => LIVE_STATUSES.has(run.status)).map(toActivity);
  const recent = topLevel
    .filter((run) => !LIVE_STATUSES.has(run.status))
    .sort((a, b) => (b.ended_at ?? '').localeCompare(a.ended_at ?? ''))
    .slice(0, 8)
    .map(toActivity);
  return { idle_threshold_seconds: 1800, running, recent, children: runs.filter(isChild) };
}

/** Fill the child-run lineage fields with null when an older Core omits them. */
function withRunLineage(run: AgentRun): AgentRun {
  const phase = run.phase === 'plan' || run.phase === 'executing' || run.phase === 'verdict' ? run.phase : null;
  const origin = run.origin === 'spawned' || run.origin === 'observed' ? run.origin : null;
  return {
    ...run,
    work_id: typeof run.work_id === 'string' ? run.work_id : null,
    last_output_at: typeof run.last_output_at === 'string' ? run.last_output_at : null,
    parent_agent_id: typeof run.parent_agent_id === 'string' ? run.parent_agent_id : null,
    phase,
    label: typeof run.label === 'string' ? run.label : null,
    origin,
  };
}

/**
 * Subscribe to WebSocket frames. A transport failure deliberately
 * switches to polling and reports that state to the screen in human language.
 */
export function subscribeToUpdates(
  workIds: ULID[],
  onUpdate: () => void,
  onStatus: (status: RealtimeStatus) => void,
  eventTypes: string[] = [],
): () => void {
  let disposed = false;
  let socket: WebSocket | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;

  const safeUpdate = () => {
    try {
      onUpdate();
    } catch (error) {
      console.error('[Owl] refresh after WebSocket event failed', error);
    }
  };

  const startPolling = () => {
    if (disposed || pollTimer) return;
    onStatus('polling');
    safeUpdate();
    pollTimer = setInterval(safeUpdate, POLL_INTERVAL_MS);
  };

  const failWebSocket = (error: unknown) => {
    console.error('[Owl] WebSocket unavailable; polling fallback enabled', error);
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      socket.close();
    }
    startPolling();
  };

  const connect = async () => {
    onStatus('connecting');
    let config: RuntimeConfig;
    try {
      config = await runtimeConfig();
    } catch (error) {
      failWebSocket(error);
      return;
    }
    if (disposed) return;
    if (typeof WebSocket === 'undefined') {
      failWebSocket(new ApiRequestError('websocket_unavailable', 'このブラウザはWebSocketに対応していません。', null));
      return;
    }

    try {
      socket = new WebSocket(resolveWebSocketUrl(config.ws_url));
    } catch (error) {
      failWebSocket(error);
      return;
    }

    connectTimer = setTimeout(() => {
      if (socket && socket.readyState !== WebSocket.OPEN) {
        failWebSocket(new ApiRequestError('websocket_timeout', 'リアルタイム接続が時間内に確立しませんでした。', null));
      }
    }, WS_CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      if (!socket || disposed) return;
      if (connectTimer) clearTimeout(connectTimer);
      socket.send(
        JSON.stringify({
          kind: 'subscribe',
          request_id: createRequestId(),
          work_ids: workIds,
          event_types: eventTypes,
        }),
      );
    };

    socket.onmessage = (message) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(message.data)) as unknown;
      } catch (error) {
        failWebSocket(error);
        return;
      }
      if (!isRecord(frame) || typeof frame.kind !== 'string') {
        failWebSocket(new ApiRequestError('invalid_websocket_frame', 'WebSocketの応答形式が正しくありません。', null));
        return;
      }
      if (frame.kind === 'ready') {
        if (frame.protocol_version !== 'owl-ws-1' || typeof frame.cursor !== 'string') {
          failWebSocket(new ApiRequestError('invalid_websocket_frame', 'WebSocketの準備応答が正しくありません。', null));
        } else {
          onStatus('connected');
        }
        return;
      }
      if (frame.kind === 'error') {
        console.error('[Owl] WebSocket server error frame', frame);
        failWebSocket(frame);
        return;
      }
      if (
        frame.kind !== 'event' ||
        typeof frame.event_id !== 'string' ||
        typeof frame.sequence !== 'number' ||
        typeof frame.cursor !== 'string' ||
        frame.schema_version !== '1.0.0' ||
        !isRecord(frame.payload)
      ) {
        console.error('[Owl] Unknown WebSocket frame', frame);
        return;
      }
      safeUpdate();
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ kind: 'ack', request_id: createRequestId(), cursor: frame.cursor }));
      }
    };

    socket.onerror = (error) => failWebSocket(error);
    socket.onclose = (event) => {
      if (!disposed) failWebSocket(event);
    };
  };

  void connect();

  return () => {
    disposed = true;
    if (connectTimer) clearTimeout(connectTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) socket.close();
    socket = null;
  };
}


// ---- Hybrid Mode API -------------------------------------------------------

export async function getHybridMode(): Promise<boolean> {
  const response = await requestJson<ApiEnvelope<{ hybrid_mode: boolean }>>('/settings/hybrid');
  return response.data.hybrid_mode;
}

export async function setHybridMode(enabled: boolean): Promise<boolean> {
  const response = await command<{ hybrid_mode: boolean }>('/settings/hybrid', { hybrid_mode: enabled }, 0, 'PUT');
  return response.data.hybrid_mode;
}

// ---- Owner language API ----------------------------------------------------

/** The language agents and Owl write in for the Owner ("ja" | "en"). */
export async function getOwnerLanguage(): Promise<Locale> {
  const response = await requestJson<ApiEnvelope<{ language: Locale }>>('/settings/language');
  return response.data.language;
}

export async function setOwnerLanguage(language: Locale): Promise<Locale> {
  const response = await command<{ language: Locale }>('/settings/language', { language }, 0, 'PUT');
  return response.data.language;
}

// ---- Executor Config API ---------------------------------------------------

export async function getExecutorConfig(): Promise<ExecutorConfig> {
  const response = await requestJson<ApiEnvelope<ExecutorConfig>>('/settings/executor');
  return response.data;
}

export async function setExecutorConfig(config: ExecutorConfig): Promise<ExecutorConfig> {
  const response = await command<ExecutorConfig>('/settings/executor', config, 0, 'PUT');
  return response.data;
}


// ---- Typesafe API Key -------------------------------------------------------

export async function getTypesafeApiKey(): Promise<string> {
  const response = await requestJson<ApiEnvelope<{ typesafe_api_key: string }>>('/settings/typesafe');
  return response.data.typesafe_api_key;
}

export async function setTypesafeApiKey(key: string): Promise<string> {
  const response = await command<{ typesafe_api_key: string }>('/settings/typesafe', { typesafe_api_key: key }, 0, 'PUT');
  return response.data.typesafe_api_key;
}

// ---- Advisor Persona -------------------------------------------------------

export async function getAdvisorPersona(): Promise<string> {
  const response = await requestJson<ApiEnvelope<{ advisor_persona: string }>>('/settings/advisor-persona');
  return response.data.advisor_persona;
}

export async function setAdvisorPersona(persona: string): Promise<string> {
  const response = await command<{ advisor_persona: string }>('/settings/advisor-persona', { advisor_persona: persona }, 0, 'PUT');
  return response.data.advisor_persona;
}

// ---- Advisor Folders --------------------------------------------------------

export async function getAdvisorFolders(): Promise<AdvisorFolders> {
  const response = await requestJson<ApiEnvelope<AdvisorFolders>>('/settings/advisor-folders');
  return response.data;
}

export async function putAdvisorFolders(input: AdvisorFoldersInput): Promise<AdvisorFolders> {
  const response = await command<AdvisorFolders>('/settings/advisor-folders', input, 0, 'PUT');
  return response.data;
}

// ---- Filesystem Browsing (folder-picker dialog) ----------------------------

/** Browse folders on the Owl host; path omitted lists the home folder. */
export async function listDirectories(path?: string, showHidden?: boolean): Promise<DirectoryListing> {
  const params: Record<string, string> = {};
  if (path) params.path = path;
  if (showHidden !== undefined) params.show_hidden = showHidden ? '1' : '0';
  const qs = new URLSearchParams(params).toString();
  const response = await requestJson<ApiEnvelope<DirectoryListing>>(`/fs/directories${qs ? `?${qs}` : ''}`);
  return response.data;
}

// ---- Provider Management ----

export async function listProviders(): Promise<ProviderInfo[]> {
  const res = await requestJson<{ data: ProviderInfo[] }>('/settings/providers');
  return res.data;
}

export async function getProvider(id: string): Promise<ProviderInfo> {
  const res = await requestJson<{ data: ProviderInfo }>(`/settings/providers/${encodeURIComponent(id)}`);
  return res.data;
}

export async function saveProvider(id: string, payload: SaveProviderPayload, expectedVersion = 0): Promise<ProviderInfo> {
  const res = await command<ProviderInfo>(
    `/settings/providers/${encodeURIComponent(id)}`,
    payload,
    expectedVersion,
    'PUT',
  );
  return res.data;
}

export async function createProvider(payload: SaveProviderPayload & { id: string }, expectedVersion = 0): Promise<ProviderInfo> {
  const res = await command<ProviderInfo>(
    '/settings/providers',
    payload,
    expectedVersion,
    'POST',
  );
  return res.data;
}

export async function deleteProvider(id: string): Promise<void> {
  await requestJson(`/settings/providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: crypto.randomUUID(),
      idempotency_key: crypto.randomUUID(),
      expected_version: 0,
      payload: {},
    }),
  });
}

export async function testProvider(id: string): Promise<{ ok: boolean; detail: string }> {
  const res = await requestJson<{ data: { ok: boolean; detail: string } }>(
    `/settings/providers/${encodeURIComponent(id)}/test`,
    { method: 'POST' },
  );
  return res.data;
}

export async function getProviderModels(): Promise<Record<string, string[]>> {
  const res = await requestJson<{ data: Record<string, string[]> }>('/settings/provider-models');
  return res.data;
}

export async function getProviderPauses(): Promise<ProviderPauseView[]> {
  const res = await requestJson<{ request_id: string; data: { pauses: ProviderPauseView[] } }>('/providers/pauses');
  return res.data.pauses;
}

export async function setProviderModels(providerId: string, models: string[]): Promise<string[]> {
  const res = await command<{ models: string[] }>(
    `/settings/provider-models/${encodeURIComponent(providerId)}`,
    { models },
    0,
    'PUT',
  );
  return res.data.models;
}

// ---- Advisor Conversation Management API -----------------------------------

export async function getActiveConversation(): Promise<string> {
  const result = await requestJson<{ conversation_id: string }>('/advisor/conversation/active');
  return result.conversation_id;
}

/** GET /api/v1/advisor/session. */
export async function getAdvisorSession(): Promise<AdvisorSessionInfo> {
  return requestJson<AdvisorSessionInfo>('/advisor/session');
}

export async function clearAdvisorConversation(conversationId: string): Promise<void> {
  await command(`/conversations/${encodeURIComponent(conversationId)}/clear`, {}, 0, 'POST');
}

/** POST /api/v1/knowledge/ingest with the command envelope. */
export async function ingestConversation(conversationId: string): Promise<{ path: string }> {
  const response = await command<{ path: string }>('/knowledge/ingest', { conversation_id: conversationId }, 0);
  return response.data;
}

// ---- Knowledge Base API --------------------------------------------------

export async function searchKnowledge(query: string, tags: string[] = []): Promise<KnowledgeSearchResult[]> {
  const params: Record<string, string> = {};
  if (query) params.q = query;
  if (tags.length > 0) params.tags = tags.join(',');
  const qs = new URLSearchParams(params).toString();
  const result = await requestJson<{ data: KnowledgeSearchResult[] }>(`/knowledge${qs ? '?' + qs : ''}`);
  return result.data;
}

export async function listKnowledge(folder?: string): Promise<KnowledgeSearchResult[]> {
  const params: Record<string, string> = {};
  if (folder) params.folder = folder;
  const qs = new URLSearchParams(params).toString();
  const result = await requestJson<{ data: KnowledgeSearchResult[] }>(`/knowledge${qs ? '?' + qs : ''}`);
  return result.data;
}

export async function getKnowledgeEntry(path: string): Promise<KnowledgeEntry> {
  const result = await requestJson<{ data: KnowledgeEntry }>(`/knowledge/${encodeURIComponent(path)}`);
  return result.data;
}

export async function createKnowledgeEntry(input: {
  folder: string;
  filename: string;
  tags: string[];
  body: string;
}): Promise<KnowledgeEntry> {
  const result = await requestJson<{ data: KnowledgeEntry }>('/knowledge', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return result.data;
}

export async function updateKnowledgeEntry(path: string, input: {
  tags?: string[];
  body?: string;
}): Promise<KnowledgeEntry> {
  const result = await requestJson<{ data: KnowledgeEntry }>(`/knowledge/${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return result.data;
}

export async function deleteKnowledgeEntry(path: string): Promise<void> {
  await requestJson(`/knowledge/${encodeURIComponent(path)}`, { method: 'DELETE' });
}

export interface RulesSnapshot {
  files: Array<{ path: string; level: string; role: string | null; rule_count: number }>;
  block_rules: Array<{ id: string; level: string; role: string | null; pattern: string; message: string }>;
  block_paths: Array<{ id: string; level: string; role: string | null; pattern: string; mode: string; message: string }>;
  prompt_rules: Array<{ id: string; level: string; role?: string; kind: string; text: string }>;
  status: {
    generation: number;
    loaded_at: string | null;
    error: { at: string; failures: Array<{ path: string; line: number | null; reason: string }> } | null;
  };
}

export async function getRules(): Promise<RulesSnapshot> {
  const res = await requestJson<ApiEnvelope<RulesSnapshot>>('/rules');
  return res.data;
}

export async function checkRule(command: string): Promise<{ blocked: boolean; rule?: { id: string; level: string; message: string } }> {
  const res = await requestJson<ApiEnvelope<{ blocked: boolean; rule?: { id: string; level: string; message: string } }>>('/rules/check', {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
  return res.data;
}

/** Newest-first page of the event log (order=desc), so the Activity Log shows the latest activity. */
export async function listEvents(limit = 50): Promise<Array<{
  event_id: string; type: string; work_id?: string; task_id?: string;
  agent_run_id?: string; agent_run?: { model: string | null; effort: string | null };
  payload: Record<string, unknown>; created_at: string;
}>> {
  const res = await requestJson<ApiEnvelope<{ events: Array<{
    event_id: string; type: string; work_id?: string; task_id?: string;
    agent_run_id?: string; agent_run?: { model: string | null; effort: string | null };
  payload: Record<string, unknown>; created_at: string;
  }> }>>(`/events?order=desc&limit=${limit}`);
  return res.data.events;
}


// ---- Skill Box API ----------------------------------------------------------

/** GET /api/v1/skills. A plain array response (no pagination on this endpoint). */
export async function listSkills(filter: SkillListFilter = {}): Promise<SkillListItem[]> {
  const params: Record<string, string> = {};
  if (filter.q) params.q = filter.q;
  if (filter.state) params.state = filter.state;
  if (filter.scope) params.scope = filter.scope;
  if (typeof filter.trial === 'boolean') params.trial = String(filter.trial);
  const qs = new URLSearchParams(params).toString();
  const response = await requestJson<ApiEnvelope<SkillListItem[]>>(`/skills${qs ? `?${qs}` : ''}`);
  return response.data;
}

/**
 * GET /api/v1/skills/{name}. For a broken skill (missing/unreadable directory)
 * the server still returns 200, with `body` empty, `files` empty, and
 * `skill.broken_reason` set; callers render that state rather than treating it
 * as a load failure.
 */
export async function getSkill(name: string): Promise<SkillDetailData> {
  const response = await requestJson<ApiEnvelope<SkillDetailData>>(`/skills/${encodeURIComponent(name)}`);
  return response.data;
}

/** GET /api/v1/skills/{name}/files/{path}. `path` may contain slashes (e.g. "references/x.md"). */
export async function getSkillFile(name: string, path: string): Promise<string> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const response = await requestJson<ApiEnvelope<{ content: string }>>(
    `/skills/${encodeURIComponent(name)}/files/${encodedPath}`,
  );
  return response.data.content;
}

/** GET /api/v1/skills/{name}/revisions. Rows omit `files` (the snapshot); fetch a single revision for that. */
export async function listSkillRevisions(name: string): Promise<SkillRevision[]> {
  const response = await requestJson<ApiEnvelope<SkillRevision[]>>(`/skills/${encodeURIComponent(name)}/revisions`);
  return response.data;
}

/** GET /api/v1/skills/{name}/revisions/{revisionId}, including the file snapshot when one exists. */
export async function getSkillRevision(name: string, revisionId: string): Promise<SkillRevision> {
  const response = await requestJson<ApiEnvelope<SkillRevision>>(
    `/skills/${encodeURIComponent(name)}/revisions/${encodeURIComponent(revisionId)}`,
  );
  return response.data;
}

/**
 * POST /api/v1/skills/{name}/restore. Only offer this for a revision with
 * `has_snapshot: true`; restoring one without a snapshot returns 400.
 */
export async function restoreSkill(
  name: string,
  revisionId: string,
): Promise<{ revision_id: string; revision: number }> {
  const response = await command<{ revision_id: string; revision: number }>(
    `/skills/${encodeURIComponent(name)}/restore`,
    { revision_id: revisionId },
    0,
    'POST',
  );
  return response.data;
}

/** PATCH /api/v1/skills/{name}. `patch` must set at least one of `state`/`scope`. */
export async function updateSkill(
  name: string,
  patch: { state?: SkillState; scope?: string },
  expectedVersion = 0,
): Promise<SkillRecord> {
  const response = await command<SkillRecord>(`/skills/${encodeURIComponent(name)}`, patch, expectedVersion, 'PATCH');
  return response.data;
}

/** GET /api/v1/skill-proposals. */
export async function listSkillProposals(status?: SkillProposalStatus): Promise<SkillProposal[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const response = await requestJson<ApiEnvelope<SkillProposal[]>>(`/skill-proposals${qs}`);
  return response.data;
}

/**
 * POST /api/v1/skill-proposals/{id}/approve. The outcome is not always
 * "applied": the Curator can reject the proposal while writing it, or the
 * written result can touch scripts/ and need another approval pass. 409
 * (`invalid_state_transition`, e.g. the skill changed since the proposal was
 * read) and 503 (`dependency_unavailable`, no Curator runner) surface as an
 * ApiRequestError for the caller to show.
 */
export async function approveSkillProposal(proposalId: string): Promise<SkillProposalCommandResult> {
  const response = await command<SkillProposalCommandResult>(
    `/skill-proposals/${encodeURIComponent(proposalId)}/approve`,
    {},
    0,
    'POST',
  );
  return response.data;
}

/** POST /api/v1/skill-proposals/{id}/reject. */
export async function rejectSkillProposal(proposalId: string): Promise<SkillProposalCommandResult> {
  const response = await command<SkillProposalCommandResult>(
    `/skill-proposals/${encodeURIComponent(proposalId)}/reject`,
    {},
    0,
    'POST',
  );
  return response.data;
}

/** GET /api/v1/rule-proposals. */
export async function listRuleProposals(status?: RuleProposalStatus): Promise<RuleProposal[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const response = await requestJson<ApiEnvelope<RuleProposal[]>>(`/rule-proposals${qs}`);
  return response.data;
}

/** POST /api/v1/rule-proposals/{id}/approve. */
export async function approveRuleProposal(proposalId: string): Promise<RuleProposalCommandResult> {
  const response = await command<RuleProposalCommandResult>(
    `/rule-proposals/${encodeURIComponent(proposalId)}/approve`,
    {},
    0,
    'POST',
  );
  return response.data;
}

/** POST /api/v1/rule-proposals/{id}/reject. */
export async function rejectRuleProposal(proposalId: string): Promise<RuleProposalCommandResult> {
  const response = await command<RuleProposalCommandResult>(
    `/rule-proposals/${encodeURIComponent(proposalId)}/reject`,
    {},
    0,
    'POST',
  );
  return response.data;
}

/** POST /api/v1/rule-proposals from a knowledge note claim. */
export async function createRuleProposalFromNote(input: {
  note_id: string;
  claim_fingerprint: string;
  level: 'system' | 'role';
  role?: RuleProposalRole;
  text?: string;
}): Promise<RuleProposalCreateResult> {
  const response = await command<RuleProposalCreateResult>('/rule-proposals', input, 0, 'POST');
  return response.data;
}

/** GET /api/v1/skill-activity. Counts of Curator actions over the trailing `days` window (default 7). */
export async function getSkillActivity(days = 7): Promise<SkillActivity> {
  const response = await requestJson<{ request_id: string; data: SkillActivity }>(`/skill-activity?days=${days}`);
  return response.data;
}

/** GET /api/v1/settings/skills. */
export async function getSkillSettings(): Promise<{ settings: SkillSettings; version: number }> {
  const response = await requestJson<ApiEnvelope<SkillSettings>>('/settings/skills');
  // The GET response carries no version; the PUT still needs a valid expected_version.
  return { settings: response.data, version: response.version ?? 0 };
}

/** PUT /api/v1/settings/skills. */
export async function setSkillSettings(
  settings: SkillSettings,
  expectedVersion: number,
): Promise<{ settings: SkillSettings; version: number }> {
  const response = await command<SkillSettings>('/settings/skills', settings, expectedVersion ?? 0, 'PUT');
  return { settings: response.data, version: response.version ?? 0 };
}

/** GET /api/v1/settings/process-skills. */
export async function getProcessSkillsSettings(): Promise<ProcessSkillsSettingsData> {
  const response = await requestJson<ApiEnvelope<ProcessSkillsSettingsData>>('/settings/process-skills');
  return response.data;
}

/** PUT /api/v1/settings/process-skills. The server does not version this setting (version is always 0). */
export async function setProcessSkillsSettings(input: {
  enabled: boolean;
  path: string | null;
}): Promise<ProcessSkillsSettingsData> {
  const response = await command<ProcessSkillsSettingsData>('/settings/process-skills', input, 0, 'PUT');
  return response.data;
}

/** GET /api/v1/settings/knowledge-automation. */
export async function getKnowledgeAutomationSettings(): Promise<KnowledgeAutomationSettingsData> {
  const response = await requestJson<ApiEnvelope<KnowledgeAutomationSettingsData>>('/settings/knowledge-automation');
  return response.data;
}

/** PUT /api/v1/settings/knowledge-automation. The server does not version this setting (version is always 0). */
export async function setKnowledgeAutomationSettings(
  input: KnowledgeAutomationSettingsInput,
): Promise<KnowledgeAutomationSettingsData> {
  const response = await command<KnowledgeAutomationSettingsData>('/settings/knowledge-automation', input, 0, 'PUT');
  return response.data;
}

// Fetch runtime configuration as soon as the client bundle starts. The
// promise is shared by every API call, so this does not add duplicate requests.
if (typeof window !== 'undefined') {
  void getRuntimeConfig().catch((error) => {
    console.error('[Owl] runtime-config preload failed', error);
  });
}
