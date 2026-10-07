import type { CoreClient } from "../client";
import type { OwlLanguage } from "./language";

interface WorkSummary {
  readonly id: string;
  readonly title: string;
  readonly state: string;
}

interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly state: string;
}

const STATUS_TEXT: Readonly<Record<OwlLanguage, {
  readonly states: Readonly<Record<string, string>>;
  readonly nothingRunning: string;
  readonly work: (shortId: string, title: string, state: string, completed: number, total: number, running: number) => string;
  readonly now: (shortId: string, title: string, state: string) => string;
  readonly decisions: (count: number) => string;
  readonly noDecisions: string;
}>> = {
  ja: {
    states: {
      pending: "待機中",
      planning: "計画中",
      running: "作業中",
      review: "レビュー中",
      completed: "完了",
      failed: "失敗",
      cancelled: "中止",
      blocked: "ブロック中",
      ready: "準備完了",
    },
    nothingRunning: "現在、進行中のWorkはありません。",
    work: (id, title, state, completed, total, running) =>
      `Work ${id}「${title}」: ${state}（Task ${completed}/${total} 完了${running > 0 ? `、${running}つ実行中` : ""}）`,
    now: (id, title, state) => `  └ いま: Task ${id}「${title}」${state}`,
    decisions: (count) => `判断待ち: ${count}件`,
    noDecisions: "判断待ち: なし",
  },
  en: {
    states: {
      pending: "pending",
      planning: "planning",
      running: "running",
      review: "in review",
      completed: "completed",
      failed: "failed",
      cancelled: "cancelled",
      blocked: "blocked",
      ready: "ready",
    },
    nothingRunning: "No Work is in progress right now.",
    work: (id, title, state, completed, total, running) =>
      `Work ${id} "${title}": ${state} (Tasks ${completed}/${total} done${running > 0 ? `, ${running} running` : ""})`,
    now: (id, title, state) => `  └ now: Task ${id} "${title}" ${state}`,
    decisions: (count) => `Decisions waiting: ${count}`,
    noDecisions: "Decisions waiting: none",
  },
};

/** The status reply in the Owner language; without `language` it asks Core for it. */
export async function formatStatusResponse(client: CoreClient, language?: OwlLanguage): Promise<string> {
  const t = STATUS_TEXT[language ?? await client.language()];
  const label = (state: string): string => t.states[state] ?? state;
  const works = (await client.request<WorkSummary[]>("/works?state=running")) ?? [];
  const decisions = (await client.request<Array<{ id: string; question: string }>>("/decisions?status=open")) ?? [];

  if (works.length === 0 && decisions.length === 0) {
    return t.nothingRunning;
  }

  const lines: string[] = [];

  for (const work of works) {
    const tasks = (await client.request<TaskSummary[]>(`/works/${work.id}/tasks`)) ?? [];
    const completed = tasks.filter((task) => task.state === "completed").length;
    const running = tasks.filter((task) => task.state === "running" || task.state === "verifying");
    lines.push(t.work(work.id.slice(-6), work.title, label(work.state), completed, tasks.length, running.length));
    for (const task of running) {
      lines.push(t.now(task.id.slice(-6), task.title, label(task.state)));
    }
  }

  if (decisions.length > 0) {
    lines.push(t.decisions(decisions.length));
    for (const d of decisions) {
      lines.push(`  └ ${d.question}`);
    }
  } else {
    lines.push(t.noDecisions);
  }

  return lines.join("\n");
}
