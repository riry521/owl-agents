import type { CoreMainReasonValues } from "@owl/core";
import type { ReasonTable } from "./types.js";


type Sentence = { ja: (key: string) => string; en: (key: string) => string };

/** One clause per test_run problem kind (see TestRunSettingsProblem in @owl/shared). */
const TEST_RUN_PROBLEMS: ReadonlyMap<string, Sentence> = new Map([
  ["not_object", { ja: (key) => `${key} はオブジェクトにしてください`, en: (key) => `${key} must be an object` }],
  ["unknown_key", { ja: (key) => `${key} は未知のキーです`, en: (key) => `${key} is not a known key` }],
  ["invalid", { ja: (key) => `${key} の値の形が正しくありません`, en: (key) => `${key} is invalid` }],
  ["whole_argv_required", { ja: (key) => `mode が whole のときは ${key} が必要です`, en: (key) => `${key} is required when mode is whole` }],
  ["unit_needs_per_file", { ja: (key) => `mode が per_file でないときは ${key} を "file" にしてください`, en: (key) => `${key} must be "file" unless mode is per_file` }],
  ["unit_argv_required", { ja: (key) => `unit が folder か package のときは ${key} が必要です`, en: (key) => `${key} is required when unit is folder or package` }],
  ["unit_markers_required", { ja: (key) => `unit が package のときは ${key} が必要です`, en: (key) => `${key} is required when unit is package` }],
]);

/** The shape each known test_policy key needs (the limits checked by validateTestPolicy in @owl/shared). */
const TEST_POLICY_SHAPES: ReadonlyMap<string, Sentence> = new Map([
  ["reviewer_denied_commands", { ja: (key) => `${key} は、1〜200 文字の文字列を 20 個以内で並べた配列にしてください`, en: (key) => `${key} must be an array of at most 20 strings of 1 to 200 characters` }],
  ["check_commands", { ja: (key) => `${key} は、argv（1〜500 文字の語を 1 つ以上並べた配列）を 10 個以内で並べた配列にしてください`, en: (key) => `${key} must be an array of at most 10 argv arrays, each with one or more words of 1 to 500 characters` }],
]);

function testPolicyClause(problem: { key: string; kind: string }, language: "ja" | "en"): string {
  if (problem.kind === "not_object") return language === "ja" ? `${problem.key} はオブジェクトにしてください` : `${problem.key} must be an object`;
  const key = `test_policy.${problem.key}`;
  if (problem.kind === "unknown_key") return language === "ja" ? `${key} は未知のキーです` : `${key} is not a known key`;
  const shape = TEST_POLICY_SHAPES.get(problem.key);
  if (shape !== undefined) return shape[language](key);
  return language === "ja" ? `${key} の値が正しくありません` : `${key} is invalid`;
}

function testRunClause(problem: { key: string; kind: string }, language: "ja" | "en"): string {
  const sentence = TEST_RUN_PROBLEMS.get(problem.kind);
  if (sentence !== undefined) return sentence[language](problem.key);
  return language === "ja" ? `${problem.key} が正しくありません` : `${problem.key} is invalid`;
}

/** Why a skill input was refused, by the identifier core's message starts with; other identifiers get a generic sentence naming it. */
const SKILL_INPUT_ERRORS: ReadonlyMap<string, { ja: string; en: string }> = new Map([
  ["invalid_skill_name", { ja: "スキル名は、英小文字か数字で始まり、英小文字・数字・ハイフンだけでできた 2〜63 文字にしてください。", en: "The skill name must be 2 to 63 lowercase letters, digits or hyphens, starting with a letter or digit." }],
  ["invalid_skill_description", { ja: "スキルの説明は、制御文字を除いて 1〜300 文字にしてください。", en: "The skill description must be 1 to 300 characters without control characters." }],
  ["invalid_skill_tags", { ja: "スキルのタグに、制御文字を除くと空になるものがあります。", en: "A skill tag is empty once control characters are removed." }],
  ["invalid_skill_files", { ja: "スキルのファイルは、パスを鍵とするオブジェクトで渡してください。", en: "The skill files must be an object keyed by path." }],
  ["invalid_skill_metadata", { ja: "スキルの説明・スコープ・タグのいずれかが正しくありません。説明は 1 行で 1〜300 文字、タグは空でない 1 行の文字列にしてください。", en: "The skill description, scope or tags are invalid: the description must be one line of 1 to 300 characters and each tag a non-empty single line." }],
  ["invalid_skill_state", { ja: "スキルの状態は active、stale、archived のいずれかにしてください。", en: "The skill state must be active, stale or archived." }],
  ["invalid_skill_scope", { ja: "スキルのスコープは global か project:<id> にしてください。", en: "The skill scope must be global or project:<id>." }],
  ["invalid_skill_trial", { ja: "スキルの試用中の印（trial）は真偽値にしてください。", en: "The skill trial flag must be a boolean." }],
  ["skill_file_contains_nul", { ja: "スキルのファイルに NUL 文字が含まれています。", en: "A skill file contains a NUL character." }],
  ["skill_size_exceeds_256KB", { ja: "スキルのファイルの合計が 256KB を超えています。", en: "The skill files exceed 256KB in total." }],
  ["skill_metadata_invalid", { ja: "保存されている SKILL.md が読めないか、その name がスキル名と一致しません。", en: "The stored SKILL.md cannot be read or its name does not match the skill." }],
  ["skill_revision_invalid", { ja: "スキルの版の内容が読めないか、その SKILL.md の name がスキル名と一致しません。", en: "The skill revision content cannot be read or its SKILL.md name does not match the skill." }],
  ["skill_proposal_decision_invalid", { ja: "スキル提案への判断の内容（判断と根拠）が正しくありません。", en: "The decision on the skill proposal (decision and judgement) is invalid." }],
]);

/** Why SKILL.md was refused, by SkillMdProblem (packages/core/src/skill-files.ts); `key` is the frontmatter field. */
const SKILL_MD_PROBLEMS: ReadonlyMap<string, Sentence> = new Map<string, Sentence>([
  ["not_text", { ja: () => "SKILL.md は NUL 文字を含まないテキストにしてください。", en: () => "SKILL.md must be text without NUL characters." }],
  ["frontmatter_missing", { ja: () => "SKILL.md の先頭に、--- の行で囲んだ frontmatter がないか、その形が正しくありません。", en: () => "SKILL.md has no frontmatter enclosed by --- lines at the top, or it is malformed." }],
  ["field_malformed", { ja: () => "SKILL.md の frontmatter に「キー: 値」の形でない行があります。", en: () => "The SKILL.md frontmatter has a line that is not \"key: value\"." }],
  ["duplicate_key", { ja: (key) => `SKILL.md の frontmatter に ${key} が 2 回以上あります。`, en: (key) => `The SKILL.md frontmatter has ${key} more than once.` }],
  ["invalid_value", { ja: (key) => `SKILL.md の frontmatter の ${key} の値が正しくありません。`, en: (key) => `The SKILL.md frontmatter value of ${key} is invalid.` }],
  ["name_invalid", { ja: () => "SKILL.md の name がないか、英小文字・数字・ハイフンでできた 2〜63 文字のスキル名になっていません。", en: () => "The SKILL.md name is missing or is not 2 to 63 lowercase letters, digits or hyphens." }],
  ["description_invalid", { ja: () => "SKILL.md の description がないか、1 行で 300 文字以内になっていません。", en: () => "The SKILL.md description is missing or is not one line of at most 300 characters." }],
  ["scope_invalid", { ja: () => "SKILL.md の scope がないか、global か project:<id> になっていません。", en: () => "The SKILL.md scope is missing or is not global or project:<id>." }],
  ["tags_invalid", { ja: () => "SKILL.md の tags の値が正しくありません。各タグは空でない 1 行の文字列にしてください。", en: () => "The SKILL.md tags are invalid: each tag must be a non-empty single line." }],
]);

/** Sentences for core.ts reason codes (T42). */
export const coreMainReasons: ReasonTable<keyof CoreMainReasonValues> = {
  "core.options_missing": {
    ja: (v) => `${v.fields} は必須で、version は空にできません。`,
    en: (v) => `${v.fields} are required and version must not be empty.`,
  },
  "core.skill_state_invalid": {
    ja: (v) => `${v.field} は active、stale、archived のいずれかにしてください。`,
    en: (v) => `${v.field} must be active, stale or archived.`,
  },
  "core.skill_scope_invalid": {
    ja: (v) => `${v.field} は global か project:<id> にしてください。`,
    en: (v) => `${v.field} must be global or project:<id>.`,
  },
  "core.skill_query_too_long": {
    ja: (v) => `${v.field} は 300 文字以内にしてください。`,
    en: (v) => `${v.field} must be at most 300 characters.`,
  },
  "core.skill_path_empty": {
    ja: (v) => `${v.field} は空でない相対パスにしてください。`,
    en: (v) => `${v.field} must be a non-empty relative path.`,
  },
  "core.skill_path_absolute": {
    ja: (v) => `${v.field} に絶対パスや、環境依存の区切り文字は使えません。`,
    en: (v) => `${v.field} cannot be an absolute path or use platform-specific separators.`,
  },
  "core.skill_path_traversal": {
    ja: (v) => `${v.field} に空の区間、「.」、「..」は使えません。`,
    en: (v) => `${v.field} cannot contain empty, "." or ".." segments.`,
  },
  "core.skill_path_location": {
    ja: (v) => `${v.field} は SKILL.md か、references/、scripts/、templates/ の直下のファイルにしてください。`,
    en: (v) => `${v.field} must be SKILL.md or a file directly inside references/, scripts/, or templates/.`,
  },
  "core.skill_path_symlink": {
    ja: (v) => `${v.field} にシンボリックリンクは使えません。`,
    en: (v) => `${v.field} cannot be a symbolic link.`,
  },
  "core.skill_file_not_text": {
    ja: (v) => `スキルのファイル（${v.field}）は NUL 文字を含まないテキストにしてください。`,
    en: (v) => `The skill file (${v.field}) must be text without NUL characters.`,
  },
  "core.skill_file_not_utf8": {
    ja: (v) => `スキルのファイル（${v.field}）は UTF-8 のテキストにしてください。`,
    en: (v) => `The skill file (${v.field}) must be valid UTF-8 text.`,
  },
  "core.non_empty_string_required": {
    ja: (v) => `${v.field} は空でない文字列にしてください。`,
    en: (v) => `${v.field} must be a non-empty string.`,
  },
  "core.revision_not_restorable": {
    ja: (v) => `${v.field} の版には保存された内容がないため、復元できません。`,
    en: (v) => `The revision named by ${v.field} has no stored content and cannot be restored.`,
  },
  "core.skill_patch_empty": {
    ja: (v) => `${v.field} に、更新するスキルの項目を 1 つ以上指定してください。`,
    en: (v) => `${v.field} must contain at least one skill field to update.`,
  },
  "core.skill_proposal_status_invalid": {
    ja: (v) => `${v.field} がスキル提案の状態として正しくありません。`,
    en: (v) => `${v.field} is not a valid skill proposal status.`,
  },
  "core.rule_proposal_status_invalid": {
    ja: (v) => `${v.field} がルール提案の状態として正しくありません。`,
    en: (v) => `${v.field} is not a valid rule proposal status.`,
  },
  "core.string_required": {
    ja: (v) => `${v.field} は文字列にしてください。`,
    en: (v) => `${v.field} must be a string.`,
  },
  "core.knowledge_move_mode_invalid": {
    ja: (v) => `${v.field} は move か relink にしてください。`,
    en: (v) => `${v.field} must be move or relink.`,
  },
  "core.learning_job_status_invalid": {
    ja: (v) => `${v.field} が学習ジョブの状態として正しくありません。`,
    en: (v) => `${v.field} is not a valid learning job status.`,
  },
  "core.skill_name_invalid": {
    ja: (v) => `${v.field} がスキル名として正しくありません。`,
    en: (v) => `${v.field} is not a valid skill name.`,
  },
  "core.boolean_required": {
    ja: (v) => `${v.field} は true か false にしてください。`,
    en: (v) => `${v.field} must be true or false.`,
  },
  "core.absolute_path_required": {
    ja: (v) => `${v.field} は絶対パスにしてください。`,
    en: (v) => `${v.field} must be an absolute path.`,
  },
  "core.positive_integer_required": {
    ja: (v) => `${v.field} は 1 以上の整数にしてください。`,
    en: (v) => `${v.field} must be a positive integer.`,
  },
  "core.backlog_status_invalid": {
    ja: (v) => `${v.field} が backlog の状態として正しくありません。`,
    en: (v) => `${v.field} is not a valid backlog status.`,
  },
  "core.cancel_reason_length": {
    ja: (v) => `${v.field} は 1〜1,000 文字にしてください。`,
    en: (v) => `${v.field} must be between 1 and 1,000 characters.`,
  },
  "core.ulid_required": {
    ja: (v) => `${v.field} は ULID の形式にしてください。`,
    en: (v) => `${v.field} must be a canonical ULID.`,
  },
  "core.work_update_empty": {
    ja: (v) => `${v.field} か summary のどちらかに新しい値を指定してください。`,
    en: (v) => `Specify a new value for ${v.field} or summary.`,
  },
  "core.work_title_length": {
    ja: (v) => `${v.field} は 1〜500 文字にしてください。`,
    en: (v) => `${v.field} must be between 1 and 500 characters.`,
  },
  "core.work_summary_too_long": {
    ja: (v) => `${v.field} は 20,000 文字以内にしてください。`,
    en: (v) => `${v.field} must be at most 20,000 characters.`,
  },
  "core.commit_language_invalid": {
    ja: (v) => `${v.field} は "ja"、"en"、null のいずれかにしてください。`,
    en: (v) => `${v.field} must be "ja", "en" or null.`,
  },
  "core.fields_required_together": {
    ja: (v) => `${v.fields} は両方をそろえて指定してください。`,
    en: (v) => `${v.fields} must be provided together.`,
  },
  "core.project_name_length": {
    ja: (v) => `${v.field} は 1〜200 文字にしてください。`,
    en: (v) => `${v.field} must be between 1 and 200 characters.`,
  },
  "core.confirmed_work_count_invalid": {
    ja: (v) => `${v.field} は 0 以上の整数にしてください。`,
    en: (v) => `${v.field} must be an integer of 0 or more.`,
  },
  "core.process_skills_settings_invalid": {
    ja: (v) => `${v.field} は、真偽値の enabled と、null か文字列の path を持つオブジェクトにしてください。`,
    en: (v) => `${v.field} must contain a boolean enabled value and a nullable path.`,
  },
  "core.process_skills_path_incomplete": {
    ja: (v) => `${v.field} のフォルダに、必要なスキルのファイルがありません。`,
    en: (v) => `The folder in ${v.field} does not contain the required skill files.`,
  },
  "core.history_limit_invalid": {
    ja: (v) => `${v.field} は 1〜${v.max} の整数にしてください。`,
    en: (v) => `${v.field} must be an integer between 1 and ${v.max}.`,
  },
  "core.non_negative_integer_required": {
    ja: (v) => `${v.field} は 0 以上の整数にしてください。`,
    en: (v) => `${v.field} must be a non-negative integer.`,
  },
  "core.model_presets_limit": {
    ja: (v) => `${v.field} は ${v.max} 件までです。`,
    en: (v) => `${v.field} are limited to ${v.max}.`,
  },
  "core.model_preset_update_empty": {
    ja: (v) => `${v.field} に name か roles のどちらかを指定してください。`,
    en: (v) => `${v.field} must contain a name or roles to update.`,
  },
  "core.no_new_messages": {
    ja: (v) => `${v.field} の会話に、要約する新しいメッセージがありません。`,
    en: (v) => `The conversation in ${v.field} has no new messages to summarise.`,
  },
  "core.advisor_read_through_invalid": {
    ja: (v) => `${v.field} は、この窓にある Advisor のメッセージにしてください。`,
    en: (v) => `${v.field} must be an Advisor message in this window.`,
  },
  "core.inbound_field_invalid": {
    ja: (v) => `受信メッセージの ${v.field} が正しくありません。`,
    en: (v) => `The inbound message's ${v.field} is invalid.`,
  },
  "core.inbound_received_at_invalid": {
    ja: (v) => `受信メッセージの ${v.field} は RFC3339 の形式にしてください。`,
    en: (v) => `The inbound message's ${v.field} must be RFC3339.`,
  },
  "core.attachment_ids_invalid": {
    ja: (v) => `${v.field} は重複しない ULID で、${v.max} 件以内にしてください。`,
    en: (v) => `${v.field} must be at most ${v.max} unique ULIDs.`,
  },
  "core.inbound_account_mismatch": {
    ja: (v) => `${v.field} の接続アカウントは、この Owner とプロバイダーのものではありません。`,
    en: (v) => `The connector account in ${v.field} does not belong to this Owner and provider.`,
  },
  "core.connector_field_invalid": {
    ja: (v) => `接続アカウントの ${v.field} が正しくありません。`,
    en: (v) => `The connector account's ${v.field} is invalid.`,
  },
  "core.connector_account_conflict": {
    ja: (v) => `${v.field} の接続アカウントは、別の Owner かプロバイダーのものです。`,
    en: (v) => `The connector account in ${v.field} is owned by another Owner or provider.`,
  },
  "core.inbound_upload_field_invalid": {
    ja: (v) => `受信アップロードの ${v.field} が正しくありません。`,
    en: (v) => `The inbound upload's ${v.field} is invalid.`,
  },
  "core.upload_filename_invalid": {
    ja: (v) => `${v.field} にパスの区切りや制御文字を含められません。`,
    en: (v) => `${v.field} must not contain a path separator or control character.`,
  },
  "core.sha256_invalid": {
    ja: (v) => `${v.field} は小文字の SHA-256 の 16 進文字列にしてください。`,
    en: (v) => `${v.field} must be a lowercase SHA-256 hex string.`,
  },
  "core.upload_conversation_target_invalid": {
    ja: (v) => `${v.field} と conversation_hint は、どちらか 1 つだけを指定してください。`,
    en: (v) => `Specify exactly one of ${v.field} or conversation_hint.`,
  },
  "core.upload_work_mismatch": {
    ja: (v) => `${v.field} が会話の Work と一致しません。`,
    en: (v) => `${v.field} does not match the conversation.`,
  },
  "core.upload_metadata_invalid": {
    ja: (v) => `アップロードの ${v.field} のメタデータが正しくありません。`,
    en: (v) => `The upload's ${v.field} metadata is invalid.`,
  },
  "core.upload_size_mismatch": {
    ja: (v) => `アップロードされたバイト数（${v.bytes}）が ${v.field}（${v.declared_bytes}）と一致しません。`,
    en: (v) => `The uploaded bytes (${v.bytes}) do not match ${v.field} (${v.declared_bytes}).`,
  },
  "core.advisor_provider_unconfigured": {
    ja: (v) => `Advisor のプロバイダー ${v.provider}（${v.field}）の設定が足りません。`,
    en: (v) => `Advisor provider ${v.provider} (${v.field}) is not fully configured: ${v.detail}`,
  },
  "core.advisor_provider_unmapped": {
    ja: (v) => `Advisor のプロバイダー ${v.provider}（${v.field}）は、対応する harness に割り当てられていません。Advisor を始める前に設定してください。`,
    en: (v) => `Advisor provider ${v.provider} (${v.field}) is not mapped to a supported harness. Configure it before starting the Advisor.`,
  },
  "core.message_body_invalid": {
    ja: (v) => `${v.field} は 100,000 文字以内の文字列にしてください。`,
    en: (v) => `${v.field} must be a string of at most 100,000 characters.`,
  },
  "core.message_empty": {
    ja: (v) => `${v.field} を入力するか、ファイルを添付してください。`,
    en: (v) => `Enter ${v.field} or attach a file.`,
  },
  "core.role_model_effort_missing": {
    ja: (v) => `${v.field} の ${v.role} に、effort のあるモデルが設定されていません。`,
    en: (v) => `${v.field} has no model with an effort configured for ${v.role}.`,
  },
  "core.stored_setting_malformed": {
    ja: (v) => `保存済みの ${v.field} の形式が正しくありません。`,
    en: (v) => `The stored ${v.field} is not shaped as expected.`,
  },
  "core.model_preset_name_length": {
    ja: (v) => `${v.field} は 1〜${v.max} 文字にしてください。`,
    en: (v) => `${v.field} must be between 1 and ${v.max} characters.`,
  },
  "core.model_preset_name_duplicate": {
    ja: (v) => `${v.field} は、すでに別のプリセットで使われています。`,
    en: (v) => `A model preset named by ${v.field} already exists.`,
  },
  "core.model_roles_count": {
    ja: (v) => `${v.field} には、決められた ${v.count} 個の役割をちょうど 1 つずつ入れてください。`,
    en: (v) => `${v.field} must contain exactly the ${v.count} canonical roles.`,
  },
  "core.model_role_entry_invalid": {
    ja: (v) => `${v.field} の ${v.index} 番目の要素はオブジェクトにしてください。`,
    en: (v) => `Entry ${v.index} of ${v.field} must be an object.`,
  },
  "core.model_role_unknown": {
    ja: (v) => `${v.field} の ${v.index} 番目の role は、advisor、manager、designer、lead_designer、worker、fixer、reviewer、librarian、curator のいずれかにしてください。`,
    en: (v) => `The role of entry ${v.index} in ${v.field} must be one of advisor, manager, designer, lead_designer, worker, fixer, reviewer, librarian, curator.`,
  },
  "core.model_role_duplicate": {
    ja: (v) => `${v.field} で role ${v.role} が重複しています。`,
    en: (v) => `Role ${v.role} is duplicated in ${v.field}.`,
  },
  "core.model_provider_required": {
    ja: (v) => `${v.field} の ${v.role} の provider は空でない文字列にしてください。`,
    en: (v) => `The provider of ${v.role} in ${v.field} must be a non-empty string.`,
  },
  "core.model_model_required": {
    ja: (v) => `${v.field} の ${v.role} の model は空でない文字列にしてください。`,
    en: (v) => `The model of ${v.role} in ${v.field} must be a non-empty string.`,
  },
  "core.model_effort_invalid": {
    ja: (v) => `${v.field} の ${v.role} の effort は low、medium、high、xhigh、max のいずれかにしてください。`,
    en: (v) => `The effort of ${v.role} in ${v.field} must be low, medium, high, xhigh or max.`,
  },
  "core.model_unavailable": {
    ja: (v) => `${v.field} のモデル ${v.model} は ${v.provider} で使えません。使えるモデル: ${v.known_models}。`,
    en: (v) => `Model ${v.model} (${v.field}) is not available for ${v.provider}. Known models: ${v.known_models}.`,
  },
  "core.verification_plan_not_array": {
    ja: (v) => `${v.field} は配列にしてください。`,
    en: (v) => `${v.field} must be an array.`,
  },
  "core.verification_plan_entry_not_object": {
    ja: (v) => `${v.field} の ${v.index} 番目の要素はオブジェクトにしてください。`,
    en: (v) => `Entry ${v.index} of ${v.field} must be an object.`,
  },
  "core.verification_plan_entry_invalid": {
    ja: (v) => `${v.field} の ${v.index} 番目の要素が、VerificationCommand の形に合っていません。`,
    en: (v) => `Entry ${v.index} of ${v.field} does not match the VerificationCommand contract.`,
  },
  "core.allowed_roots_invalid": {
    ja: (v) => `${v.field} は、空でない文字列の配列にしてください。`,
    en: (v) => `${v.field} must be an array of non-empty strings.`,
  },
  "core.cursor_invalid": {
    ja: (v) => `${v.field} が正しくありません。`,
    en: (v) => `${v.field} is invalid.`,
  },
  "core.list_limit_invalid": {
    ja: (v) => `${v.field} は 1〜200 の整数にしてください。`,
    en: (v) => `${v.field} must be an integer between 1 and 200.`,
  },
  "core.command_array_invalid": {
    ja: (v) => `${v.field} は文字列の配列（先頭がコマンド名、空配列で未設定）にしてください。`,
    en: (v) => `${v.field} must be an array of strings (command name first; an empty array clears it).`,
  },
  "core.report_check_commands_invalid": {
    ja: (v) => `${v.field} は、空でないコマンド文字列の配列（null か空配列で未設定）にしてください。`,
    en: (v) => `${v.field} must be an array of non-empty command strings (null or an empty array clears them).`,
  },
  "core.screen_paths_invalid": {
    ja: (v) => `${v.field} は {include, exclude}（worktree からの相対 glob の配列。null か include が空で未設定）にしてください。`,
    en: (v) => `${v.field} must be {include, exclude}, arrays of glob patterns relative to the worktree (null or an empty include clears it).`,
  },
  "core.test_run_settings_invalid": {
    ja: (v) => `テスト実行の設定（${v.field}）が正しくありません。${v.problems.map((problem) => `${testRunClause(problem, "ja")}。`).join("")}`,
    en: (v) => `Invalid ${v.field} settings: ${v.problems.map((problem) => testRunClause(problem, "en")).join("; ")}.`,
  },
  "core.test_policy_settings_invalid": {
    ja: (v) => `テスト方針の設定（${v.field}）が正しくありません。${v.problems.map((problem) => `${testPolicyClause(problem, "ja")}。`).join("")}`,
    en: (v) => `Invalid ${v.field} settings: ${v.problems.map((problem) => testPolicyClause(problem, "en")).join("; ")}.`,
  },
  "core.executor_harness_entry_invalid": {
    ja: (v) => `${v.field} には model と effort を持つオブジェクトを指定してください。`,
    en: (v) => `${v.field} needs a model and effort.`,
  },
  "core.executor_model_length": {
    ja: (v) => `${v.field} は 1〜200 文字の文字列にしてください。`,
    en: (v) => `${v.field} must be a string of 1 to 200 characters.`,
  },
  "core.opencode_model_format": {
    ja: (v) => `${v.field} は providerID/modelID の形にしてください。`,
    en: (v) => `${v.field} must look like providerID/modelID.`,
  },
  "core.executor_model_null": {
    ja: (v) => `claude と codex の Executor では、${v.field} を null にできません。`,
    en: (v) => `${v.field} cannot be null for the claude and codex Executors.`,
  },
  "core.executor_effort_invalid": {
    ja: (v) => `${v.field} は null か、対応している effort にしてください。`,
    en: (v) => `${v.field} must be null or a supported effort.`,
  },
  "core.executor_harness_invalid": {
    ja: (v) => `${v.field} は claude、codex、opencode のいずれかにしてください。`,
    en: (v) => `${v.field} must be claude, codex or opencode.`,
  },
  "core.object_required": {
    ja: (v) => `${v.field} はオブジェクトにしてください。`,
    en: (v) => `${v.field} must be an object.`,
  },
  "core.executor_model_required": {
    ja: (v) => `${v.harness} の Executor のモデル（${v.field}）を選んでください。`,
    en: (v) => `Choose a model (${v.field}) for the ${v.harness} Executor.`,
  },
  "core.integer_range": {
    ja: (v) => `${v.field} は ${v.min}〜${v.max} の整数にしてください。`,
    en: (v) => `${v.field} must be an integer from ${v.min} to ${v.max}.`,
  },
  "core.token_relay_models_count": {
    ja: (v) => `${v.field} は 0〜${v.max} 件の provider/model オブジェクトにしてください。`,
    en: (v) => `${v.field} must contain 0 to ${v.max} provider/model objects.`,
  },
  "core.token_relay_model_invalid": {
    ja: (v) => `${v.field} の ${v.index} 番目は provider/model オブジェクトにしてください。`,
    en: (v) => `Entry ${v.index} of ${v.field} must be a provider/model object.`,
  },
  "core.token_relay_provider_unsupported": {
    ja: (v) => `${v.field} の ${v.index} 番目は、Claude の子だけを指定できます。`,
    en: (v) => `Entry ${v.index} of ${v.field} must be a Claude child; token relay supports only Claude.`,
  },
  "core.token_relay_model_duplicate": {
    ja: (v) => `${v.field} の ${v.index} 番目が重複しています。`,
    en: (v) => `Entry ${v.index} of ${v.field} is a duplicate.`,
  },
  "core.token_relay_tokens_range": {
    ja: (v) => `${v.field} は ${v.min} から ${v.max} の整数にしてください。`,
    en: (v) => `${v.field} must be an integer from ${v.min} to ${v.max}.`,
  },
  "core.token_relay_tokens_order": {
    ja: (v) => `${v.field}（引き継ぎの上限）は、停止の上限より小さくしてください。`,
    en: (v) => `${v.field} (the handoff limit) must be lower than the stop limit.`,
  },
  "core.token_relay_max_relays": {
    ja: (v) => `${v.field} は ${v.min} から ${v.max} の整数にしてください。`,
    en: (v) => `${v.field} must be an integer from ${v.min} to ${v.max}.`,
  },
  "core.token_relay_report_threshold": {
    ja: (v) => `${v.field} は ${v.min} から ${v.max} の整数にしてください。`,
    en: (v) => `${v.field} must be an integer from ${v.min} to ${v.max}.`,
  },
  "core.researcher_model_invalid": {
    ja: (v) => `${v.field} は空でないモデル名にしてください。`,
    en: (v) => `${v.field} must be a non-empty model name.`,
  },
  "core.researcher_turns_range": {
    ja: (v) => `${v.field} は ${v.min}〜${v.max} の整数にしてください。`,
    en: (v) => `${v.field} must be an integer from ${v.min} to ${v.max}.`,
  },
  "core.researcher_answer_range": {
    ja: (v) => `${v.field} は ${v.min}〜${v.max} の整数にしてください。`,
    en: (v) => `${v.field} must be an integer from ${v.min} to ${v.max}.`,
  },
  "core.skill_settings_fields_mismatch": {
    ja: (v) => `${v.field} の項目が、対応している設定と合いません（不足: ${v.missing}、余分: ${v.extra}）。`,
    en: (v) => `The fields of ${v.field} do not match the supported settings (missing: ${v.missing}; extra: ${v.extra}).`,
  },
  "core.skill_settings_mode_invalid": {
    ja: (v) => `${v.field} は autonomous か conservative にしてください。`,
    en: (v) => `${v.field} must be autonomous or conservative.`,
  },
  "core.confidence_threshold_range": {
    ja: (v) => `${v.field} は 0〜1 の数にしてください。`,
    en: (v) => `${v.field} must be between 0 and 1.`,
  },
  "core.feedback_weights_invalid": {
    ja: (v) => `${v.field} には、major_finding、replan、owner_correction のそれぞれに 0 以上の数を指定してください。`,
    en: (v) => `${v.field} must hold a non-negative number for major_finding, replan and owner_correction.`,
  },
  "core.skill_snapshot_invalid": {
    ja: (v) => `保存済みのスキルの版の内容（${v.field}）が正しくありません。`,
    en: (v) => `The stored skill revision content (${v.field}) is invalid.`,
  },
  "core.skill_input_invalid": {
    ja: (v) => SKILL_INPUT_ERRORS.get(v.error_code)?.ja ?? `スキルの内容（${v.field}）が正しくありません（エラーコード: ${v.error_code}）。`,
    en: (v) => SKILL_INPUT_ERRORS.get(v.error_code)?.en ?? `The skill input (${v.field}) is invalid (error code: ${v.error_code}).`,
  },
  "core.skill_md_invalid": {
    ja: (v) => SKILL_MD_PROBLEMS.get(v.problem)?.ja(v.key ?? "") ?? `${v.field} が正しくありません。`,
    en: (v) => SKILL_MD_PROBLEMS.get(v.problem)?.en(v.key ?? "") ?? `${v.field} is invalid.`,
  },
};
