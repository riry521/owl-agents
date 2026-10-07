/**
 * Prompt rules shared by Owl coding agents, including the Worker.
 */

/** Intermediate output is never shown to anyone; only the final answer is read. */
export const WORKING_STYLE_RULES: readonly string[] = [
  "Nothing you print before the final answer is shown to anyone. Do not narrate, announce steps, or report progress between tool calls.",
  "Do not restate the task, the plan, or the input back; act on them.",
  "Run builds and tests with their quiet or minimal-output options and filter the output (e.g. only failures, or the last lines). Never print a whole log to read it.",
  "Read only the parts of a file or command output you need (search, line ranges, tail). Do not dump whole files.",
  "Think briefly, decide, act. Put every explanation in the final answer, not in messages along the way.",
];

/** Workers use Owl dispatch when independent work can run in parallel. */
export const WORKER_SUBAGENT_RULES: readonly string[] = [
  "When independent parts of your Task can run in parallel, use Owl's dispatch tool to start them and wait for every dispatched run before integrating the results.",
  "Choose provider, model, and effort independently for each child. For example, a Claude Worker can run a Codex gpt-5.6-luna child in parallel, while a Sonnet 5.5 medium Worker can choose a same-model Sonnet 5.5 low child. Omit any field to use the configured default for the harness different from the parent.",
  "Give each dispatch a clear, bounded instruction and a disjoint write scope when possible. Always consider whether any parts can proceed independently; if so, run them as parallel Owl dispatch children as much as possible. Do not split only when the Task is small, or when the parts depend so strongly on each other that splitting would make them disagree. Review the combined result for correctness and conflicts.",
  "Do not use your own subagents (for example Claude's Agent tool), forks, or other provider-native subagent or delegation tools because they do not receive Owl's Task rules; run children only through Owl dispatch. If Owl dispatch is unavailable, continue directly; never claim to have delegated when you have not.",
];

/** Workers without Owl dispatch (hybrid mode off) parallelize with their own subagents. */
export const WORKER_OWN_SUBAGENT_RULES: readonly string[] = [
  "When independent parts of your Task can run in parallel, run them in parallel with your own subagents (for example Claude's Agent tool) and wait for all of them before integrating the results. Always consider whether any parts can proceed independently; do not split only when the Task is small, or when the parts depend so strongly on each other that splitting would make them disagree.",
  "Use a fork when the part needs your conversation so far; use a normal subagent when a self-contained instruction is enough.",
  "Each subagent does not receive Owl's Task rules automatically, so put them in its instruction: the prohibitions from the rules you were given, the minimal-change rule (do only what the part needs), and a disjoint write scope per subagent. Review the combined result for correctness and conflicts; a subagent's report is evidence, not proof.",
  "If subagents are unavailable, continue directly; never claim to have delegated when you have not.",
];

// Condensed from ponytail's AGENTS.md (https://github.com/dietrichgebert/ponytail,
// MIT License, Copyright (c) 2026 DietrichGebert), adapted to Owl Task semantics.
export const MINIMAL_CODE_RULES: readonly string[] = [
  "Write the least code that is correct. The Task's acceptance criteria and the rules given to you with the Task always win over these rules.",
  "Before adding code, prefer in this order: nothing (not needed for acceptance), something that already exists in this codebase, the standard library, an installed dependency. Add a new dependency only if the Task asks for it.",
  "No abstractions, options, configuration, or generality that the Task did not ask for. Deleting code beats adding it; boring beats clever; fewest files and the shortest working diff.",
  "For a bug, fix the root cause once where it lives; do not patch symptoms at call sites.",
  "Never skimp on: understanding the problem first, input validation at trust boundaries, error handling that prevents data loss, security, and anything the Task explicitly requests.",
  "Non-trivial logic leaves one runnable check behind (a test or a documented command); trivial one-liners need none.",
];
