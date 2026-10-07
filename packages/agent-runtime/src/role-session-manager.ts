import { CODEX_PROVIDER_BASE_URL_ENV, type PromptFingerprint, type PromptMode } from "@owl/shared";
import { extractProviderUsage, isRecord } from "./protocol";
import { extractRoleOutputObject, splitRolePrompt } from "./role-contract";
import { promptFingerprint } from "./prompt-fingerprint";
import type { ProviderExecutionRequest, ProviderResponse } from "./types";

const MAX_ROLE_SESSIONS = 256;

interface RolePromptSnapshot {
  readonly header: string;
  readonly inputs: Record<string, unknown>;
  readonly shape: string;
}

interface RoleSessionEntry {
  readonly id: string;
  readonly settings: string;
  readonly snapshot: RolePromptSnapshot | null;
  readonly handoff: string;
  readonly contextTokens: number | null;
  readonly invocationId: string;
  readonly rejected: string | null;
}

function setRoleField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function changedRoleFields(current: Record<string, unknown>, previous: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      setRoleField(changed, key, null);
    } else if (!Object.prototype.hasOwnProperty.call(previous, key)) {
      setRoleField(changed, key, current[key]);
    } else if (isRecord(current[key]) && isRecord(previous[key])) {
      const nested = changedRoleFields(current[key] as Record<string, unknown>, previous[key] as Record<string, unknown>);
      if (Object.keys(nested).length > 0) setRoleField(changed, key, nested);
    } else if (JSON.stringify(current[key]) !== JSON.stringify(previous[key])) {
      setRoleField(changed, key, current[key]);
    }
  }
  return changed;
}

function roleFollowupPrompt(
  role: ProviderExecutionRequest["role"],
  current: RolePromptSnapshot,
  previous: RoleSessionEntry,
): string {
  const changedInput = changedRoleFields(current.inputs, previous.snapshot?.inputs ?? {});
  return [
    `Continue as the Owl ${role} for this Task. Earlier instructions and unchanged input still apply.`,
    "Apply only the changed fields; missing fields are unchanged and null means removed.",
    "Inspect affected files and return exactly one JSON object matching the enforced schema.",
    ...(previous.rejected ? [`The previous answer was rejected for ${previous.rejected}; return a corrected answer.`] : []),
    `Changed input:\n${JSON.stringify(changedInput)}`,
  ].join("\n\n");
}

function rolePromptWithHandoff(prompt: string, role: ProviderExecutionRequest["role"], previous: RoleSessionEntry): string {
  const rejection = previous.rejected
    ? `\n\nThe previous ${role} answer was rejected for ${previous.rejected}; do not treat it as valid.`
    : "";
  return `${prompt}\n\nPrevious ${role} answer handoff:\n${previous.handoff}${rejection}`;
}

function compactRoleHandoff(response: ProviderResponse): string {
  try {
    return JSON.stringify(extractRoleOutputObject(response, "handoff_invalid")).slice(0, 4_000);
  } catch {
    return "Previous provider answer was unavailable; inspect the current Task and affected files.";
  }
}

const CODEX_TOOL_ITEM_TYPES = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

function providerModelCalls(response: ProviderResponse, codex: boolean): number | null {
  try {
    if (!codex) {
      const wrapper: unknown = JSON.parse(response.stdout);
      return isRecord(wrapper) && typeof wrapper.num_turns === "number" ? wrapper.num_turns : null;
    }
    let calls = 1;
    for (const line of response.stdout.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (isRecord(event) && event.type === "item.completed" && isRecord(event.item) &&
        typeof event.item.type === "string" && CODEX_TOOL_ITEM_TYPES.has(event.item.type)) calls += 1;
    }
    return calls;
  } catch {
    return null;
  }
}

/**
 * Provider usage is cumulative over every model call in a run, so the final
 * context size is estimated from the per-call average under linear growth.
 */
function contextTokenCount(response: ProviderResponse): number | null {
  const usage = extractProviderUsage(response);
  if (!usage) return null;
  const codex = response.adapter === "codex" || response.adapter.startsWith("codex");
  const calls = providerModelCalls(response, codex);
  if (calls === null || calls < 1) return null;
  const total = codex
    ? (usage.input_tokens ?? 0)
    : (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
  return Math.round((2 * total) / calls);
}


export interface RoleSessionManagerOptions {
  /** Runs one provider call. */
  execute: (request: ProviderExecutionRequest) => Promise<ProviderResponse>;
  /** Context-token limit for keeping a session, per role. */
  contextLimit: (role: ProviderExecutionRequest["role"]) => number;
  /** True once the invocation has had an external side effect (a rejected resume is then not retried). */
  hasSideEffect: (invocationId: string) => boolean;
  /** Called once per provider call with the fingerprint of the full logical prompt. */
  onPrompt?: (invocationId: string, record: { fingerprint: PromptFingerprint; mode: PromptMode }) => void;
}

/** Owns resume, delta, handoff, context limit and report resubmission for role provider calls. */
export class RoleSessionManager {
  private readonly sessions = new Map<string, RoleSessionEntry>();
  private readonly inFlight = new Map<string, number>();

  public constructor(private readonly options: RoleSessionManagerOptions) {}

  private enter(key: string): boolean {
    const already = this.inFlight.has(key);
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    return already;
  }

  private leave(key: string): void {
    const count = (this.inFlight.get(key) ?? 1) - 1;
    if (count === 0) {
      this.inFlight.delete(key);
    } else {
      this.inFlight.set(key, count);
    }
  }

  private save(
    key: string,
    request: ProviderExecutionRequest,
    settings: string,
    snapshot: RolePromptSnapshot | null,
    response: ProviderResponse,
    resumedSessionId?: string,
  ): void {
    const id = response.provider_session_id ?? resumedSessionId;
    if (response.exit_code === 0 && response.signal === null && id) {
      this.sessions.delete(key);
      this.sessions.set(key, {
        id,
        settings,
        snapshot,
        handoff: compactRoleHandoff(response),
        contextTokens: contextTokenCount(response),
        invocationId: request.invocation_id,
        rejected: null,
      });
      if (this.sessions.size > MAX_ROLE_SESSIONS) {
        const oldestKey = this.sessions.keys().next().value;
        if (oldestKey !== undefined) this.sessions.delete(oldestKey);
      }
    } else {
      this.sessions.delete(key);
    }
  }

  /** Records how the logical full prompt was sent; the hashes always come from the full prompt, not a delta. */
  private notify(request: ProviderExecutionRequest, mode: PromptMode): void {
    if (!this.options.onPrompt || !request.invocation_id) return;
    try {
      const fingerprint = promptFingerprint(request.prompt);
      if (fingerprint) this.options.onPrompt(request.invocation_id, { fingerprint, mode });
    } catch (error) {
      console.error(`[agent-runtime] Prompt observer failed for ${request.invocation_id}`, error);
    }
  }

  /** Marks the session that produced invocationId as rejected (invalid output). */
  public markRejected(invocationId: string, rejected: string): void {
    for (const [key, entry] of [...this.sessions]) {
      if (entry.invocationId !== invocationId) continue;
      this.sessions.delete(key);
      this.sessions.set(key, { ...entry, rejected });
    }
  }

  /** Resume / delta / handoff / rejected-resume retry / reviewer fresh + handoff. */
  public async run(request: ProviderExecutionRequest): Promise<ProviderResponse> {
    const { execute } = this.options;
    if (!request.workspace_id || request.role === "advisor" || request.role === "curator" || request.role === "librarian") {
      this.notify(request, "fresh");
      return execute(request);
    }

    const key = `${request.workspace_id}\u0000${request.role}\u0000${request.cwd}`;
    if (this.enter(key)) {
      try {
        this.notify(request, "fresh");
        return await execute(request);
      } finally {
        this.leave(key);
      }
    }

    try {
      const settings = JSON.stringify([
        request.adapter,
        request.model,
        request.effort,
        request.cwd,
        request.env.ANTHROPIC_BASE_URL,
        request.env[CODEX_PROVIDER_BASE_URL_ENV],
      ]);
      const prior = this.sessions.get(key);
      const snapshot = splitRolePrompt(request.prompt);

      if (request.role === "reviewer") {
        this.notify(request, prior ? "handoff" : "fresh");
        const response = await execute(prior
          ? { ...request, prompt: rolePromptWithHandoff(request.prompt, request.role, prior) }
          : request);
        this.save(key, request, settings, snapshot, response);
        return response;
      }

      const compatible = prior && prior.settings === settings && prior.snapshot !== null && snapshot !== null &&
        prior.snapshot.header === snapshot.header && prior.snapshot.shape === snapshot.shape &&
        (prior.contextTokens === null || prior.contextTokens <= this.options.contextLimit(request.role))
        ? prior
        : undefined;
      const prompt = compatible && snapshot
        ? roleFollowupPrompt(request.role, snapshot, compatible)
        : prior
          ? rolePromptWithHandoff(request.prompt, request.role, prior)
          : request.prompt;
      const runRequest = (sessionId?: string): ProviderExecutionRequest => ({
        ...request,
        prompt,
        ...(sessionId ? { provider_session_id: sessionId } : {}),
      });

      this.notify(request, compatible ? "resumed" : prior ? "handoff" : "fresh");
      let response = await execute(runRequest(compatible?.id));
      let resumedSessionId = compatible?.id;
      if (compatible && response.exit_code !== 0 && response.signal === null && !response.provider_session_id && !this.options.hasSideEffect(request.invocation_id)) {
        this.sessions.delete(key);
        resumedSessionId = undefined;
        this.notify(request, "handoff");
        response = await execute({
          ...request,
          prompt: rolePromptWithHandoff(request.prompt, request.role, compatible),
        });
      }

      this.save(key, request, settings, snapshot, response, resumedSessionId);
      return response;
    } catch (error) {
      this.sessions.delete(key);
      throw error;
    } finally {
      this.leave(key);
    }
  }

  /** Resumes `sessionId` and asks for the answer only; recorded as a report_resubmit prompt. */
  public resubmit(
    request: ProviderExecutionRequest,
    sessionId: string,
    prompt: string,
    execute: (request: ProviderExecutionRequest) => Promise<ProviderResponse> = this.options.execute,
  ): Promise<ProviderResponse> {
    this.notify(request, "report_resubmit");
    return execute({ ...request, prompt, provider_session_id: sessionId });
  }
}
