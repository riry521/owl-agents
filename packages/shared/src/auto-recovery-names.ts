/** Names Core writes into automatic-recovery records. They are Owl's own words, so the Owner-facing text check refuses them. */
export const AUTO_RECOVERY_KINDS = [
  "integration_conflict", "final_incomplete", "output_format", "budget_exhausted",
  "plan_quality_rejected", "provider_transient", "criteria_too_strict", "partial_repeated",
] as const;
export type AutoRecoveryKind = (typeof AUTO_RECOVERY_KINDS)[number];

export const AUTO_RECOVERY_ACTIONS = [
  "add_conflict_task", "report_resubmit", "fresh_rerun", "replan_different_approach", "repair_partial",
  "relax_criteria", "retry_plan", "wait_and_rerun", "wait_rate_limit", "final_continue",
] as const;
export type AutoRecoveryAction = (typeof AUTO_RECOVERY_ACTIONS)[number];

/** Why Core opened the Decision at the first failure instead of trying to fix it. */
export const IMMEDIATE_DECISION_REASONS = [
  "design_decision", "irreversible_operation", "uncommitted_changes", "authentication_failed",
  "harness_config", "owner_criteria", "recovery_disabled",
] as const;
export type ImmediateDecisionReason = (typeof IMMEDIATE_DECISION_REASONS)[number];
