import assert from "node:assert/strict";
import { test } from "node:test";

import {
  answerGuideHint,
  buildNotificationCard,
  decisionTitle,
  formatWorkCompletionSummary,
  isNotificationCardEvent,
  toPlainText,
} from "../../packages/plugin-sdk/dist/shared/index.js";

const WORK_ID = "01ARZ3NDEKTSV4RRFFQ69WORK1";
const DECISION_ID = "01ARZ3NDEKTSV4RRFFQ6DECIS1";

function event(type, payload = {}, extra = {}) {
  return {
    kind: "event",
    event_id: `event-${type}`,
    sequence: 1,
    cursor: "1",
    type,
    schema_version: "1.0.0",
    payload,
    ...extra,
  };
}

const styles = [
  ["work.completed", "✅", "完了しました", "Completed", "#4CAF50", { title: "Archive" }],
  ["work.cancelled", "🛑", "中止されました", "Cancelled", "#9E9E9E", {}],
  ["work.paused", "⏸️", "一時停止しました", "Paused", "#FFB300", {}],
  ["work.reopened", "🔄", "再オープンしました", "Reopened", "#2196F3", {}],
  ["decision.opened", "✋", "判断が必要です", "Decision needed", "#F5A623", {
    decision_id: DECISION_ID, question: "どちらにしますか？", options: [],
  }],
  ["decision.resolved", "☑️", "解決しました", "Resolved", "#4CAF50", { decision_id: DECISION_ID, answer: "進める" }],
  ["decision.cancelled", "🚫", "取り消されました", "Cancelled", "#9E9E9E", { decision_id: DECISION_ID, reason: "work_cancelled" }],
  ["provider.paused", "⏳", "利用上限で停止中", "Paused at usage limit", "#FFB300", {
    provider: "Anthropic", resume_at: "2025-01-01T12:00:00Z", resume_source: "reported",
  }],
  ["provider.resumed", "▶️", "処理を再開しました", "Resumed", "#4CAF50", { provider: "Anthropic" }],
  ["system.alert", "🚨", "問題が発生", "Problem", "#F44336", { message: "Failure" }, { work_id: WORK_ID }],
  ["system.alert", "⚠️", "システム通知", "System notice", "#FF9800", { message: "Notice" }, {}],
  ["system.alert", "📝", "整理のお知らせ", "Curation notice", "#607D8B", { kind: "curation_notice", severity: "info", message: "a\nb" }, {}],
  ["system.alert", "⚠️", "システム通知", "System notice", "#FF9800", { kind: "curation_notice", severity: "warning", message: "Failed" }, {}],
];

for (const [type, emoji, jaTitle, enTitle, color, payload, extra = { work_id: WORK_ID }] of styles) {
  for (const language of ["ja", "en"]) {
    test(`${type}${type === "system.alert" ? (extra.work_id ? " with Work" : " without Work") : ""} card style (${language})`, () => {
      const localizedPayload = type === "decision.opened" ? { ...payload, language } : payload;
      const input = event(type, localizedPayload, extra);
      assert.equal(isNotificationCardEvent(type, localizedPayload), true);
      const card = buildNotificationCard(input, { language, formatTime: () => "12:00", replyStyle: "thread" });
      assert.ok(card);
      assert.equal(card.language, language);
      assert.equal(card.eventType, type);
      assert.equal(card.emoji, emoji);
      assert.equal(card.title, (language === "ja" ? jaTitle : enTitle) + (type === "work.completed" ? ": Archive" : ""));
      assert.equal(card.color, color);
      assert.equal(typeof card.fallbackText, "string");
      assert.ok(card.fallbackText.length > 0);
      assert.ok(card.fallbackText.length <= 200);
    });
  }
}

test("decision.opened follows the payload language for its card title", () => {
  const card = buildNotificationCard(event("decision.opened", {
    language: "en", decision_id: DECISION_ID, question: "Which option?", options: [],
  }), { language: "ja", formatTime: () => "12:00", replyStyle: "reply" });
  assert.equal(card.language, "en");
  assert.equal(card.title, decisionTitle({ language: "en" }));
});

test("work.completed includes task count and duration and derives duration from timestamps", () => {
  const fromValues = buildNotificationCard(event("work.completed", {
    work_id: WORK_ID,
    title: "Archive",
    task_count: 5,
    duration_ms: 4_980_000,
  }), { language: "ja", formatTime: () => "12:00", replyStyle: "thread" });
  assert.equal(fromValues.body, "Task 5件・所要 1時間23分");
  assert.equal(fromValues.footer, "Work 9WORK1");

  assert.equal(formatWorkCompletionSummary({ task_count: 1, started_at: "2025-01-01T00:00:00Z", completed_at: "2025-01-01T01:23:00Z" }, "en"), "1 task · 1h 23m");
  const derived = buildNotificationCard(event("work.completed", {
    work_id: WORK_ID, task_count: 5,
    started_at: "2025-01-01T00:00:00Z", completed_at: "2025-01-01T01:23:00Z",
  }), { language: "en", formatTime: () => "12:00", replyStyle: "thread" });
  assert.equal(derived.body, "Work 9WORK1\n5 tasks · 1h 23m");

  const reduced = buildNotificationCard(event("work.completed", { work_id: WORK_ID, task_count: 5 }), {
    language: "en", formatTime: () => "12:00", replyStyle: "thread",
  });
  assert.equal(reduced.body, "Work 9WORK1\n5 tasks");
  const absent = buildNotificationCard(event("work.completed", { work_id: WORK_ID }), {
    language: "en", formatTime: () => "12:00", replyStyle: "thread",
  });
  assert.equal(absent.body, "Work 9WORK1");
  assert.equal(absent.footer, "Work 9WORK1");
});

test("decision.opened keeps the main body short and returns background in threadDetail", () => {
  const card = buildNotificationCard(event("decision.opened", {
    work_id: WORK_ID,
    decision_id: DECISION_ID,
    question: "どちらの案で進めますか？",
    reason: "本番変更の前に判断が必要です。",
    current_state: "作業を停止しています。",
    tried: "ステージングで検証しました。",
    options: [
      { key: "apply", label: "すぐ適用", description: "本番へ反映" },
      { key: "wait", label: "延期", description: "次回まで待つ" },
    ],
    recommended: "apply",
    allow_free_text: true,
  }), { language: "ja", formatTime: () => "12:00", replyStyle: "thread" });

  assert.equal(card.body, "❓ どちらの案で進めますか？\n\n• すぐ適用 ★\n• 延期");
  assert.doesNotMatch(card.body, /本番変更|作業を停止|ステージング|回答方法/u);
  assert.equal(card.threadDetail.includes("本番変更の前に判断が必要です。"), true);
  assert.equal(card.threadDetail.includes("作業を停止しています。"), true);
  assert.equal(card.threadDetail.includes("ステージングで検証しました。"), true);
  assert.equal(card.threadDetail.includes(answerGuideHint(DECISION_ID, "ja", true)), true);
  assert.match(card.threadDetail, /回答方法/u);
  assert.match(card.threadDetail, /回答 DECIS1: 内容/u);
  assert.deepEqual(card.actions.map(({ label, value, optionIndex, recommended }) => ({ label, value, optionIndex, recommended })), [
    { label: "★ すぐ適用", value: "apply", optionIndex: 0, recommended: true },
    { label: "延期", value: "wait", optionIndex: 1, recommended: false },
  ]);
  assert.equal(card.footer, "Work 9WORK1 · ID DECIS1");
  assert.equal(card.question, "どちらの案で進めますか？");
});

test("fallback text is plain, concise, and includes only the event subject", () => {
  const alert = buildNotificationCard(event("system.alert", {
    message: "  **Failure**\nSee [the guide](https://example.com).  ",
  }), { language: "en", formatTime: () => "12:00", replyStyle: "thread" });
  assert.equal(alert.fallbackText, "⚠️ System notice: Failure");
  assert.equal(alert.fallbackText, `${alert.emoji} ${alert.title}: ${toPlainText("**Failure**")}`);
  assert.equal(toPlainText("See [the guide](https://example.com)."), "See the guide.");
  assert.doesNotMatch(alert.fallbackText, /\*\*|\[the guide\]/u);
  assert.equal(isNotificationCardEvent("system.alert", { message: "  " }), false);
  assert.equal(buildNotificationCard(event("system.alert", { message: "  " }), {
    language: "ja", formatTime: () => "12:00", replyStyle: "thread",
  }), null);
});

const WORK_TITLE = "請求書アーカイブの整理";
const CARD_CTX = (language) => ({ language, formatTime: () => "12:00", replyStyle: "thread" });
const titledCases = [
  ["work.completed", { work_id: WORK_ID }, "heading"],
  ["work.cancelled", { work_id: WORK_ID }, "heading"],
  ["work.paused", { work_id: WORK_ID }, "heading"],
  ["work.reopened", { work_id: WORK_ID }, "heading"],
  ["decision.opened", { work_id: WORK_ID, decision_id: DECISION_ID, question: "どちらにしますか？", options: [] }, "body"],
  ["decision.resolved", { work_id: WORK_ID, decision_id: DECISION_ID, answer: "進める" }, "body"],
  ["decision.cancelled", { work_id: WORK_ID, decision_id: DECISION_ID, reason: "work_cancelled" }, "body"],
  ["system.alert", { work_id: WORK_ID, message: "Failure" }, "body"],
];

for (const [type, payload, where] of titledCases) {
  for (const language of ["ja", "en"]) {
    test(`${type} shows the Work title in ${where} and fallbackText, keeping footer IDs (${language})`, () => {
      const p = { ...payload, work_title: WORK_TITLE, ...(type === "decision.opened" ? { language } : {}) };
      const card = buildNotificationCard(event(type, p), CARD_CTX(language));
      if (where === "heading") assert.ok(card.title.includes(WORK_TITLE));
      else assert.equal(card.body.split("\n")[0], WORK_TITLE);
      assert.ok(card.fallbackText.includes(WORK_TITLE));
      assert.match(card.footer, /Work 9WORK1/u);
      if (type.startsWith("decision.")) assert.match(card.footer, /ID /u);
      assert.ok(!card.title.includes("Project") && !(card.body ?? "").includes("Project"));

      const bare = buildNotificationCard(event(type, payload), CARD_CTX(language));
      assert.ok(!bare.fallbackText.includes(WORK_TITLE));
      assert.match(bare.footer, /Work 9WORK1/u);
    });
  }
}

test("work.* heading is capped at 150 chars, uses title as fallback, and prefers work_title", () => {
  const long = buildNotificationCard(event("work.completed", { work_id: WORK_ID, work_title: "あ".repeat(400) }), CARD_CTX("ja"));
  assert.ok(long.title.length <= 150);
  assert.ok(long.fallbackText.startsWith("✅ 完了しました: あああ"));
  const legacy = buildNotificationCard(event("work.paused", { work_id: WORK_ID, title: "Legacy" }), CARD_CTX("en"));
  assert.equal(legacy.title, "Paused: Legacy");
  const both = buildNotificationCard(event("work.paused", { work_id: WORK_ID, title: "Old", work_title: "New" }), CARD_CTX("en"));
  assert.equal(both.title, "Paused: New");
  const decision = buildNotificationCard(event("decision.opened", {
    work_id: WORK_ID, work_title: "Keep me", decision_id: DECISION_ID, question: "q".repeat(400), options: [],
  }), CARD_CTX("ja"));
  assert.ok(decision.fallbackText.includes("Keep me"));
});

test("work-less system.alert and provider.* cards are unchanged by work_title", () => {
  const alert = buildNotificationCard(event("system.alert", { message: "Notice", work_title: "X" }), CARD_CTX("ja"));
  assert.equal(alert.title, "システム通知");
  assert.equal(alert.body, "Notice");
  assert.equal(alert.footer, null);
  assert.equal(alert.fallbackText, "⚠️ システム通知: Notice");
  const resumed = buildNotificationCard(event("provider.resumed", { provider: "Anthropic", work_title: "X" }), CARD_CTX("ja"));
  assert.equal(resumed.fallbackText, "▶️ 処理を再開しました: Anthropic");
  assert.equal(resumed.footer, null);
});

test("provider.paused / provider.resumed cards are identical with and without work_title", () => {
  const payloads = {
    "provider.paused": { provider: "Anthropic", resume_at: "2025-01-01T12:00:00Z", resume_source: "reported" },
    "provider.resumed": { provider: "Anthropic" },
  };
  for (const language of ["ja", "en"]) {
    for (const [type, payload] of Object.entries(payloads)) {
      const base = buildNotificationCard(event(type, payload), CARD_CTX(language));
      const withTitle = buildNotificationCard(event(type, { ...payload, work_id: WORK_ID, work_title: WORK_TITLE, title: WORK_TITLE }), CARD_CTX(language));
      for (const key of ["title", "body", "footer", "fallbackText"]) assert.equal(withTitle[key], base[key], `${type} ${language} ${key}`);
      assert.ok(!base.fallbackText.includes(WORK_TITLE));
    }
  }
});
