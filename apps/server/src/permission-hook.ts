import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { guardChecksToolCall } from "../../../packages/shared/dist/guard-inputs.js";
import { GUARD_TOKEN_FILE_ENV } from "../../../packages/shared/dist/guard-token.js";

interface HookInput {
  readonly hook_event_name?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly cwd?: unknown;
}

interface GuardResponse {
  readonly data?: {
    readonly allowed?: unknown;
    readonly message?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deny(reason: string): void {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    const parsed: unknown = JSON.parse(await readStdin());
    if (!isRecord(parsed)) throw new Error("hook input is not an object");
    input = parsed as HookInput;
  } catch {
    deny("Tool execution was denied because the PreToolUse input could not be parsed.");
    return;
  }

  if (input.hook_event_name !== "PreToolUse") {
    deny("Only PreToolUse events are allowed.");
    return;
  }
  if (typeof input.tool_name !== "string" || input.tool_name.length === 0 || !isRecord(input.tool_input)) {
    deny("Tool execution was denied because the tool name or input could not be determined.");
    return;
  }
  // A call with no path or command arguments has nothing the rules can
  // match, so it runs without asking the guard (MCP and web tools mostly).
  if (!guardChecksToolCall(input.tool_name, input.tool_input)) return;

  const role = process.env.OWL_AGENT_ROLE;
  const apiBase = process.env.OWL_GUARD_API_BASE;
  const tokenFile = process.env[GUARD_TOKEN_FILE_ENV];
  if (!role || !apiBase || !tokenFile || !isAbsolute(tokenFile)) {
    deny("Tool execution was denied because the Owl guard configuration is unavailable.");
    return;
  }
  let guardToken: string;
  try {
    guardToken = (await readFile(tokenFile, "utf8")).trim();
  } catch {
    guardToken = "";
  }
  if (guardToken.length === 0) {
    deny("Tool execution was denied because the Owl guard token could not be read.");
    return;
  }
  const cwd = typeof input.cwd === "string" && isAbsolute(input.cwd)
    ? input.cwd
    : process.env.OWL_AGENT_CWD;
  if (!cwd || !isAbsolute(cwd)) {
    deny("Tool execution was denied because the working directory could not be determined.");
    return;
  }

  const endpoint = `${apiBase.replace(/\/$/u, "")}/api/v1/guard/check`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${guardToken}`,
      },
      body: JSON.stringify({
        request_id: randomUUID(),
        idempotency_key: randomUUID(),
        expected_version: 0,
        payload: {
          role,
          tool_name: input.tool_name,
          tool_input: input.tool_input,
          cwd,
        },
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      deny(`Tool execution was denied because Owl guard returned HTTP ${response.status}.`);
      return;
    }
    const body: unknown = await response.json();
    const result = isRecord(body) && isRecord(body.data) ? body.data as GuardResponse["data"] : undefined;
    if (result?.allowed === true) return;
    const message = typeof result?.message === "string" && result.message.length > 0
      ? result.message
      : "Tool execution was denied because Owl guard did not grant permission.";
    deny(message);
  } catch {
    deny("Tool execution was denied because Owl guard could not be reached.");
  }
}

void main().catch(() => {
  deny("Tool execution was denied because Owl guard could not make a decision.");
});
