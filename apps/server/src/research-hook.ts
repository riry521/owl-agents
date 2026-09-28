import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { GUARD_TOKEN_FILE_ENV } from "../../../packages/shared/dist/guard-token.js";
import { hasAuthPasswordForm } from "../../../packages/shared/dist/index.js";

interface ResearchHookInput {
  readonly hook_event_name?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let input: ResearchHookInput;
  try {
    const parsed: unknown = JSON.parse(await readStdin());
    if (!isRecord(parsed)) return;
    input = parsed as ResearchHookInput;
  } catch {
    return;
  }
  if (input.hook_event_name !== "PostToolUse"
    || (input.tool_name !== "WebFetch" && input.tool_name !== "WebSearch")
    || !isRecord(input.tool_input)) return;

  const apiBase = process.env.OWL_GUARD_API_BASE;
  const tokenFile = process.env[GUARD_TOKEN_FILE_ENV];
  if (!process.env.OWL_AGENT_ROLE || !apiBase || !tokenFile || !isAbsolute(tokenFile)) return;

  let guardToken: string;
  try {
    guardToken = (await readFile(tokenFile, "utf8")).trim();
  } catch {
    return;
  }
  if (!guardToken) return;

  const responseText = typeof input.tool_response === "string"
    ? input.tool_response
    : isRecord(input.tool_response) && typeof input.tool_response.result === "string"
      ? input.tool_response.result
      : null;
  const authFormDetected = input.tool_name === "WebFetch"
    && responseText !== null
    && hasAuthPasswordForm(responseText);
  let toolResponse = input.tool_response;
  if (isRecord(toolResponse) && typeof toolResponse.result === "string" && toolResponse.result.length > 262_144) {
    toolResponse = { ...toolResponse, result: toolResponse.result.slice(0, 262_144) };
  }
  const body = JSON.stringify({
    request_id: randomUUID(),
    idempotency_key: randomUUID(),
    expected_version: 0,
    payload: {
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      tool_response: toolResponse,
      ...(authFormDetected ? { auth_form_detected: true } : {}),
    },
  });
  if (Buffer.byteLength(body, "utf8") > 1_000_000) return;

  try {
    await fetch(`${apiBase.replace(/\/$/u, "")}/api/v1/research/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${guardToken}` },
      body,
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // PostToolUse is observational; capture failures must not affect the agent.
  }
}

void main().catch(() => undefined).finally(() => process.exit(0));
