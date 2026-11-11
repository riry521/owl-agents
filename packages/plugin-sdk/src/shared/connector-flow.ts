import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatIntegrationError } from "../error-display";
import type { CoreClient } from "../client";
import type { OwlEvent } from "../types";
import { formatAdvisorReply } from "./advisor-reply";
import { asRecord, fetchAdvisorReply, formatBytes } from "./connector-common";
import { submitDecisionAnswer } from "./decision-answer";
import { resolveDecisionButtonTarget, type DecisionButtonTarget } from "./decision-button";
import { classifyIntent, decisionShortId, type PendingDecision, type RoutedMessage } from "./router";
import { formatStatusResponse } from "./status";
import { uploadAttachment, type UploadAttachmentRequest } from "./uploads";
import { connectorText, type ConnectorText } from "./connector-text";
import type { OwlLanguage } from "./language";
import {
  appendFileResults,
  parseDeliveryTarget,
  parseOutboundFiles,
  readOutboundFile,
  reportAdvisorDelivery,
  type OutboundFile,
  type OutboundFileResult,
} from "./outbound-files";

/** Reads the Advisor channels bound to `provider`; keeps `current` when Core cannot be read, so the next binding event reads it again. */
export async function refreshBoundChannels(core: CoreClient, provider: string, current: ReadonlySet<string>): Promise<ReadonlySet<string>> {
  try {
    const data = await core.request<{ bindings: Array<{ channel_id: string }> }>(`/advisor/channel-bindings?provider=${provider}`);
    return new Set(data.bindings.map((binding) => binding.channel_id));
  } catch (error) {
    console.error(`[${provider}] Could not read the Advisor channel bindings:`, error);
    return current;
  }
}

/** Routes one Core event: binding changes, Advisor replies, then service notifications. */
export async function dispatchCoreEvent(event: OwlEvent, handlers: {
  readonly refreshBindings: () => Promise<void>;
  readonly advisorResponse: (event: OwlEvent) => Promise<void>;
  readonly shouldNotify: (type: string, payload: Record<string, unknown>) => boolean;
  readonly notify: (event: OwlEvent) => Promise<void>;
}): Promise<void> {
  if (event.type === "advisor.channel_binding_changed") return handlers.refreshBindings();
  if (event.type === "advisor.responded") return handlers.advisorResponse(event);
  if (!handlers.shouldNotify(event.type, event.payload)) return;
  await handlers.notify(event);
}

/** True when the Advisor reply came from `provider` and the caller should answer in the channel; a Web-origin reply aimed at `provider` is handed to `deliverFiles`. */
export async function routeAdvisorOrigin(event: OwlEvent, provider: string, deliverFiles: (channelId: string) => Promise<void>): Promise<boolean> {
  const origin = asRecord(event.payload.origin);
  if (origin?.channel === provider) return true;
  const target = parseDeliveryTarget(event);
  if (origin?.channel === "web" && target?.provider === provider) await deliverFiles(target.channel_id);
  return false;
}

export type UploadFailure = Required<Pick<OutboundFileResult, "outcome" | "code" | "platform_error">>;

/** Sends each file through `send`; one failed file never stops the rest. `language` is passed in so a reply asks Core for it once. */
export async function sendOutboundFiles(files: readonly OutboundFile[], language: OwlLanguage, service: {
  readonly label: string;
  readonly send: (file: OutboundFile, bytes: Buffer) => Promise<void>;
  readonly classifyError: (error: unknown) => UploadFailure;
  readonly hint: (error: unknown, t: ConnectorText) => string;
}): Promise<{ lines: string[]; results: OutboundFileResult[] }> {
  const t = connectorText(language);
  const lines: string[] = [];
  const results: OutboundFileResult[] = [];
  for (const file of files) {
    const index = file.index ?? -1;
    const read = await readOutboundFile(file);
    if (!read.ok) {
      const message = t.fileSendFailed(file.name, read.reason === "changed" ? t.fileSendChanged : t.fileSendUnreadable, "");
      lines.push(message);
      results.push({ index, outcome: "failed", code: read.reason, platform_error: null, message });
      continue;
    }
    try {
      await service.send(file, read.bytes);
      lines.push(t.fileSent(file.name, formatBytes(file.size)));
      results.push({ index, outcome: "sent" });
    } catch (error) {
      const message = t.fileSendFailed(file.name, formatIntegrationError(service.label, error, language), service.hint(error, t));
      lines.push(message);
      results.push({ index, message, ...service.classifyError(error) });
    }
  }
  return { lines, results };
}

/** Web-origin files go to the channel `resolveChannel` finds; the reply text stays in the Web chat. */
export async function deliverFilesToChannel<C>(core: CoreClient, event: OwlEvent, flow: {
  readonly resolveChannel: () => Promise<C | null>;
  readonly notAllowedMessage: string;
  readonly upload: (channel: C, files: readonly OutboundFile[], language: OwlLanguage) => Promise<{ results: OutboundFileResult[] }>;
  readonly onError: (error: unknown) => Promise<void>;
}): Promise<void> {
  const files = parseOutboundFiles(event.payload.outbound_files);
  const channel = await flow.resolveChannel();
  if (channel === null) {
    await reportAdvisorDelivery(core, event, files.map((file) => ({
      index: file.index ?? -1, outcome: "failed", code: "upload_rejected", platform_error: null, message: flow.notAllowedMessage,
    })));
    return;
  }
  try {
    const { results } = await flow.upload(channel, files, await core.language());
    await reportAdvisorDelivery(core, event, results);
  } catch (error) {
    await flow.onError(error);
  }
}

/** Uploads the reply's files, then returns the reply text with file results and delivery notice; Core is asked for the language once. */
export async function buildAdvisorReplyText(
  core: CoreClient,
  event: OwlEvent,
  upload: (files: readonly OutboundFile[], language: OwlLanguage) => Promise<{ lines: string[]; results: OutboundFileResult[] }>,
): Promise<string> {
  const reply = await fetchAdvisorReply(core, event);
  // Core is the sole parsing point for Advisor replies: `reply` is the text Core decided to show, as-is.
  const language = await core.language();
  const { lines, results } = await upload(parseOutboundFiles(event.payload.outbound_files), language);
  const notice = await reportAdvisorDelivery(core, event, results);
  if (notice) lines.push(notice);
  return formatAdvisorReply(appendFileResults(reply, event.payload.action_results, lines), event.payload.suggested_actions, language);
}

/** The fields every service's inbound file shares. */
export interface InboundFile { readonly id: string; readonly name: string }

/** The service-side calls `routeInboundMessage` needs; the routing itself is shared. */
export interface InboundMessageFlow<F extends InboundFile> {
  readonly source: "slack" | "discord";
  readonly accountId: string;
  readonly statusKeywords?: readonly string[];
  /** Open Decisions; a seam so a connector (and its tests) controls where they come from. */
  readonly fetchPendingDecisions: () => Promise<PendingDecision[]>;
  readonly message: RoutedMessage<F>;
  readonly messageId: string;
  /** Posts into the message's channel, in its thread when it has one. */
  readonly reply: (text: string) => Promise<void>;
  /** Posts a status text or a file notice (never threaded). */
  readonly notice: (text: string) => Promise<void>;
  /** Sends the one /inbound/messages call for this message. */
  readonly sendInbound: (text: string, attachmentIds: readonly string[], statusReply?: string) => Promise<void>;
  readonly conversationHint: UploadAttachmentRequest["conversation_hint"];
  readonly tempDirPrefix: string;
  /** Downloads one file into `dir`; null skips it. Throw to fail it. */
  readonly download: (file: F, dir: string) => Promise<{ path: string; mime: string; size: number; knownFormat: boolean } | null>;
  /** When set, a failing file is reported here and the others go on; otherwise the error propagates. */
  readonly onFileError?: (file: F, error: unknown, language: OwlLanguage) => Promise<void>;
}

/** Classifies one inbound message and runs the matching flow: status, decision answer, clarification, file upload or conversation. */
export async function routeInboundMessage<F extends InboundFile>(core: CoreClient, flow: InboundMessageFlow<F>): Promise<void> {
  const pendingDecisions = await flow.fetchPendingDecisions();
  const language = await core.language();
  const t = connectorText(language);
  const intent = classifyIntent(flow.message, pendingDecisions, flow.statusKeywords, language);
  switch (intent.kind) {
    case "status_query": {
      const status = await formatStatusResponse(core, language);
      await flow.notice(status);
      // A misjudged request must still reach the Advisor's conversation; a failed record never blocks the answer already posted.
      await flow.sendInbound(flow.message.text, [], status).catch((error) => {
        console.error(`[${flow.source}] Failed to record the status exchange in Core:`, error);
      });
      return;
    }
    case "decision_answer": {
      const pending = pendingDecisions.find((candidate) => candidate.id === intent.decisionId);
      const outcome = await submitDecisionAnswer(core, {
        decisionId: intent.decisionId,
        answer: intent.answer,
        optionKey: intent.optionKey,
        displayLabel: intent.optionLabel ?? intent.answer,
        source: flow.source,
        sourceMessageId: flow.messageId,
        idempotencyKey: `${flow.source}:decision:${intent.decisionId}:msg:${flow.messageId}`,
        expectedVersion: pending?.state_version ?? 0,
      });
      await flow.reply(outcome.kind === "accepted" ? t.answerAccepted(decisionShortId(intent.decisionId)) : t.alreadyAnswered(outcome.label));
      return;
    }
    case "decision_clarification":
      await flow.reply(intent.text);
      return;
    case "file_upload": {
      const tempDir = await mkdtemp(join(tmpdir(), flow.tempDirPrefix));
      const attachmentIds: string[] = [];
      try {
        for (const file of intent.files) {
          try {
            const result = await flow.download(file, tempDir);
            if (!result) continue;
            try {
              const uploaded = await uploadAttachment(core, {
                provider: flow.source,
                account_id: flow.accountId,
                external_attachment_id: file.id,
                conversation_hint: flow.conversationHint,
                work_id: null,
                file: { name: file.name, mime: result.mime, bytes: await readFile(result.path) },
              });
              attachmentIds.push(uploaded.upload_id);
              const notice = t.fileReceived(file.name, formatBytes(result.size), result.knownFormat);
              await flow.notice(uploaded.status === "quarantined" ? `${notice}\n${t.executableNotRun}` : notice);
            } finally {
              await unlink(result.path).catch(() => undefined);
            }
          } catch (error) {
            if (!flow.onFileError) throw error;
            await flow.onFileError(file, error, language);
          }
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (attachmentIds.length === 0 && !intent.text) return;
      await flow.sendInbound(intent.text ?? "", attachmentIds);
      return;
    }
    case "conversation":
      await flow.sendInbound(intent.text, []);
      return;
  }
}

/** Answers a Decision from a button press. `gone` means the Decision is no longer pending; `text` is what to tell the Owner either way. */
export async function answerDecisionButton(core: CoreClient, flow: {
  readonly source: "slack" | "discord";
  readonly target: DecisionButtonTarget;
  readonly fetchPendingDecisions: () => Promise<PendingDecision[]>;
  /** Id of the message that carried the button, null when unknown. */
  readonly messageId: string | null;
}): Promise<{ gone: boolean; text: string }> {
  const t = connectorText(await core.language());
  const selected = resolveDecisionButtonTarget(await flow.fetchPendingDecisions(), flow.target);
  if (!selected) return { gone: true, text: t.decisionGone };
  const outcome = await submitDecisionAnswer(core, {
    decisionId: selected.decisionId,
    answer: selected.label,
    optionKey: selected.optionKey,
    displayLabel: selected.label,
    source: flow.source,
    sourceMessageId: flow.messageId,
    idempotencyKey: `${flow.source}:decision:${selected.decisionId}:${selected.optionKey}:${flow.messageId ?? "none"}`,
    expectedVersion: selected.stateVersion,
  });
  return { gone: false, text: outcome.kind === "accepted" ? t.answeredWith(selected.label) : t.alreadyAnswered(outcome.label) };
}
