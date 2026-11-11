import type { OtherReasonValues } from "@owl/core";
import type { ReasonTable } from "./types.js";

/** Sentences for the other packages/core/src files' reason codes (T44). */
export const otherReasons: ReasonTable<keyof OtherReasonValues> = {
  "advisor.delivery_id_invalid": {
    ja: (v) => `${v.field} は 1〜128 文字の文字列で指定してください。`,
    en: (v) => `${v.field} must be a string of 1 to 128 characters.`,
  },
  "advisor.delivery_report_incomplete": {
    ja: (v) => `配信報告には turn_id、message_id と、1 件以上の ${v.field} が必要です。`,
    en: (v) => `The delivery report needs turn_id, message_id and at least one ${v.field}.`,
  },
  "advisor.delivery_index_invalid": {
    ja: (v) => `${v.field} は 0 以上の整数で指定してください。`,
    en: (v) => `${v.field} must be a non-negative integer.`,
  },
  "advisor.delivery_outcome_invalid": {
    ja: (v) => `${v.index} 番目の ${v.field} は sent、failed、unknown のどれかにしてください。`,
    en: (v) => `${v.field} of result ${v.index} must be sent, failed or unknown.`,
  },
  "advisor.delivery_code_mismatch": {
    ja: (v) => `${v.index} 番目の ${v.field} が outcome と合っていません。`,
    en: (v) => `${v.field} of result ${v.index} does not match its outcome.`,
  },
  "advisor.delivery_platform_error_invalid": {
    ja: (v) => `${v.index} 番目の ${v.field} は null か ${v.max} 文字以内の文字列にしてください。`,
    en: (v) => `${v.field} of result ${v.index} must be null or a string of at most ${v.max} characters.`,
  },
  "advisor.delivery_message_invalid": {
    ja: (v) => `${v.index} 番目の ${v.field} は ${v.max} 文字以内の文字列にしてください。`,
    en: (v) => `${v.field} of result ${v.index} must be a string of at most ${v.max} characters.`,
  },
  "advisor.delivery_index_repeated": {
    ja: (v) => `${v.field} を重複させないでください。`,
    en: (v) => `${v.field} values must not repeat.`,
  },
  "advisor.delivery_index_unknown": {
    ja: (v) => `${v.field} ${v.index} は返信の outbound_files にありません。`,
    en: (v) => `${v.field} ${v.index} is not one of the reply's outbound_files.`,
  },
  "artifact.content_differs": {
    ja: (v) => `${v.field} の保存先に、内容の違うファイルがすでにあります。`,
    en: (v) => `${v.field} already contains different content.`,
  },
  "failure_notice.field_not_string": {
    ja: (v) => `${v.field} は文字列で指定してください。`,
    en: (v) => `${v.field} must be a string.`,
  },
  "failure_notice.not_object": {
    ja: (v) => `通知 (${v.field}) はオブジェクトで指定してください。`,
    en: (v) => `The notice (${v.field}) must be an object.`,
  },
  "failure_notice.project_id_invalid": {
    ja: (v) => `${v.field} は Project の ULID で指定してください。`,
    en: (v) => `${v.field} must be a Project ULID.`,
  },
  "failure_notice.kind_invalid": {
    ja: (v) => `${v.field} は ${v.kinds} のどれかにしてください。`,
    en: (v) => `${v.field} must be one of ${v.kinds}.`,
  },
  "failure_notice.title_length": {
    ja: (v) => `${v.field} は 1〜${v.max} 文字にしてください。`,
    en: (v) => `${v.field} must be 1 to ${v.max} characters.`,
  },
  "failure_notice.dedupe_hint_empty": {
    ja: (v) => `${v.field} を空にしないでください。`,
    en: (v) => `${v.field} must not be empty.`,
  },
  "failure_notice.occurred_at_invalid": {
    ja: (v) => `${v.field} は ISO 8601 の時刻で指定してください。`,
    en: (v) => `${v.field} must be an ISO 8601 time.`,
  },
  "failure_notice.exit_code_invalid": {
    ja: (v) => `${v.field} は整数で指定してください。`,
    en: (v) => `${v.field} must be an integer.`,
  },
  "stored.field_not_string_array": {
    ja: (v) => `保存済みの ${v.resource} の ${v.field} に、文字列でない値があります。`,
    en: (v) => `Stored ${v.resource} field ${v.field} contains a non-string value.`,
  },
  "stored.field_not_array": {
    ja: (v) => `保存済みの ${v.resource} の ${v.field} が配列ではありません。`,
    en: (v) => `Stored ${v.resource} field ${v.field} is not an array.`,
  },
  "stored.not_object": {
    ja: (v) => `保存済みの ${v.field} ${v.id} がオブジェクトではありません。`,
    en: (v) => `Stored ${v.field} ${v.id} is not an object.`,
  },
  "request.not_object": {
    ja: (v) => `${v.operation} の要求 (${v.field}) が正しいオブジェクトではありません。`,
    en: (v) => `The ${v.operation} request (${v.field}) is not a valid object.`,
  },
  "request.work_id_missing": {
    ja: (v) => `${v.operation} の要求に ${v.field} がありません。`,
    en: (v) => `The ${v.operation} request is missing ${v.field}.`,
  },
  "request.task_id_invalid": {
    ja: (v) => `${v.operation} の要求の ${v.field} が正しくありません。`,
    en: (v) => `The ${v.operation} request has an invalid ${v.field}.`,
  },
  "decision.field_required": {
    ja: (v) => `Decision には ${v.field} が必要です。`,
    en: (v) => `A Decision requires ${v.field}.`,
  },
  "decision.option_field_required": {
    ja: (v) => `Decision の選択肢には ${v.field} が必要です。`,
    en: (v) => `Every Decision option requires ${v.field}.`,
  },
  "decision.option_keys_not_unique": {
    ja: (v) => `Decision の選択肢の ${v.field} は重複させないでください。`,
    en: (v) => `Decision option ${v.field} values must be unique.`,
  },
  "decision.options_or_free_text_required": {
    ja: (v) => `Decision には ${v.field} か自由記述の回答が必要です。`,
    en: (v) => `A Decision needs ${v.field} or a free-text answer.`,
  },
  "decision.recommended_unknown": {
    ja: (v) => `${v.field} は選択肢のどれかにしてください。`,
    en: (v) => `${v.field} must be one of the options.`,
  },
  "decision.stored_json_invalid": {
    ja: (v) => `保存済みの Decision ${v.decision_id} の ${v.field} に正しくない JSON があります。`,
    en: (v) => `A stored Decision ${v.decision_id} contains invalid JSON in ${v.field}.`,
  },
  "decision.list_limit_invalid": {
    ja: (v) => `一覧の ${v.field} は ${v.min}〜${v.max} の整数にしてください。`,
    en: (v) => `List ${v.field} must be an integer between ${v.min} and ${v.max}.`,
  },
  "design_mock.html_empty": {
    ja: (v) => `${v.field} は空でない文字列で指定してください。`,
    en: (v) => `${v.field} must be a non-empty string.`,
  },
  "design_mock.name_invalid": {
    ja: (v) => `${v.field} は小文字・数字・ハイフンと拡張子 .html で指定してください。`,
    en: (v) => `${v.field} must be lowercase letters, digits and hyphens with the .html extension.`,
  },
  "goal_shortfall.reason_blank": {
    ja: (v) => `最終確認の Manager の判定で、goal の ${v.field} が空です。`,
    en: (v) => `The final Manager verdict has a blank ${v.field} for a goal.`,
  },
  "attachment.not_in_conversation": {
    ja: (v) => `受信した ${v.field} は、対象の会話のものにしてください。`,
    en: (v) => `Inbound ${v.field} must belong to the resolved conversation.`,
  },
  "attachment.upload_not_completed": {
    ja: (v) => `受信した ${v.field} は、アップロードが完了したものにしてください。`,
    en: (v) => `Inbound ${v.field} must reference a completed upload.`,
  },
  "nightly.time_invalid": {
    ja: (v) => `${v.field} は HH:MM の形式で指定してください。`,
    en: (v) => `${v.field} must be HH:MM.`,
  },
  "provider_pause.provider_empty": {
    ja: (v) => `${v.field} は空でない文字列で指定してください。`,
    en: (v) => `${v.field} must be a non-empty string.`,
  },
  "provider_pause.timestamp_invalid": {
    ja: (v) => `${v.field} は正しい日時の文字列で指定してください。`,
    en: (v) => `${v.field} must be a valid date string.`,
  },
  "backlog.list_limit_invalid": {
    ja: (v) => `${v.field} は 1〜${v.max} の整数にしてください。`,
    en: (v) => `Backlog list ${v.field} must be an integer between 1 and ${v.max}.`,
  },
  "backlog.list_offset_invalid": {
    ja: (v) => `${v.field} は 0 以上の整数にしてください。`,
    en: (v) => `Backlog list ${v.field} must be a non-negative integer.`,
  },
  "backlog.work_details_invalid": {
    ja: (v) => `Work の内容 (${v.field}) が正しくありません。`,
    en: (v) => `Backlog Work details (${v.field}) are invalid.`,
  },
  "backlog.items_project_mismatch": {
    ja: (v) => `${v.field} の backlog 項目は、同じ Project のものにしてください。`,
    en: (v) => `Backlog items in ${v.field} must belong to the same Project.`,
  },
  "backlog.title_length": {
    ja: (v) => `${v.field} は 1〜${v.max} 文字にしてください。`,
    en: (v) => `Work ${v.field} must contain between 1 and ${v.max} characters.`,
  },
  "backlog.summary_too_long": {
    ja: (v) => `${v.field} は ${v.max} 文字以内にしてください。`,
    en: (v) => `Work ${v.field} cannot exceed ${v.max} characters.`,
  },
  "backlog.link_dismiss_overlap": {
    ja: (v) => `同じ backlog 項目を紐づけと却下の両方に指定できません (${v.field})。`,
    en: (v) => `A backlog item cannot be both linked and dismissed (${v.field}).`,
  },
  "backlog.items_project_differs_from_work": {
    ja: (v) => `${v.field} の backlog 項目は、Work と同じ Project のものにしてください。`,
    en: (v) => `Backlog items in ${v.field} must belong to the same Project as the Work.`,
  },
  "backlog.item_ids_invalid": {
    ja: (v) => `${v.field} は重複しない文字列の空でない一覧 (最大 ${v.max} 件) にしてください。`,
    en: (v) => `${v.field} must be a non-empty list of unique strings (up to ${v.max}).`,
  },
  "settings.invalid": {
    ja: (v) => `設定 ${v.field} が正しくありません。`,
    en: (v) => `Setting ${v.field} is invalid.`,
  },
  "settings.not_object": {
    ja: (v) => `設定 ${v.field} はオブジェクトにしてください。`,
    en: (v) => `Setting ${v.field} must be an object.`,
  },
  "settings.exact_keys": {
    ja: (v) => `設定 ${v.field} のキーは ${v.keys} の組と一致させてください。`,
    en: (v) => `Setting ${v.field} must contain exactly these keys: ${v.keys}.`,
  },
  "settings.boolean": {
    ja: (v) => `設定 ${v.field} は true か false にしてください。`,
    en: (v) => `Setting ${v.field} must be true or false.`,
  },
  "settings.integer_min": {
    ja: (v) => `設定 ${v.field} は ${v.min} 以上の整数にしてください。`,
    en: (v) => `Setting ${v.field} must be an integer of at least ${v.min}.`,
  },
  "settings.integer_range": {
    ja: (v) => `設定 ${v.field} は ${v.min} から ${v.max} までの整数にしてください。`,
    en: (v) => `Setting ${v.field} must be an integer from ${v.min} to ${v.max}.`,
  },
  "settings.number_range": {
    ja: (v) => `設定 ${v.field} は ${v.min} から ${v.max} までの数にしてください。`,
    en: (v) => `Setting ${v.field} must be a number from ${v.min} to ${v.max}.`,
  },
  "settings.one_of": {
    ja: (v) => `設定 ${v.field} は次のいずれかにしてください: ${v.allowed}。`,
    en: (v) => `Setting ${v.field} must be one of: ${v.allowed}.`,
  },
  "settings.keys": {
    ja: (v) => `設定 ${v.field} には必須のキー ${v.required} をすべて含め、ほかには任意のキー ${v.optional} だけを使ってください。`,
    en: (v) => `Setting ${v.field} must contain all of ${v.required} and may contain only ${v.optional} besides them.`,
  },
  "settings.known_keys": {
    ja: (v) => `設定 ${v.field} には 1 つ以上のキーを含め、キーは ${v.keys} のいずれかにしてください。`,
    en: (v) => `Setting ${v.field} must contain at least one key, and only these keys: ${v.keys}.`,
  },
  "settings.array": {
    ja: (v) => `設定 ${v.field} は配列にしてください。`,
    en: (v) => `Setting ${v.field} must be an array.`,
  },
  "settings.array_length": {
    ja: (v) => `設定 ${v.field} は ${v.min} 件から ${v.max} 件までの配列にしてください。`,
    en: (v) => `Setting ${v.field} must be an array of ${v.min} to ${v.max} items.`,
  },
  "settings.string": {
    ja: (v) => `設定 ${v.field} はヌル文字を含まない文字列にしてください。`,
    en: (v) => `Setting ${v.field} must be a string without NUL characters.`,
  },
  "settings.non_empty_string": {
    ja: (v) => `設定 ${v.field} はヌル文字を含まない空でない文字列にしてください。`,
    en: (v) => `Setting ${v.field} must be a non-empty string without NUL characters.`,
  },
  "settings.string_list": {
    ja: (v) => `設定 ${v.field} は文字列の配列にしてください。`,
    en: (v) => `Setting ${v.field} must be an array of strings.`,
  },
  "settings.non_empty_string_list": {
    ja: (v) => `設定 ${v.field} は空でない文字列の配列にしてください。`,
    en: (v) => `Setting ${v.field} must be an array of non-empty strings.`,
  },
  "settings.regex_list": {
    ja: (v) => `設定 ${v.field} は正しい正規表現 (空でない文字列) の配列にしてください。`,
    en: (v) => `Setting ${v.field} must be an array of valid regular expressions (non-empty strings).`,
  },
  "settings.regex_with_group": {
    ja: (v) => `設定 ${v.field} はキャプチャグループ 1 を持つ正しい正規表現にしてください。`,
    en: (v) => `Setting ${v.field} must be a valid regular expression with capture group 1.`,
  },
  "settings.hh_mm_list": {
    ja: (v) => `設定 ${v.field} の時刻はすべて HH:MM の形 (00:00 から 23:59) にしてください。`,
    en: (v) => `Setting ${v.field} must contain only HH:MM times (00:00 to 23:59).`,
  },
  "settings.glob_list": {
    ja: (v) => `設定 ${v.field} の glob は、どれも ${v.max_length} 文字以下の空でない正しい glob にしてください。`,
    en: (v) => `Setting ${v.field} must contain only valid, non-empty globs of at most ${v.max_length} characters.`,
  },
  "settings.distinct_one_of_list": {
    ja: (v) => `設定 ${v.field} は ${v.allowed} から重複なく選んだ配列にしてください。`,
    en: (v) => `Setting ${v.field} must be an array of distinct values from: ${v.allowed}.`,
  },
  "settings.argv": {
    ja: (v) => `設定 ${v.field} には、空白だけでない最初の引数を含めてください。`,
    en: (v) => `Setting ${v.field} must contain a first argument that is not blank.`,
  },
  "settings.named_groups": {
    ja: (v) => `設定 ${v.field} はグループ名から glob の配列へのオブジェクトにし、グループは ${v.max_groups} 個以下、グループ名は 1 から ${v.max_name_length} 文字にしてください。`,
    en: (v) => `Setting ${v.field} must be an object of at most ${v.max_groups} groups whose names are 1 to ${v.max_name_length} characters.`,
  },
  "settings.channel_name_prefix": {
    ja: (v) => `設定 ${v.field} は ${v.max_length} 文字以下で、小文字・数字・「_」を 1 つの「-」で区切った形にしてください。末尾には「-」を 1 つ付けられます。`,
    en: (v) => `Setting ${v.field} must be at most ${v.max_length} lowercase letters, digits, "_" and single "-" separators, and may end in one "-".`,
  },
  "work_driver.work_id_required": {
    ja: (v) => `Work driver の登録には ${v.field} が必要です。`,
    en: (v) => `A Work driver registration requires ${v.field}.`,
  },
  "work_driver.positive_integer_required": {
    ja: (v) => `${v.field} は 1 以上の整数にしてください。`,
    en: (v) => `${v.field} must be a positive integer.`,
  },
  "work_markdown.path_invalid": {
    ja: (v) => `${v.field} は制御文字を含まない 1〜${v.max} 文字にしてください。`,
    en: (v) => `${v.field} must be 1 to ${v.max} characters without control characters.`,
  },
  "work_prerequisite.ids_not_array": {
    ja: (v) => `${v.field} は Work ID の配列にしてください。`,
    en: (v) => `${v.field} must be an array of Work IDs.`,
  },
  "work_prerequisite.ids_duplicate": {
    ja: (v) => `${v.field} には同じ Work を 2 回書かないでください。`,
    en: (v) => `${v.field} must list each Work once.`,
  },
  "work_prerequisite.ids_too_many": {
    ja: (v) => `${v.field} に書ける Work は最大 ${v.max} 件です。`,
    en: (v) => `${v.field} can list at most ${v.max} Works.`,
  },
  "work_prerequisite.self_reference": {
    ja: (v) => `Work 自身を ${v.field} に指定できません。`,
    en: (v) => `A Work cannot be its own entry in ${v.field}.`,
  },
  "work_prerequisite.not_found": {
    ja: (v) => `前提の Work ${v.id} が見つかりません。`,
    en: (v) => `Prerequisite Work ${v.id} was not found.`,
  },
  "work_prerequisite.cycle": {
    ja: (v) => `この前提を足すと、Work が互いを待つ形になります：${v.path}`,
    en: (v) => `These prerequisites would make Works wait on each other: ${v.path}.`,
  },
  "knowledge_storage.path_not_absolute": {
    ja: (v) => `${v.field} は絶対パスで指定してください。`,
    en: (v) => `The knowledge storage ${v.field} must be an absolute path.`,
  },
  "work_summary.manager_field_invalid": {
    ja: (v) => `Manager の ${v.field} は 1〜${v.max} 文字の文字列か null にしてください。`,
    en: (v) => `The Manager's ${v.field} must be a string of 1 to ${v.max} characters, or null.`,
  },
};
