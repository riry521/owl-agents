import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { GUARD_TOKEN_FILE_ENV } from "../../../packages/shared/dist/guard-token.js";

const MAX_FIELD_LENGTH = 200;
const EVENTS: Record<string, "start" | "stop"> = { SubagentStart: "start", SubagentStop: "stop" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readStdin());
    if (!isRecord(parsed)) return;
    input = parsed;
  } catch {
    return;
  }
  const name = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const event = Object.hasOwn(EVENTS, name) ? EVENTS[name] : undefined;
  if (!event || typeof input.agent_id !== "string" || !input.agent_id) return;

  const apiBase = process.env.OWL_GUARD_API_BASE;
  const tokenFile = process.env[GUARD_TOKEN_FILE_ENV];
  if (!apiBase || !tokenFile || !isAbsolute(tokenFile)) return;
  let guardToken: string;
  try {
    guardToken = (await readFile(tokenFile, "utf8")).trim();
  } catch {
    return;
  }
  if (!guardToken) return;

  const agentType = typeof input.agent_type === "string" && input.agent_type
    ? input.agent_type.slice(0, MAX_FIELD_LENGTH)
    : undefined;
  try {
    await fetch(`${apiBase.replace(/\/$/u, "")}/api/v1/subagents/hook-event`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${guardToken}` },
      body: JSON.stringify({
        request_id: randomUUID(),
        idempotency_key: randomUUID(),
        expected_version: 0,
        payload: {
          event,
          agent_id: input.agent_id.slice(0, MAX_FIELD_LENGTH),
          ...(agentType ? { agent_type: agentType } : {}),
        },
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Notification only; failures must not affect the agent.
  }
}

void main().catch(() => undefined).finally(() => process.exit(0));
