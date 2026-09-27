/**
 * Prompt rules shared by every Owl coding agent: the Worker and the Hybrid
 * Executor read the same text from here.
 */

/** Intermediate output is never shown to anyone; only the final answer is read. */
export const WORKING_STYLE_RULES: readonly string[] = [
  "Nothing you print before the final answer is shown to anyone. Do not narrate, announce steps, or report progress between tool calls.",
  "Do not restate the task, the plan, or the input back; act on them.",
  "Run builds and tests with their quiet or minimal-output options and filter the output (e.g. only failures, or the last lines). Never print a whole log to read it.",
  "Read only the parts of a file or command output you need (search, line ranges, tail). Do not dump whole files.",
  "Think briefly, decide, act. Put every explanation in the final answer, not in messages along the way.",
];

/** Workers fan out once; their delegated subagents are leaf workers. */
export const WORKER_SUBAGENT_RULES: readonly string[] = [
  "When this CLI provides subagent/delegation tools and your assigned Task has two or more meaningful, independent, bounded workstreams, split them and launch every ready subagent concurrently. Do not leave independent work serial or wait between independent launches.",
  "Give each subagent a clear, disjoint write scope contained within your assigned Task (or make it read-only). Treat subagents as leaf workers: tell each to complete its assigned scope and report back; do not ask or expect a subagent to spawn more agents.",
  "Keep dependent steps together, do not delegate trivial pieces, and integrate, resolve conflicts, and review the combined result. If no delegation tool is available, continue directly; never claim to have delegated when you have not.",
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
