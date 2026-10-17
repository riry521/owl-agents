import { spawn, type ChildProcess } from "node:child_process";
import { OPENCODE_TOOL_LOOKUP_WAIT_MS, PRE_TOOL_USE_HOOK_TIMEOUT_MS, normalizeOpencodeToolCall, permissionHookCommand } from "@owl/shared";
import type { OpencodeClient } from "./opencode-client";

/** Operations the rules deny; an ask for one of them means the rules were changed, so it is refused. */
const DENIED_ACTIONS = new Set(["question", "subagent", "skill", "execute"]);

export type OpencodePermissionDecision = { readonly decision: "once" } | { readonly decision: "reject"; readonly message: string };

interface ToolRecord {
  name?: string;
  input?: Record<string, unknown>;
}

export interface OpencodePermissionResponderOptions {
  readonly client: OpencodeClient;
  readonly owlRoot: string;
  /** The run's cwd; passed to the hook unless a shell call names its own workdir. */
  readonly cwd: string;
  /** The run's env (OWL_AGENT_ROLE, OWL_GUARD_API_BASE, OWL_GUARD_TOKEN_FILE, ...); the hook runs with it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hookTimeoutMs?: number;
  readonly toolLookupWaitMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const reject = (message: string): OpencodePermissionDecision => ({ decision: "reject", message });

/** Runs the hook as a process. Only an exit code 0 with no output allows; anything unreadable or late rejects. */
function runHook(owlRoot: string, cwd: string, stdin: string, env: Readonly<Record<string, string | undefined>>, timeoutMs: number): Promise<OpencodePermissionDecision> {
  return new Promise((resolve) => {
    let hook: ReturnType<typeof permissionHookCommand>;
    try {
      hook = permissionHookCommand(owlRoot);
    } catch (error) {
      return resolve(reject(error instanceof Error ? error.message : String(error)));
    }
    const child = spawn(hook.executable, [hook.script], {
      cwd,
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    }) as unknown as ChildProcess;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(reject(`Tool execution was denied because the Owl hook did not finish within ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stderr!.resume();
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdin!.on("error", () => undefined);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(reject("Tool execution was denied because the Owl hook could not be started."));
    });
    child.once("close", (code: number | null) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks).toString("utf8").trim();
      if (code === 0 && out.length === 0) return resolve({ decision: "once" });
      try {
        const parsed: unknown = JSON.parse(out);
        const output = isRecord(parsed) && isRecord(parsed.hookSpecificOutput) ? parsed.hookSpecificOutput : null;
        if (output?.permissionDecision === "deny") {
          const reason = output.permissionDecisionReason;
          return resolve(reject(typeof reason === "string" && reason.length > 0 ? reason : "Tool execution was denied by the Owl hook."));
        }
      } catch {
        // Falls through to the unreadable-output rejection.
      }
      resolve(reject("Tool execution was denied because the Owl hook output could not be read."));
    });
    child.stdin!.end(stdin);
  });
}

/** Answers `permission.asked` with the verdict of Owl's PreToolUse hook; every failure on the way rejects. */
export class OpencodePermissionResponder {
  /** Tool call ids that were answered once; a success for any other hooked call is a bypass. */
  private readonly onceIds = new Set<string>();
  private readonly sentRequestIds = new Set<string>();
  private readonly tools = new Map<string, ToolRecord>();
  private readonly toolWaiters = new Map<string, (() => void)[]>();
  /** One hook run per tool call id: external_directory and the tool itself ask separately. */
  private readonly decisions = new Map<string, Promise<OpencodePermissionDecision>>();

  public constructor(private readonly options: OpencodePermissionResponderOptions) {}

  public noteTool(id: string, patch: ToolRecord): void {
    this.tools.set(id, { ...this.tools.get(id), ...patch });
    for (const wake of this.toolWaiters.get(id)?.splice(0) ?? []) wake();
  }

  public toolName(id: string): string | undefined {
    return this.tools.get(id)?.name;
  }

  public wasAnsweredOnce(toolCallId: string): boolean {
    return this.onceIds.has(toolCallId);
  }

  /** True when this driver sent the reply for the request (permission.replied from anyone else is unexpected). */
  public wasSent(requestId: string): boolean {
    return this.sentRequestIds.has(requestId);
  }

  /** `signal` stops the waits for serve (the tool's message and the reply); the hook is bounded by its own timeout. */
  public async handleAsked(data: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const decision = await this.decide(data, signal);
    const requestId = String(data.id);
    const source = isRecord(data.source) ? data.source : null;
    // Recorded before the reply goes out so the tool's success and the replied event cannot overtake it.
    this.sentRequestIds.add(requestId);
    if (decision.decision === "once" && typeof source?.id === "string") this.onceIds.add(source.id);
    await this.options.client.request("POST", `/api/session/${String(data.sessionID)}/permission/${requestId}/reply`, decision, signal);
  }

  private async decide(data: Record<string, unknown>, signal?: AbortSignal): Promise<OpencodePermissionDecision> {
    const source = isRecord(data.source) ? data.source : null;
    if (!source || source.type !== "tool" || typeof source.id !== "string") return reject("Tool execution was denied because the permission request names no tool call.");
    if (typeof data.action === "string" && DENIED_ACTIONS.has(data.action)) return reject(`Tool execution was denied because ${data.action} is not allowed.`);
    let decision = this.decisions.get(source.id);
    if (!decision) {
      decision = this.evaluate(String(data.sessionID), source.id, typeof source.messageID === "string" ? source.messageID : null, signal).catch(() => reject("Tool execution was denied because the Owl hook could not make a decision."));
      this.decisions.set(source.id, decision);
    }
    return decision;
  }

  private async evaluate(sessionId: string, toolCallId: string, messageId: string | null, signal?: AbortSignal): Promise<OpencodePermissionDecision> {
    const tool = await this.lookupTool(sessionId, toolCallId, messageId, signal);
    if (!tool?.name) return reject("Tool execution was denied because the tool call could not be determined.");
    const call = normalizeOpencodeToolCall(tool.name, tool.input ?? {}, this.options.cwd);
    const stdin = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: call.tool_name, tool_input: call.tool_input, cwd: call.cwd });
    return runHook(this.options.owlRoot, call.cwd, stdin, this.options.env, this.options.hookTimeoutMs ?? PRE_TOOL_USE_HOOK_TIMEOUT_MS);
  }

  /** The remembered call, else a short wait for its events, else the message that holds it. */
  private async lookupTool(sessionId: string, toolCallId: string, messageId: string | null, signal?: AbortSignal): Promise<ToolRecord | null> {
    const known = (): ToolRecord | null => {
      const record = this.tools.get(toolCallId);
      return record?.name && record.input ? record : null;
    };
    if (known()) return known();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.options.toolLookupWaitMs ?? OPENCODE_TOOL_LOOKUP_WAIT_MS);
      this.toolWaiters.set(toolCallId, [...(this.toolWaiters.get(toolCallId) ?? []), () => {
        if (!known()) return;
        clearTimeout(timer);
        resolve();
      }]);
    });
    if (known()) return known();
    if (!messageId) return null;
    const response = await this.options.client.request<{ data?: { content?: unknown } }>("GET", `/api/session/${sessionId}/message/${messageId}`, undefined, signal);
    const content = Array.isArray(response.data?.content) ? response.data.content : [];
    const part = content.find((item) => isRecord(item) && item.type === "tool" && item.id === toolCallId);
    return isRecord(part) && typeof part.name === "string" && isRecord(part.input) ? { name: part.name, input: part.input } : null;
  }
}
