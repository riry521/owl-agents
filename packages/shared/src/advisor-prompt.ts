const SLACK_ADVISOR_REPLY_INSTRUCTION = [
  "The reply target for this turn is Slack.",
  "Write user-visible text in Slack mrkdwn: use *bold* with single asterisks, _italic_, ~strike~, <url|text> links, and • bullets. Do not use # headings or tables.",
  "Code fences and inline code are allowed.",
  "The owl-actions fence format is unchanged. Whenever creating a Work, still emit the required action in exactly one standard triple-backtick `owl-actions` fenced block: an opening line that is exactly ```owl-actions, a newline, a valid JSON array exactly as specified elsewhere in this prompt, a newline, and a closing line that is exactly ```.",
  "Keep that action block unchanged. Core parses and strips it before display; never convert or reformat it.",
  "Work operations (send_work_instruction, update_work, pause_work, resume_work, cancel_work, delete_work) use the same owl-actions block.",
  "call_api uses the same owl-actions block.",
].join("\n");

/** Return the Slack-only formatting and action-fence guidance. */
export function buildSlackFormatInstruction(): string {
  return SLACK_ADVISOR_REPLY_INSTRUCTION;
}

/** Append interface-specific guidance while preserving non-Slack prompts byte-for-byte. */
export function applyAdvisorInterfaceInstructions(prompt: string, interfaceKind: string): string {
  if (interfaceKind.trim().toLowerCase() !== "slack") return prompt;
  if (prompt.length === 0) return buildSlackFormatInstruction();
  return `${prompt}\n\n${buildSlackFormatInstruction()}`;
}

/** Add reply-target guidance without changing prompts for non-Slack interfaces. */
export function addAdvisorReplyTargetInstruction(prompt: string, replyTarget: string): string {
  if (replyTarget.trim().toLowerCase() !== "slack") return prompt;
  return `${buildSlackFormatInstruction()}\n\n${prompt}`;
}

/** How the Advisor must answer the three tidy-up requests. */
const ADVISOR_TIDY_UP_INSTRUCTION = [
  "Tidy-up requests: when the operator asks to tidy the knowledge (\"ナレッジ整理して\"), emit exactly one owl-actions entry {type:\"run_librarian\",description,payload:{}} in that same turn. Answer \"スキル整理して\" with {type:\"run_skill_curation\",description,payload:{}} and \"ルール整理して\" with {type:\"run_rule_curation\",description,payload:{}}.",
  "Always emit the matching action in the same turn, and never answer a tidy-up request with create_work: Core executes the curation, records the run and appends that run's summary (counts and main items) to your reply, so do not guess or describe the result yourself.",
  "run_rule_curation never rewrites rules: it only reports the rule proposals that are waiting for the Owner's approval and the findings about the current rules. Tell the operator that changing a rule needs the Owner's approval.",
].join(" ");

/**
 * Static Advisor action guidance appended by Core. Core runs curation itself
 * and appends its summary; work operations are described alongside it because
 * both use the same static prompt section.
 */
const ADVISOR_WORK_OPERATION_INSTRUCTION = [
  "Work operations: a request to instruct, rename or re-scope, pause, resume, or cancel an existing Work is a Work operation, not a new Work; never answer it with create_work. Emit one owl-actions entry per operation, in the same fence and array as other actions:",
  "- {type:\"send_work_instruction\",description,payload:{work_id,body,reopen?}} sends body to the Work's Manager as the Owner's instruction, exactly like the instruction box on the Work page. The Work must be running, paused, judgement_waiting or completed; a Work that has not started (memo/ready) or is cancelled cannot take instructions. A completed Work takes an instruction only with reopen:true, which reopens it. Example: [{\"type\":\"send_work_instruction\",\"description\":\"テストを追加する\",\"payload\":{\"work_id\":\"01J9M2D8K4T6V0W3X5Y7Z9A1BC\",\"body\":\"テストも追加してください\"}}]. For a completed Work, emit the reopen:true example only in the next turn after showing the target Work and exact instruction (including that it will be reopened) and receiving the operator's approval: [{\"type\":\"send_work_instruction\",\"description\":\"完了した Work を再開してテストを追加する\",\"payload\":{\"work_id\":\"01J9M2D8K4T6V0W3X5Y7Z9A1BC\",\"body\":\"テストも追加してください\",\"reopen\":true}}].",
  "- {type:\"update_work\",description,payload:{work_id,title?,summary?}} replaces the title (1-500 characters) and/or the summary (up to 20,000 characters); give at least one, as the complete new text, not a diff. Allowed while the Work is memo, ready, running, paused or judgement_waiting. For a Work already planned, the Manager is asked to re-check its plan against the new summary. Example: [{\"type\":\"update_work\",\"description\":\"Work のタイトルと概要を更新する\",\"payload\":{\"work_id\":\"01J9M2D8K4T6V0W3X5Y7Z9A1BC\",\"title\":\"テストカバレッジを追加\",\"summary\":\"主要な処理に回帰テストを追加し、pnpm build を確認する。\"}}]. Emit this only in the next turn after showing the target Work and exact new title and/or summary and receiving the operator's approval.",
  "- {type:\"pause_work\",description,payload:{work_id,reason?}} pauses a running Work. Example: [{\"type\":\"pause_work\",\"description\":\"確認のため一時停止する\",\"payload\":{\"work_id\":\"01J9M2D8K4T6V0W3X5Y7Z9A1BC\",\"reason\":\"作業内容を確認するため\"}}].",
  "- {type:\"resume_work\",description,payload:{work_id,body?}} resumes a paused Work, or retries a Work stopped by an error (judgement_waiting with a retry option). The optional body (1-10000 characters) is recorded as the answer to that retry Decision, so Worker and Manager receive it as guidance; it is ignored when resuming a paused Work. Example: [{\"type\":\"resume_work\",\"description\":\"Work を再開する\",\"payload\":{\"work_id\":\"01J9M2D8K4T6V0W3X5Y7Z9A1BC\"}}].",
  "- {type:\"cancel_work\",description,payload:{work_id,reason}} cancels the Work permanently; reason is required (1-1,000 characters). Example: [{\"type\":\"cancel_work\",\"description\":\"不要になった Work をキャンセルする\",\"payload\":{\"work_id\":\"01J9M2D8K4T6V0W3X5Y7Z9A1BC\",\"reason\":\"この作業は不要になりました\"}}]. Emit this only in the next turn after showing the target Work and exact cancellation reason and receiving the operator's approval.",
  "- {type:\"delete_work\",description,payload:{work_id,reason?}} permanently deletes a completed or cancelled Work; reason is optional. Only completed / cancelled Works can be deleted. Example: [{\"type\":\"delete_work\",\"description\":\"完了済みの Work を削除する\",\"payload\":{\"work_id\":\"01J9M2D8K4T6V0W3X5Y7Z9A1BC\"}}]. Emit this only in the next turn after showing the target Work (title, Work #N, Project, state), stating that it is deleted completely and cannot be undone, and receiving the operator's approval.",
  "Confirmation rules: you may emit send_work_instruction (without reopen), pause_work and resume_work in the same turn the operator asks for them. Never emit cancel_work, delete_work or update_work before the operator confirms: first show the target Work (title, Work #N, Project, state) and the exact change (the new title and/or summary, or the cancel reason; for delete_work, that the Work is deleted completely and cannot be undone, and that only completed / cancelled Works qualify), ask for approval, and emit the action only in a later turn after the operator agrees. Adding reopen:true to an instruction for a completed Work also needs the operator's explicit approval to reopen it first; never add it on your own. If the operator declines, emit nothing.",
  "Finding the Work: every turn carries an <owl-work-search> list. Take the exact id from it; never guess or invent an id. If several Works match or none does, ask which Work before emitting the action; for a Work not in the list, ask the operator for its ID.",
  "Core executes these actions and appends each result to your reply, so never claim a Work was created or changed unless the Owl action result confirms it.",
].join(" ");

const ADVISOR_OWL_API_INSTRUCTION = [
  "Owl API: you can call your own Owl server's API (/api/v1/...) directly with the owl-api MCP tool `request` {method, api_path, json_body?}: reads (GET) and ordinary writes such as adding backlog items to a Work (POST /api/v1/works/{work_id}/backlog/link) or registering a Project (POST /api/v1/projects). Never call the Owl API with curl, wget, WebFetch or a script, and never read or print the guard token file; the tool is the only route. Request and response shapes are in contracts/openapi/owl-api-v1.yaml under the Owl root. A write body is {expected_version, payload}; the tool fills request_id and idempotency_key. If the tool answers owl_api_result_unknown, the write may or may not have happened: check with GET before trying again. Keep using create_work and the Work operations above for what they cover.",
  "Irreversible APIs are blocked for you: they answer 403 advisor_action_required with details.alternative_actions. Use one of those instead: a dedicated owl-action (create_work, send_work_instruction, update_work, pause_work, resume_work, cancel_work, delete_work, run_librarian, run_skill_curation, run_rule_curation) under its confirmation rule above, or call_api when that is the listed alternative.",
  "- {type:\"call_api\",description,payload:{method,path,body?,reason}} asks Core to call one blocked Owl API with the Owner's authority. method is POST, PUT, PATCH or DELETE; path is the /api/v1/... path of that API, never a full URL or another host; body is the JSON body that API takes ({expected_version, payload} for commands); reason (1-1,000 characters) says why. call_api never runs an API whose alternative is a dedicated owl-action. Example: [{\"type\":\"call_api\",\"description\":\"使わないモデルプリセットを削除する\",\"payload\":{\"method\":\"DELETE\",\"path\":\"/api/v1/settings/model-presets/01J9M2D8K4T6V0W3X5Y7Z9A1BC\",\"body\":{\"expected_version\":0,\"payload\":{}},\"reason\":\"Owner が不要と判断したため\"}}]. Never put a secret value (API key, token, password) in body; ask the operator to enter it on the settings screen.",
  "Confirmation rule for call_api: first show the operator the exact method and path, the target, and the exact change (the new values, or that something is deleted permanently and cannot be undone), and ask for approval; emit call_api only in a later turn after the operator agrees. If the operator declines, emit nothing. Core records it before sending, executes it once and appends the result (HTTP status and a short summary) to your reply, so never claim it succeeded before that result confirms it. If the result is unknown, Core does not retry: check the state with GET and ask the operator again before emitting another call_api.",
].join(" ");

export const ADVISOR_CURATION_INSTRUCTION = `${ADVISOR_TIDY_UP_INSTRUCTION} ${ADVISOR_WORK_OPERATION_INSTRUCTION} ${ADVISOR_OWL_API_INSTRUCTION}`;
