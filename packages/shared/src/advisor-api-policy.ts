export const OWL_API_PREFIX = "/api/v1";

/** Advisor が書き込み用の共有 worktree を用意・同期してもらうために呼ぶ API のパス */
export const ADVISOR_WORKSPACE_API_PATH = `${OWL_API_PREFIX}/advisor/workspace`;

/** ふさいだ API の代わりに使える owl-action の type。値は既存の owl-action の type と同じ文字列 */
export type AdvisorAlternativeAction =
  | "create_work" | "send_work_instruction" | "update_work" | "pause_work" | "resume_work"
  | "cancel_work" | "delete_work" | "run_librarian" | "run_skill_curation" | "run_rule_curation"
  | "call_api";
type DedicatedAction = Exclude<AdvisorAlternativeAction, "call_api">;

interface AdvisorBlockedApiBase {
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** OWL_API_PREFIX からのパス。{name} は 1 区切り（[^/]+）、{name*} は 1 文字以上の任意（.+） */
  readonly path: string;
  /** 断る理由（英語 1〜2 文。403 の message とプロンプトの説明に使う） */
  readonly reason: string;
}
export type AdvisorBlockedApi =
  | (AdvisorBlockedApiBase & { readonly kind: "call_api" })
  | (AdvisorBlockedApiBase & {
      readonly kind: "dedicated";
      /** 専用の owl-action の候補（1 つ以上）。call_api は入れない */
      readonly alternatives: readonly [DedicatedAction, ...DedicatedAction[]];
    });

const ADVISOR_ACTIONS_REASON =
  "This endpoint runs Advisor actions without your confirmation rules. Emit the owl-action of the same type instead (update_work rewrites a Work's title or summary); reopen_work is send_work_instruction with reopen:true; start_work is POST /api/v1/works/{work_id}/start, which you may call directly; answer_decision is call_api on POST /api/v1/decisions/{decision_id}/answer.";

function callApi(method: AdvisorBlockedApiBase["method"], path: string, reason: string): AdvisorBlockedApi {
  return { kind: "call_api", method, path, reason };
}
function dedicated(
  method: AdvisorBlockedApiBase["method"],
  path: string,
  reason: string,
  alternatives: readonly [DedicatedAction, ...DedicatedAction[]],
): AdvisorBlockedApi {
  return { kind: "dedicated", method, path, reason, alternatives };
}

export const ADVISOR_BLOCKED_APIS: readonly AdvisorBlockedApi[] = [
  dedicated("DELETE", "/works/{work_id}", "Deleting a Work permanently is irreversible.", ["delete_work"]),
  dedicated("POST", "/works/{work_id}/cancel", "Cancelling a Work is irreversible.", ["cancel_work"]),
  dedicated("POST", "/works/{work_id}/reopen", "Reopening a completed Work needs your approval.", ["send_work_instruction"]),
  dedicated("POST", "/works/{work_id}/messages", "A body with reopen:true reopens a completed Work, which needs your approval.", ["send_work_instruction"]),
  dedicated("POST", "/advisor/actions", ADVISOR_ACTIONS_REASON, [
    "create_work", "send_work_instruction", "update_work", "pause_work", "resume_work",
    "cancel_work", "delete_work", "run_librarian", "run_skill_curation", "run_rule_curation",
  ]),
  callApi("POST", "/decisions/{decision_id}/answer", "Answering a Decision acts for the Owner."),
  callApi("DELETE", "/projects/{project_id}", "Deleting a Project is irreversible."),
  callApi("POST", "/backlog/delete", "Deleting backlog items is irreversible."),
  callApi("DELETE", "/backlog/{item_id}", "Deleting a backlog item is irreversible."),
  callApi("POST", "/rule-proposals/{proposal_id}/approve", "Approving a rule proposal changes or deletes rules."),
  callApi("POST", "/rule-proposals/{proposal_id}/reject", "Rejecting a rule proposal is the Owner's decision."),
  callApi("PATCH", "/skills/{name}", "Archiving a skill or changing its scope is hard to undo."),
  callApi("POST", "/skill-proposals/{proposal_id}/approve", "Approving a skill proposal finalizes a skill change."),
  callApi("POST", "/skill-proposals/{proposal_id}/reject", "Rejecting a skill proposal is the Owner's decision."),
  callApi("DELETE", "/knowledge/{path*}", "Deleting a knowledge page is irreversible."),
  callApi("PUT", "/settings/models", "Changing model settings affects every run."),
  callApi("POST", "/settings/model-presets", "Adding a model preset changes settings."),
  callApi("PUT", "/settings/model-presets/{id}", "Changing a model preset changes settings."),
  callApi("DELETE", "/settings/model-presets/{id}", "Deleting a model preset is irreversible."),
  callApi("PUT", "/settings/executor", "Changes the default provider and model of child agents."),
  callApi("PUT", "/settings/child-runs", "Changes the default provider and model of child agents."),
  callApi("PUT", "/settings/provider-models/{provider}", "Changes the model list of a provider."),
  callApi("POST", "/settings/providers", "Adding a provider stores secrets such as API keys."),
  callApi("PUT", "/settings/providers/{provider}", "Changing a provider stores secrets such as API keys."),
  callApi("DELETE", "/settings/providers/{provider}", "Deleting a provider is irreversible."),
  callApi("PUT", "/settings/typesafe", "Stores the Typesafe API key (a secret)."),
  callApi("PUT", "/settings/integrations/{provider}", "Changes Slack / Discord integration settings (tokens)."),
  callApi("DELETE", "/settings/integrations/{provider}", "Deleting an integration is irreversible."),
  callApi("PUT", "/settings/knowledge-storage", "Moves the knowledge storage location."),
  callApi("POST", "/conversations/{conversation_id}/clear", "Clearing a conversation is irreversible and also stops the calling Advisor session."),
  callApi("POST", "/advisor/session/restart", "Stops the calling Advisor session and revokes its token."),
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 正規表現は読み込み時に一度だけ作る。オブジェクトの添字ではなく配列を走査し、プロトタイプのキーを引かない
const COMPILED = ADVISOR_BLOCKED_APIS.map((row) => {
  const source = row.path
    .split(/(\{[a-z_]+\*?\})/)
    .map((part) => {
      const placeholder = /^\{[a-z_]+(\*?)\}$/.exec(part);
      if (placeholder) return placeholder[1] ? ".+" : "[^/]+";
      return escapeRegExp(part);
    })
    .join("");
  return { row, pattern: new RegExp(`^${escapeRegExp(OWL_API_PREFIX)}${source}$`) };
});

/** pathname は URL.pathname（クエリ無し）。一致した行、無ければ null */
export function matchAdvisorBlockedApi(method: string, pathname: string): AdvisorBlockedApi | null {
  for (const { row, pattern } of COMPILED) {
    if (row.method === method && pattern.test(pathname)) return row;
  }
  return null;
}

/** 403 の details と、call_api の拒否理由に使う候補の一覧。call_api の行は ["call_api"] */
export function advisorAlternativeActions(row: AdvisorBlockedApi): readonly AdvisorAlternativeAction[] {
  return row.kind === "dedicated" ? row.alternatives : ["call_api"];
}

const MAX_API_PATH_CHARS = 2000;
const OWN_API_BASE = "http://owl.invalid";

/** 自分の Owl API のパスとして安全か。安全なら URL.pathname と search を返し、だめなら理由を返す */
export function validateOwnApiPath(
  path: string,
  options: { allowQuery?: boolean } = {},
): { ok: true; pathname: string; search: string } | { ok: false; reason: string } {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_API_PATH_CHARS) {
    return { ok: false, reason: `path must be a string of 1 to ${MAX_API_PATH_CHARS} characters` };
  }
  if (!path.startsWith(`${OWL_API_PREFIX}/`)) return { ok: false, reason: `path must start with ${OWL_API_PREFIX}/` };
  if (/[\\#\s\u0000-\u001f\u007f]/.test(path) || /%2e%2e|%5c/i.test(path) || path.includes("..")) {
    return { ok: false, reason: "path contains a forbidden character or sequence" };
  }
  let url: URL;
  try {
    url = new URL(path, OWN_API_BASE);
  } catch {
    return { ok: false, reason: "path is not a valid URL path" };
  }
  if (url.origin !== OWN_API_BASE || url.pathname + url.search !== path) {
    return { ok: false, reason: "path changes when normalized" };
  }
  if (options.allowQuery !== true && url.search !== "") return { ok: false, reason: "path must not have a query" };
  return { ok: true, pathname: url.pathname, search: url.search };
}
