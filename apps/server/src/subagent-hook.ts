import { randomUUID } from "node:crypto";
import { readStdin } from "./stdio-jsonrpc.js";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

import { guardConfig, guardHasToken, guardRequest, trimOneSlash } from "./guard-client.js";
import { RequestUsageTracker, SUBAGENT_USAGE_BATCH_MAX, type RequestTokenUsage } from "@owl/shared/token-relay";
import { isRecord } from "@owl/shared/small-helpers";

const MAX_FIELD_LENGTH = 200;
const EVENTS: Record<string, "start" | "stop"> = { SubagentStart: "start", SubagentStop: "stop" };

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

  const guard = guardConfig({ roleVar: "OWL_AGENT_ROLE", absoluteTokenFile: true });
  if (!guard || !await guardHasToken(guard)) return;

  const agentType = typeof input.agent_type === "string" && input.agent_type
    ? input.agent_type.slice(0, MAX_FIELD_LENGTH)
    : undefined;
  const agentId = input.agent_id.slice(0, MAX_FIELD_LENGTH);
  const post = async (payload: Record<string, unknown>): Promise<void> => {
    try {
      await guardRequest(guard, "/api/v1/subagents/hook-event", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: randomUUID(), idempotency_key: randomUUID(), expected_version: 0, payload }),
        timeoutMs: 3000,
        normalizeBase: trimOneSlash,
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
