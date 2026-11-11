import type { WorkflowReasonValues } from "@owl/core";
import type { ReasonTable } from "./types.js";

/** Sentences for workflow-engine.ts, state-reducer.ts, manager-orchestrator.ts reason codes (T43). */
const OPERATION_JA: Record<string, string> = { "manager plan": "Manager の計画", "manager replan": "Manager の再計画", "manager finalization": "Manager の最終判定" };
const opJa = (op: string): string => (Object.hasOwn(OPERATION_JA, op) ? OPERATION_JA[op] : op);

export const workflowReasons: ReasonTable<keyof WorkflowReasonValues> = {
  "workflow.model_settings_not_json": {
    ja: (v) => `保存済みのモデル設定（${v.key}）が JSON として読めません。`,
    en: (v) => `Stored model settings (${v.key}) are not valid JSON.`,
  },
  "workflow.model_settings_roles_missing": {
    ja: (v) => `保存済みのモデル設定（${v.key}）に roles 配列がありません。`,
    en: (v) => `Stored model settings (${v.key}) must contain a roles array.`,
  },
  "workflow.model_settings_role_invalid": {
    ja: (v) => `保存済みのモデル設定（${v.key}）に、${v.role} の provider と model の正しい組がありません。`,
    en: (v) => `Stored model settings (${v.key}) are missing a valid provider/model for ${v.role}.`,
  },
  "workflow.model_settings_effort_invalid": {
    ja: (v) => `保存済みのモデル設定（${v.key}）の ${v.role} の effort が正しくありません。`,
    en: (v) => `Stored model settings (${v.key}) contain an invalid effort for ${v.role}.`,
  },
  "workflow.positive_integer_required": {
    ja: (v) => `${v.field} は正の整数にしてください（指定値: ${v.value}）。`,
    en: (v) => `${v.field} must be a positive integer (given: ${v.value}).`,
  },
  "workflow.work_missing_for_plan": {
    ja: (v) => `Work ${v.work_id} が見つからないため、Task の計画を登録できません。`,
    en: (v) => `Cannot register a Task plan because Work ${v.work_id} was not found.`,
  },
  "workflow.cancelled_dependency_not_promotable": {
    ja: (v) => `Task ${v.task_id} の依存先がキャンセルされているため、ready にできません。`,
    en: (v) => `Task ${v.task_id} cannot be promoted to ready because a dependency was cancelled.`,
  },
  "workflow.hybrid_mode_setting_invalid": {
    ja: (v) => `保存済みのハイブリッドモード設定（${v.key}）が正しくありません。`,
    en: (v) => `Stored Hybrid Mode setting (${v.key}) is invalid.`,
  },
  "workflow.agent_report_not_marked_valid": {
    ja: (v) => `成功した AgentRunner の結果は、${v.field} を明示的に true にしてください（Task ${v.task_id}、実行 ${v.agent_run_id}）。`,
    en: (v) => `A successful AgentRunner result must explicitly set ${v.field} (Task ${v.task_id}, run ${v.agent_run_id}).`,
  },
  "workflow.agent_report_not_object": {
    ja: (v) => `成功した AgentRunner の結果には、${v.field} として JSON オブジェクトを含めてください（Task ${v.task_id}、実行 ${v.agent_run_id}）。`,
    en: (v) => `A successful AgentRunner result must include ${v.field} as a JSON object (Task ${v.task_id}, run ${v.agent_run_id}).`,
  },
  "workflow.error_key_missing": {
    ja: (v) => `${v.failure === "transient" ? "一時的な" : "決定的な"}失敗を返す AgentRunner の結果には ${v.field} が必要です（Task ${v.task_id}）。`,
    en: (v) => `A ${v.failure} AgentRunner failure must include ${v.field} (Task ${v.task_id}).`,
  },
  "workflow.provider_pause_controller_missing": {
    ja: (v) => `レート制限された Task ${v.task_id}（実行 ${v.agent_run_id}）には、プロバイダーの停止制御が必要です。`,
    en: (v) => `A rate-limited Task ${v.task_id} (run ${v.agent_run_id}) requires its provider pause controller.`,
  },
  "workflow.task_missing_before_verification": {
    ja: (v) => `Core の検証を始める前に Task ${v.task_id} が見つからなくなりました。`,
    en: (v) => `Task ${v.task_id} disappeared before Core verification started.`,
  },
  "workflow.task_advanced_before_reviewer": {
    ja: (v) => `Task ${v.task_id} は、Reviewer が始まる前にキャンセルされたか、先の状態に進みました。`,
    en: (v) => `Task ${v.task_id} was cancelled or advanced before its Reviewer started.`,
  },
  "workflow.task_missing_before_reviewer": {
    ja: (v) => `Core が Reviewer を始める前に Task ${v.task_id} が見つからなくなりました。`,
    en: (v) => `Task ${v.task_id} disappeared before Core started its Reviewer.`,
  },
  "workflow.reviewer_provider_failed": {
    ja: (v) => `Reviewer のプロバイダーが失敗しました（outcome=${v.outcome}、Task ${v.task_id}）。`,
    en: (v) => `Reviewer Provider failed (outcome=${v.outcome}, Task ${v.task_id}).`,
  },
  "workflow.reviewer_report_invalid": {
    ja: (v) => `Reviewer の結果には、有効な ${v.field} オブジェクトを含めてください（Task ${v.task_id}）。`,
    en: (v) => `The Reviewer result must include a valid ${v.field} object (Task ${v.task_id}).`,
  },
  "workflow.reviewer_verdict_missing": {
    ja: (v) => `Reviewer の結果には、レビューの ${v.field} を含めてください（Task ${v.task_id}）。`,
    en: (v) => `The Reviewer result must include its review ${v.field} (Task ${v.task_id}).`,
  },
  "workflow.reviewer_verdict_unknown": {
    ja: (v) => `Reviewer の ${v.field} が認識できない値です（Task ${v.task_id}）。`,
    en: (v) => `The Reviewer ${v.field} is not recognized (Task ${v.task_id}).`,
  },
  "workflow.reviewer_findings_or_tests_missing": {
    ja: (v) => `Reviewer の結果に ${v.field} がありません（Task ${v.task_id}）。`,
    en: (v) => `The Reviewer result is missing ${v.field} (Task ${v.task_id}).`,
  },
  "workflow.reviewer_goal_shortfalls_not_array": {
    ja: (v) => `Reviewer の ${v.field} は配列にしてください（Task ${v.task_id}）。`,
    en: (v) => `The Reviewer ${v.field} must be an array (Task ${v.task_id}).`,
  },
  "workflow.reviewer_goal_shortfall_not_goal": {
    ja: (v) => `Reviewer の ${v.field} に、goal ではない条件が含まれています（Task ${v.task_id}）。`,
    en: (v) => `The Reviewer ${v.field} names a criterion that is not a goal (Task ${v.task_id}).`,
  },
  "workflow.reviewer_goal_shortfall_reason_blank": {
    ja: (v) => `Reviewer の ${v.field} の理由が空です（Task ${v.task_id}）。`,
    en: (v) => `The Reviewer ${v.field} reason is blank (Task ${v.task_id}).`,
  },
  "workflow.reviewer_acceptance_defects_missing": {
    ja: (v) => `Reviewer が acceptance_defect を報告しましたが、${v.field} がありません（Task ${v.task_id}）。`,
    en: (v) => `The Reviewer reported acceptance_defect without ${v.field} (Task ${v.task_id}).`,
  },
  "workflow.reviewer_outcome_mismatch": {
    ja: (v) => `Reviewer の ${v.field}（${v.outcome}）が verdict（${v.verdict}）と合いません（Task ${v.task_id}）。`,
    en: (v) => `The Reviewer ${v.field} (${v.outcome}) does not match its verdict (${v.verdict}) (Task ${v.task_id}).`,
  },
  "workflow.merge_exit_code_invalid": {
    ja: (v) => `Git のマージ結果の ${v.field} が正しくありません（Task ${v.task_id}）。`,
    en: (v) => `The Git merge result has an invalid ${v.field} (Task ${v.task_id}).`,
  },
  "workflow.merge_success_with_nonzero_exit": {
    ja: (v) => `Git のマージ結果は成功とされていますが、${v.field} が 0 ではありません（Task ${v.task_id}）。`,
    en: (v) => `The Git merge result marked success with a non-zero ${v.field} (Task ${v.task_id}).`,
  },
  "state.reducer_guard_not_boolean": {
    ja: (v) => `Reducer のガード ${v.field} は、明示的な真偽値にしてください。`,
    en: (v) => `Reducer guard ${v.field} must be an explicit boolean.`,
  },
  "state.reducer_field_not_string": {
    ja: (v) => `Reducer の項目 ${v.field} は、空でない文字列にしてください。`,
    en: (v) => `Reducer field ${v.field} must be a non-empty string.`,
  },
  "state.reducer_field_not_count": {
    ja: (v) => `Reducer の項目 ${v.field} は、0 以上の整数にしてください。`,
    en: (v) => `Reducer field ${v.field} must be a non-negative integer.`,
  },
  "state.verification_outcome_invalid": {
    ja: (v) => `検証結果の ${v.field} は pass か fail にしてください。`,
    en: (v) => `Verification ${v.field} must be pass or fail.`,
  },
  "state.report_not_object": {
    ja: (v) => `有効な ${v.field} は JSON オブジェクトにしてください（実行 ${v.agent_run_id}）。`,
    en: (v) => `A valid ${v.field} must be a JSON object (run ${v.agent_run_id}).`,
  },
  "state.report_result_invalid": {
    ja: (v) => `有効な report の ${v.field} は success、failed、partial のいずれかにしてください（実行 ${v.agent_run_id}）。`,
    en: (v) => `A valid report ${v.field} must be success, failed, or partial (run ${v.agent_run_id}).`,
  },
  "state.work_title_length": {
    ja: (v) => `Work の ${v.field} は 1〜500 文字にしてください。`,
    en: (v) => `Work ${v.field} must contain between 1 and 500 characters.`,
  },
  "state.work_summary_too_long": {
    ja: (v) => `Work の ${v.field} は 20,000 文字以内にしてください。`,
    en: (v) => `Work ${v.field} cannot exceed 20,000 characters.`,
  },
  "state.work_size_invalid": {
    ja: (v) => `Work の ${v.field} は small、normal、large のいずれかにしてください。`,
    en: (v) => `Work ${v.field} must be small, normal, or large.`,
  },
  "state.work_design_mode_invalid": {
    ja: (v) => `Work の ${v.field} は auto か lead にしてください。`,
    en: (v) => `Work ${v.field} must be auto or lead.`,
  },
  "state.plan_dependency_outside_plan": {
    ja: (v) => `Task ${v.task_id} の ${v.field}（${v.depends_on_task_id}）は、同じ計画の Task を指してください。`,
    en: (v) => `The ${v.field} (${v.depends_on_task_id}) of Task ${v.task_id} must refer to a Task in the same plan.`,
  },
  "state.plan_dependency_cycle": {
    ja: (v) => `Task ${v.task_id} の ${v.field} が循環しています。`,
    en: (v) => `The ${v.field} of Task ${v.task_id} form a dependency cycle.`,
  },
  "state.task_identifier_invalid": {
    ja: (v) => `Manager の Task 識別子（${v.field}）は、重複のない空でない値にしてください（${v.task_id}）。`,
    en: (v) => `Every Manager Task identifier (${v.field}) must be unique and non-empty (${v.task_id}).`,
  },
  "state.task_identifier_conflict": {
    ja: (v) => `新しい Task の識別子（${v.field}）が、この Work の既存の Task と重複しています。`,
    en: (v) => `A new Task identifier (${v.field}) conflicts with an existing Task in this Work.`,
  },
  "state.task_title_length": {
    ja: (v) => `Task の ${v.field} は 1〜500 文字にしてください。`,
    en: (v) => `Task ${v.field} must contain between 1 and 500 characters.`,
  },
  "state.task_parent_outside_work": {
    ja: (v) => `Task の ${v.field}（${v.parent_task_id}）は、この Work の Task を指してください。`,
    en: (v) => `A Task ${v.field} (${v.parent_task_id}) must refer to a Task in this Work.`,
  },
  "state.task_dependency_outside_work": {
    ja: (v) => `Task の ${v.field}（${v.depends_on_task_id}）は、この Work の Task を指してください。`,
    en: (v) => `A Task ${v.field} (${v.depends_on_task_id}) must refer to a Task in this Work.`,
  },
  "state.dependency_outside_work": {
    ja: (v) => `Task ${v.task_id} の ${v.field}（${v.depends_on_task_id}）が、Work の外の Task を指しています。`,
    en: (v) => `The ${v.field} (${v.depends_on_task_id}) of Task ${v.task_id} references a Task outside the Work.`,
  },
  "state.dependency_cycle": {
    ja: (v) => `Task ${v.task_id} の ${v.field} が循環しています（再計画: ${v.replan}）。`,
    en: (v) => `The ${v.field} of Task ${v.task_id} form a dependency cycle (replan: ${v.replan}).`,
  },
  "state.replan_task_not_registered": {
    ja: (v) => `再計画の Task ${v.task_id}（${v.field}）が Work ${v.work_id} に登録されていません。`,
    en: (v) => `The replan Task ${v.task_id} (${v.field}) was not registered in Work ${v.work_id}.`,
  },
  "state.retried_dependency_outside_work": {
    ja: (v) => `やり直す Task ${v.task_id} の ${v.field}（${v.depends_on_task_id}）は、この Work の別の Task にしてください。`,
    en: (v) => `The ${v.field} (${v.depends_on_task_id}) of retried Task ${v.task_id} must be another Task of this Work.`,
  },
  "state.nonblocking_decision_blocks_tasks": {
    ja: (v) => `ブロックしない Decision では ${v.field} を指定できません。`,
    en: (v) => `A non-blocking Decision cannot set ${v.field}.`,
  },
  "state.decision_answer_length": {
    ja: (v) => `Decision の ${v.field} は 1〜${v.max} 文字にしてください。`,
    en: (v) => `Decision ${v.field} must contain between 1 and ${v.max} characters.`,
  },
  "state.decision_free_text_not_allowed": {
    ja: (v) => `Decision ${v.decision_id} は ${v.field} の自由記述を受け付けません。保存済みの選択肢から選んでください。`,
    en: (v) => `Decision ${v.decision_id} does not allow a free-text ${v.field}; select one of the stored options.`,
  },
  "state.decision_options_invalid": {
    ja: (v) => `Decision ${v.decision_id} に保存された ${v.field} の値が正しくありません。`,
    en: (v) => `The stored ${v.field} value of Decision ${v.decision_id} is invalid.`,
  },
  "state.decision_option_unknown": {
    ja: (v) => `選んだ ${v.field}（${v.option_key}）は、Decision ${v.decision_id} の保存済みの選択肢にありません。`,
    en: (v) => `The selected ${v.field} (${v.option_key}) is not one of the stored options of Decision ${v.decision_id}.`,
  },
  "state.decision_answer_label_mismatch": {
    ja: (v) => `${v.field} の文章は、選んだ選択肢（${v.option_key}）のラベルと同じにしてください（Decision ${v.decision_id}）。`,
    en: (v) => `The ${v.field} text must match the label of the selected option (${v.option_key}) of Decision ${v.decision_id}.`,
  },
  "state.decision_blocked_task_ids_invalid": {
    ja: (v) => `Decision ${v.decision_id} に保存された ${v.field} の値が正しくありません。`,
    en: (v) => `The stored ${v.field} value of Decision ${v.decision_id} is invalid.`,
  },
  "manager.plan_event_invalid": {
    ja: (v) => `Manager の計画は work.planned か task.replanned を返してください（${v.field}: ${v.event}、Work ${v.work_id}）。`,
    en: (v) => `The Manager plan must return work.planned or task.replanned (${v.field}: ${v.event}, Work ${v.work_id}).`,
  },
  "manager.result_contract_mismatch": {
    ja: (v) => `${opJa(v.operation)} の結果（${v.field}）が AgentRunner の契約に合っていません。`,
    en: (v) => `The ${v.operation} result (${v.field}) does not match the AgentRunner contract.`,
  },
  "manager.final_result_contract_mismatch": {
    ja: (v) => `最終 Manager の結果が、宣言された実行契約（${v.field}: ${v.mode}）に合っていません。`,
    en: (v) => `The final Manager result does not match its declared runtime contract (${v.field}: ${v.mode}).`,
  },
  "manager.operation_failed": {
    ja: (v) => `${opJa(v.operation)} が成功しませんでした（${v.field}: ${v.outcome}）。`,
    en: (v) => `The ${v.operation} did not succeed (${v.field}: ${v.outcome}).`,
  },
  "manager.report_invalid": {
    ja: (v) => `${opJa(v.operation)} の結果には、有効な ${v.field} オブジェクトを含めてください。`,
    en: (v) => `The ${v.operation} must include a valid ${v.field} object.`,
  },
  "manager.final_verdict_invalid": {
    ja: (v) => `最終 Manager の ${v.field} が正しくありません（Work ${v.work_id}）。`,
    en: (v) => `The final Manager ${v.field} is invalid (Work ${v.work_id}).`,
  },
  "manager.final_verdict_fields_invalid": {
    ja: (v) => `最終 Manager の ${v.field} の項目が正しくありません（Work ${v.work_id}）。`,
    en: (v) => `The final Manager ${v.field} fields are invalid (Work ${v.work_id}).`,
  },
  "manager.task_actions_not_array": {
    ja: (v) => `Manager の ${v.field} は配列にしてください。`,
    en: (v) => `The Manager ${v.field} must be an array.`,
  },
  "manager.task_action_invalid": {
    ja: (v) => `Manager の ${v.field} には、task_id、action（cancel か complete）、reason が必要です。`,
    en: (v) => `The Manager ${v.field} needs task_id, action (cancel or complete) and reason.`,
  },
  "manager.plan_tasks_not_array": {
    ja: (v) => `Manager の計画の ${v.field} は配列にしてください（Work ${v.work_id}）。`,
    en: (v) => `The Manager plan ${v.field} must be an array (Work ${v.work_id}).`,
  },
  "manager.plan_tasks_empty": {
    ja: (v) => `Manager の計画の ${v.field} には、Task を 1 件以上含めてください（Work ${v.work_id}）。`,
    en: (v) => `The Manager plan ${v.field} must contain at least one Task (Work ${v.work_id}).`,
  },
  "manager.plan_task_not_object": {
    ja: (v) => `Manager の計画の ${v.field}[${v.index}] がオブジェクトではありません（Work ${v.work_id}）。`,
    en: (v) => `The Manager plan ${v.field}[${v.index}] is not an object (Work ${v.work_id}).`,
  },
  "manager.plan_task_other_work": {
    ja: (v) => `Manager の計画に、別の Work の Task ${v.task_id} が含まれています（${v.field}: ${v.work_id}）。`,
    en: (v) => `The Manager plan contains Task ${v.task_id} of another Work (${v.field}: ${v.work_id}).`,
  },
  "manager.plan_task_type_unsupported": {
    ja: (v) => `Manager の計画の Task ${v.task_id} の ${v.field}（${v.type}）は対応していません（Work ${v.work_id}）。`,
    en: (v) => `The ${v.field} (${v.type}) of Manager plan Task ${v.task_id} is unsupported (Work ${v.work_id}).`,
  },
  "manager.plan_task_field_invalid": {
    ja: (v) => `Manager の計画の Task ${v.task_id} の ${v.field} が正しくありません（Work ${v.work_id}）。`,
    en: (v) => `The ${v.field} of Manager plan Task ${v.task_id} is invalid (Work ${v.work_id}).`,
  },
  "manager.plan_task_field_not_string": {
    ja: (v) => `Manager の計画の Task ${v.task_id} の ${v.field} は文字列にしてください（Work ${v.work_id}）。`,
    en: (v) => `The ${v.field} of Manager plan Task ${v.task_id} must be a string (Work ${v.work_id}).`,
  },
  "manager.plan_task_field_not_boolean": {
    ja: (v) => `Manager の計画の Task ${v.task_id} の ${v.field} は真偽値にしてください（Work ${v.work_id}）。`,
    en: (v) => `The ${v.field} of Manager plan Task ${v.task_id} must be a boolean (Work ${v.work_id}).`,
  },
  "manager.plan_task_string_list_invalid": {
    ja: (v) => `Manager の計画の Task ${v.task_id} の ${v.field} は、1〜200 文字の文字列を 20 件以内で並べてください（Work ${v.work_id}）。`,
    en: (v) => `The ${v.field} of Manager plan Task ${v.task_id} must be at most 20 strings of 1 to 200 characters (Work ${v.work_id}).`,
  },
  "manager.plan_task_replaces_invalid": {
    ja: (v) => `Manager の計画の Task ${v.task_id} の ${v.field} は、Task id の配列にしてください（Work ${v.work_id}）。`,
    en: (v) => `The ${v.field} of Manager plan Task ${v.task_id} must be an array of Task ids (Work ${v.work_id}).`,
  },
  "manager.auto_recovery_list_invalid": {
    ja: (v) => `Manager の計画の Task ${v.task_id} の ${v.field} は、${v.shape} を持つ項目の一覧にしてください（Work ${v.work_id}）。`,
    en: (v) => `The ${v.field} of Manager plan Task ${v.task_id} must be a list of items with ${v.shape} (Work ${v.work_id}).`,
  },
  "manager.plan_task_enum_invalid": {
    ja: (v) => `Manager の計画の tasks[${v.index}] の ${v.field} は、${v.allowed} のいずれかにしてください。`,
    en: (v) => `The ${v.field} of Manager plan tasks[${v.index}] must be one of ${v.allowed}.`,
  },
  "manager.plan_task_string_required": {
    ja: (v) => `Manager の計画の tasks[${v.index}] の ${v.field} は、空でない文字列にしてください。`,
    en: (v) => `The ${v.field} of Manager plan tasks[${v.index}] must be a non-empty string.`,
  },
};
