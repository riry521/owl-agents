import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

import { GUARD_TOKEN_FILE_ENV } from "../../../packages/shared/dist/guard-token.js";
import { RequestUsageTracker, SUBAGENT_USAGE_BATCH_MAX, type RequestTokenUsage } from "../../../packages/shared/dist/token-relay.js";

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

/** One entry per request id in the subagent transcript; an unreadable file or a broken line is skipped. */
async function transcriptUsage(path: string): Promise<RequestTokenUsage[]> {
  const requests: RequestTokenUsage[] = [];
  const tracker = new RequestUsageTracker({ onFlush: (usage) => requests.push(usage) });
  try {
    for await (const line of createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) tracker.accept(parsed);
      } catch {
        // A broken line loses only that line.
      }
    }
  } catch {
    // Missing or unreadable transcript: keep what was read.
  }
  tracker.flush();
  return requests;
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
  const agentId = input.agent_id.slice(0, MAX_FIELD_LENGTH);
  const post = async (payload: Record<string, unknown>): Promise<void> => {
    try {
      await fetch(`${apiBase.replace(/\/$/u, "")}/api/v1/subagents/hook-event`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${guardToken}` },
        body: JSON.stringify({ request_id: randomUUID(), idempotency_key: randomUUID(), expected_version: 0, payload }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Notification only; failures must not affect the agent.
    }
  };
  // Stop goes first so the observed child is closed even if reading the transcript outlasts the hook timeout.
  await post({ event, agent_id: agentId, ...(agentType ? { agent_type: agentType } : {}) });

  const transcript = input.agent_transcript_path;
  if (event !== "stop" || typeof transcript !== "string" || !isAbsolute(transcript) || !transcript.endsWith(".jsonl")) return;
  // Ids and counts only: the transcript's text never leaves this process.
  const requests = (await transcriptUsage(transcript))
    .filter((usage) => usage.model.length > 0)
    .map((usage) => ({
      message_id: usage.message_id.slice(0, MAX_FIELD_LENGTH),
      model: usage.model.slice(0, MAX_FIELD_LENGTH),
      input_tokens: usage.input_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      output_tokens: usage.output_tokens,
      created_at: usage.created_at,
    }));
  for (let start = 0; start < requests.length; start += SUBAGENT_USAGE_BATCH_MAX) {
    await post({ event: "usage", agent_id: agentId, requests: requests.slice(start, start + SUBAGENT_USAGE_BATCH_MAX) });
  }
}

void main().catch(() => undefined).finally(() => process.exit(0));
