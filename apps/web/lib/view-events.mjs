// WebSocket の知らせ（イベントフレーム）→ 取り直すキーの対応表。純 JS。
// パターンは完全一致か、* を含む glob。{work_id} などは知らせの値で埋める。

const WORK_KEYS = ["work:{work_id}", "work-*:{work_id}"];
const ADVISOR_KEYS = ["advisor-session:*", "advisor-messages:*"];

/** type の前方一致（先頭から順に最初の一致）。fn は frame の値から追加のパターンを返す。 */
export const VIEW_EVENT_RULES = [
  { prefixes: ["work."], keys: ["board", "archive", ...WORK_KEYS, "linkable-works:*"], needs: "work_id" },
  {
    prefixes: ["task.", "verification.", "review.", "manager.", "reviewer.", "artifact."],
    keys: ["board", ...WORK_KEYS],
    needs: "work_id",
  },
  { prefixes: ["agent.", "subagent."], keys: ["work:{work_id}", "board", "agents", "tokens:*"], needs: "work_id" },
  { prefixes: ["agent."], keys: ["advisor-session:*", "tokens:*"] },
  { prefixes: ["decision."], keys: ["board", "work:{work_id}", "decision:{decision_id}"] },
  { prefixes: ["message."], keys: ["advisor-session:{conversation_id}", "advisor-messages:{conversation_id}", "work:{work_id}"], needs: "conversation_id", otherwise: ADVISOR_KEYS },
  { prefixes: ["advisor.", "conversation."], keys: ["advisor-session:{conversation_id}", "advisor-messages:{conversation_id}"], needs: "conversation_id", otherwise: ADVISOR_KEYS },
  { prefixes: ["settings.plan_usage_updated"], keys: ["settings", "tokens:*"] },
  { prefixes: ["settings."], keys: ["settings"] },
  { prefixes: ["project."], keys: ["projects", "board", "archive", "backlog:*", "settings"] },
  { prefixes: ["rule_proposal."], keys: ["rule-proposals:*"] },
  { prefixes: ["provider."], keys: ["provider-pauses", "settings"] },
];

const EVENTS_KEY = "events";

function globToRegExp(pattern) {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`);
}

function fill(pattern, values) {
  let missing = false;
  const text = pattern.replace(/\{(\w+)\}/g, (_, name) => {
    const value = values[name];
    if (typeof value !== "string" || value === "") {
      missing = true;
      return "*";
    }
    return value;
  });
  return { text, missing };
}

/**
 * 知らせに関係するキーのうち、表示中（mountedKeys）のものだけを返す。
 * 値が無い {id} は「そのキーの全部」とみなす。ただし work:{work_id} は work_id が無ければ外す。
 */
export function viewKeysForEvent(frame, mountedKeys) {
  const payload = frame && typeof frame.payload === "object" && frame.payload !== null ? frame.payload : {};
  const type = typeof frame?.type === "string" ? frame.type : "";
  const values = {
    work_id: frame?.work_id ?? payload.work_id ?? null,
    conversation_id: payload.conversation_id ?? null,
    decision_id: payload.decision_id ?? null,
  };
  const patterns = [EVENTS_KEY];
  const rules = VIEW_EVENT_RULES.filter((rule) => rule.prefixes.some((prefix) => type.startsWith(prefix)));
  // work_id が要る規則に合わない場合は、同じ type の次の規則へ落とす。
  const rule = rules.find((candidate) => candidate.needs === undefined || candidate.otherwise !== undefined || values[candidate.needs]);
  if (rule) {
    const useOtherwise = rule.needs && !values[rule.needs] && rule.otherwise;
    for (const pattern of useOtherwise ? [...rule.otherwise, ...(values.work_id ? ["work:{work_id}"] : [])] : rule.keys) {
      const { text, missing } = fill(pattern, values);
      if (missing && pattern.startsWith("work:")) continue;
      patterns.push(text);
    }
  }
  const matchers = patterns.map(globToRegExp);
  return mountedKeys.filter((key) => matchers.some((matcher) => matcher.test(key)));
}
