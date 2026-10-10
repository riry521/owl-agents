# Owl-Agent v1 operations

## Data path

Set `OWL_DATA_DIR` to an absolute path for a deployment that must keep durable state
outside the checkout. SQLite (`owl.sqlite`), WAL files, `server.log`, PID/state files,
uploads, `app-settings.json`, and connector metadata are stored under that one
directory. New connector Tokens are kept in the project `.env` with mode `600`;
`secrets.json` is retained only as a legacy encrypted Vault that can be migrated.
Knowledge, rules, and worktrees remain under `OWL_ROOT` because they are
user-managed project state.

Older releases used `<OWL_ROOT>/.owl-data` for settings and connector secrets. On first
use, Owl copies only a missing known file into the selected data directory. It leaves
the source untouched and never overwrites a destination file. Verify the destination
with `./bin/owl doctor --json` before archiving the legacy directory.

## Automatic push

Automatic push is off by default for each Project. Turn it on in the Project settings
after confirming the base branch has an upstream (`branch.<base>.remote` and
`branch.<base>.merge`). When a Work completes, Owl pushes only that base branch to
the configured upstream. Owl never force-pushes. A rejected push leaves the Work
completed and creates an alert with the Git reason; integrate remote changes or
resolve the hook or credential issue, then push manually as needed.

## Backup and restore

1. Stop the server: `./bin/owl stop`.
2. Copy the complete `OWL_DATA_DIR` to a protected backup location. Preserve file
   permissions and include SQLite WAL files if they exist.
3. Restore into a new directory, set `OWL_DATA_DIR` to it, and restore the project
   `.env` as well when connector access is needed.
4. Run `./bin/owl doctor --strict`; only switch production back after the checks pass.

Existing encrypted connector Vaults can be migrated once by explicitly setting
`OWL_SECRET_PASSPHRASE`; normal startup never prompts for it. Never commit `.env`
or print Token values in shell debug output. The Typesafe API key is currently stored
in the protected settings JSON for compatibility and is returned through the API only
in masked form.

## Standalone connector account IDs

Connector Account IDs belong to a provider. `node apps/connectors/dist/cli.js
--slack` and `--discord` accept the legacy `OWL_CONNECTOR_ACCOUNT_ID` for
backward compatibility, while `OWL_SLACK_CONNECTOR_ACCOUNT_ID` and
`OWL_DISCORD_CONNECTOR_ACCOUNT_ID` take precedence. `--all` requires both
provider-specific variables; a shared `OWL_CONNECTOR_ACCOUNT_ID` alone is
rejected to prevent a Slack account from being sent to Discord or vice versa.

## Rule files

Rules live in `<OWL_ROOT>/rules/**/*.yaml`. Each file has `level` (`absolute`,
`system` or `role`), `role` only when `level: role` (one of `advisor`, `manager`,
`designer`, `worker`, `reviewer`, `librarian`), and a `rules` list. A rule is a
`block_command` (`id`, `pattern`, optional `message`), a `block_path` (`id`,
`pattern`, optional `mode` of `read`, `write` or `both`, optional `message`) or an
`instruction` (`id`, `text`). Unknown keys, a `block_command` pattern that is more
than one simple command, and a rule id used twice are errors. Work rules are not
files; they are stored on the Work.

Every agent receives one line per rule as `[level] text` (a block rule's text is
its message), ordered absolute → system → role, followed by the Work's rules as
`[work] text`. Identical lines appear once. Role rules reach only that role.

Owl refuses to start when any rule file is invalid and names each file, line and
reason. After startup, rule files are reloaded when they change. A reload with an
invalid file keeps the last valid rule set in use — commands and paths are still
checked against it, and no tool is disabled — and the Owner receives one
`system.alert` per distinct failure, then one more when the files are fixed.

## Rule proposal approvals

As Owner, open `/owl/rules/approvals` and review each proposal's text, scope, and
sources. Select **Approve** to install a rule or **Reject** to dismiss the proposal.
Legacy policy proposals require the same review and approval, including proposals
from files tagged `owner-approved`.

## Learning job retries

Learning jobs retry automatically up to 3 attempts. If a job reaches `failed`, inspect
the reported error and resolve its cause, then retry it as Owner with
`POST /api/v1/learning-jobs/{job_id}/retry`. A retry returns the job to `pending`,
resets `attempts` to 0, clears `last_error`, and keeps already processed lessons so
they are not emitted again.

## Learning and knowledge defaults

The values below are initial defaults, not acceptance thresholds. Observe the listed
signals before changing them.

| Setting | Initial value | Monitor and review condition |
|---|---:|---|
| Pipeline debounce (`LearningPipelineOptions.debounce_ms`) | 5_000 ms | If enqueues for one Work commonly arrive after the debounce and return a job to `pending` because `payload_version` changed (many second passes in `result_json`), increase it. If the delay from Work completion to proposal display is operationally noticeable, decrease it. |
| Periodic timer (Core `learningTimer`) | 300_000 ms (5 minutes) | If timer runs usually find no `pending` jobs (aggregate this in logs), increase it. If many jobs wait for the timer instead of being processed by `requestRun` (`created_at` to `processed_at` exceeds 1 minute), investigate `requestRun` before shortening the interval. |
| Stale-running recovery (`stale_running_ms`) | 600_000 ms (10 minutes) | If `processed_at - updated_at` for normal jobs approaches 10 minutes, increase it. If recovery after a crash takes too long, decrease it; recorded `processed` work and proposal sources prevent duplicate output. |
| Retry limit (`max_attempts`) | 3 | If many `failed` jobs later succeed through `retryJob`, indicating transient errors, increase it. If most fail 3 times with the same error, keep the value and fix the cause. |
| Jobs per processing batch (`batch_size`) | 5 | If at least `batch_size` jobs remain `pending` after the periodic timer runs, increase it. |
| Rule proposal source threshold (`RULE_PROPOSAL_MIN_SOURCES`) | 1 | If proposals with one source have a high rejection rate and create approval noise, raise the constant to 2. If useful proposals remain in `pending` waiting for sources, return it to 1. If code changes become burdensome, a settings API would be needed; none exists today. |
| Knowledge injection limits (`settings.knowledge`) | `max_notes` 3 / `max_tokens` 1500 / `per_note_tokens` 600 / `max_characters` 4000 | If the difference in `TokenUsage.input_tokens` with and without injection greatly exceeds the estimate, review the token-estimate multiplier. If knowledge-related `remaining_issues`/`findings` are absent while costs increase, reduce the limits. If `render` consistently returns fewer `notes` than `select` because of truncation, increase them. |
| Injection hard caps (§6.1 limits) | 10 / 4000 / 1500 / 12000 | Reconsider if requested settings repeatedly reach these caps. |
| Relevance thresholds (`min_score`; topic match) | 3; 3 or more with a score difference of 2 | If unrelated injections or incorrect note merges become common in manual review of injected notes or note merges, raise the thresholds. If notes for the same topic fragment into many new notes, lower them. |

`RULE_PROPOSAL_MIN_SOURCES = 1` is a code constant: a validated proposal with one
source can immediately enter `awaiting_approval`. Approval remains an operator action;
the threshold does not install rules automatically.

## Worker self-verification, completion gate and review limits

### Three verification layers (Worker / Core / Reviewer)

| Layer | Role | Output | Implementation |
|---|---|---|---|
| Worker (evidence) | Checks each criterion itself and writes the evidence; runs `check_commands` and records the results. It does not decide pass or fail | `report.verification` | `packages/agent-runtime/src/worker.ts`, `protocol.ts` |
| Core (mechanical judgement) | Runs the completion gate, `check_commands`, the Core test run and the type policy itself. The Worker's claim is attached only as `worker_verification_passed`; passing `check_commands` results are kept in `verification.check_commands` | `verification` of `verification.completed` (`check_commands`, `commands`, `type_policy`, `test_run`) | `task-completion-gate.ts`, `workflow-engine.ts` (`verifyByTaskType`), `task-verification-policy.ts`, `core-test-run.ts` |
| Reviewer (semantic judgement) | Judges meaning, design and rules against the acceptance criteria. It does not repeat the mechanical checks Core already passed (`Review.core_checks`, `Review.core_tests`) | verdict and findings | `packages/agent-runtime/src/reviewer.ts` |

Rule: evidence generation belongs to the Worker, deterministic judgement to Core, and semantic
judgement to the Reviewer. Do not ask the Reviewer for deterministic checks or Core for semantic ones.

A Task is completed in only two places (`packages/core/src/state-reducer.ts`):

1. `reduceTask` on `verification.completed` (pass, and no review required).
2. `review.passed` followed by a successful merge (`integratedTaskResult`).

The engine only writes events; it never decides completion.

### Task flow

- `running`: the Worker implements the Task, finalizes it, and verifies its own result.
  When it reports success, Core runs the completion gate
  (`evaluateWorkerCompletion` in `packages/core/src/task-completion-gate.ts`, called from
  `packages/core/src/workflow-engine.ts`) before the `agent.exited` transition.
- `verifying`: the gate has passed. Core verification runs here, then Core routes the review
  (see "Review routing"); the Reviewer runs only when the routing says it is required. A passing
  gate replaces neither Core verification nor a required review.

### Report schema 1.1.0 and legacy reports

New Worker reports use `schema_version` `1.1.0` (`REPORT_SCHEMA_VERSION` in
`packages/agent-runtime/src/types.ts`). `verification` has this shape:

```
verification: {
  status: "passed" | "failed" | "blocked",   // blocked = the check could not be run
  method: string,
  acceptance: [{ criterion_id, criterion, status, evidence }],
  checks: [{ name, status, evidence }],
  integration_check: { status, evidence, required? } | null
}
```

A 1.0.0 report (`verification: { passed: boolean, method }`,
`LEGACY_REPORT_SCHEMA_VERSION`) is read-only: reports already stored stay readable, but a new
agent run that returns 1.0.0 is rejected (`packages/agent-runtime/src/protocol.ts`). The gate
reads a legacy `passed` as `passed`/`failed` and skips the per-criterion checks.

### Completion gate

The gate fails when any of these holds. The failure is recorded as a deterministic failure
(`retry_allowed: true`) with `gate_reasons`, and the Task does not reach `verifying`.

| Condition | `error_key` |
|---|---|
| `result` is not `success`, `needs_replanning` is set, or `question_for_manager` is non-empty | `worker_completion_gate_failed` |
| `verification.status`, an acceptance item or a check is `failed` | `worker_verification_failed` |
| any of those is `blocked` | `worker_verification_blocked` |
| status missing or unknown, or `verification.acceptance` is empty (1.1.0) | `worker_verification_incomplete` |
| Hybrid Task, or subagents were observed, and `integration_check` is missing, not `passed`, or (for observed subagents) `required` is not `true` | `hybrid_integration_verification_missing` |

When several apply, the recorded key is the first in this order: `hybrid_integration_verification_missing`,
`worker_verification_blocked`, `worker_verification_failed`, `worker_verification_incomplete`,
`worker_completion_gate_failed`. If the Worker sets `needs_replanning` or asks a question, the
Task goes through `task.replan_requested` and the same `error_key` and `gate_reasons` are attached.

### Worker AND Core verification

Both must pass. The Worker's own `verification` is a claim, not proof: the gate only checks
that it is complete and honest (nothing failed, blocked or missing). Core and the Reviewer then
verify independently (Core verification always runs; the Reviewer runs when the routing requires it); the Reviewer prompt (`packages/agent-runtime/src/reviewer.ts`) treats the
evidence as a claim to check, and marks a `passed` that was not actually verified, or that rests
only on a child agent's report, as a major finding. Neither side's pass alone completes a Task.
A Task whose review the routing skipped is completed by the Worker gate and Core verification,
and the Work is still verified as a whole (see "Work integration verification").

### Review limits

Settings key `review_limits` (`packages/shared/src/review-limit-settings.ts`; read by
`reviewLimits` in `packages/core/src/review-limits.ts`; `GET`/`PUT /api/v1/settings/review-limits`):

| Field | Default | Meaning |
|---|---|---|
| `plan_review_rounds` | 2 | plan-local: rejected reviews one plan may get before the Task fails; the count resets when the Manager replans |
| `total_review_attempts` | 6 | total: valid Reviewer verdicts one Task may use across all replans (`tasks.total_review_attempts`) |

`total_review_attempts` must be an integer greater than `plan_review_rounds` (PUT is rejected
otherwise); an invalid stored value falls back to the default. Every valid verdict, pass or not,
is counted and the count survives a replan. When a non-pass verdict makes the count equal to the
limit, the Task fails and goes to the Manager. When it exceeds the limit, the Task moves to
`judgement_waiting` and a Core decision is opened for the Owner (the Work waits too only when no other Task can proceed; see "Progress guard and prerequisite waits"). The Task is never passed
automatically (`packages/core/src/state-reducer.ts`, rows 18b/18c).

### Remake limits

A replan that replaces a failed Task (`replaces`) records a lineage: `tasks.lineage_root_task_id`
(NULL = the Task is its own root), `tasks.lineage_generation` and `tasks.replaces_task_ids_json`
(`packages/core/src/task-lineage.ts`, migration 039). The per-Task limits above do not carry over
to a replacement Task, so a lineage has its own limits. Settings key `remake_limits`
(`packages/shared/src/remake-limit-settings.ts`; read by `remakeLimits` in
`packages/core/src/remake-limits.ts`; `GET`/`PUT /api/v1/settings/remake-limits`; PUT takes all eight fields):

| Field | Default | Meaning |
|---|---|---|
| `lineage_review_attempts` | 9 | valid Reviewer verdicts (pass or not) totalled over a lineage |
| `lineage_worker_runs` | 10 | Worker/Designer launches that ran to an end (completed or failed) over a lineage |
| `non_functional_remakes` | 2 | consecutive remakes whose changes touch only `verification_paths` |
| `base_sync_lineage_review_attempts` | 9 | like `lineage_review_attempts`, counted separately over the generations that only synced the base branch |
| `base_sync_lineage_worker_runs` | 10 | like `lineage_worker_runs`, counted separately over base-sync-only generations |
| `lead_review_rejections` | 1 | Reviewer rejections of Lead Designer output over a lineage before Core stops remaking the design (integer 1–100) |
| `verification_paths` | tests, fixtures, snapshots, `scripts/verify*` globs | paths that count as verification, not functional code |
| `checked_task_types` | `code`, `config` | Task types whose remakes are checked for non-functional changes |

A missing or invalid stored value falls back to the default per field; the stored `review_limits`
(`plan_review_rounds`, `total_review_attempts`) are independent and unchanged.

When a limit is reached:

- At replan time (`Core.applyRemakeGate`): no new Task is created and the Manager is not called.
  The failed Task becomes `judgement_waiting`, and an open Core Decision names the
  limit, the numbers and the lineage history. The Work becomes `judgement_waiting` only when no
  other Task can proceed; otherwise it keeps running. A replan the Owner asked for is not gated.
- At a Reviewer verdict (reducer row 18d): when the verdicts of the whole lineage reach
  `lineage_review_attempts` on a failing verdict, the Task moves to `judgement_waiting` with the
  same Decision instead of failing into a replan. Base-sync-only generations are checked against
  the `base_sync_lineage_*` limits instead.
- Lead Designer rejections: when a `design` Task escalated to the Lead Designer is rejected
  `lead_review_rejections` times over the lineage, Core stops remaking the design and records a
  design stop; the Manager receives it with the Owner's answer on the next replan.

Non-functional detection compares content hashes that Core measures at each Task verification
(`task_change_measurements`). A remake is compared with the previous generation of the same Task, or
with the Tasks it replaces; a remake that drops a file its predecessor had counts as changing it.
A remake whose changes cannot be measured is neutral: it neither adds to nor resets the streak.
Project-less Works are measured only at the first verification of each Task.

### Progress guard and prerequisite waits

Settings key `progress_guard` (`packages/shared/src/progress-guard-settings.ts`; read by
`progressGuard` in `packages/core/src/progress-guard.ts`). It is read and written through
`Core.getProgressGuardSettings()` / `Core.setProgressGuardSettings()` (all six fields at once;
an out-of-range value is rejected). There is no HTTP route or Settings screen for the settings themselves.
A missing or invalid stored value falls back to the default per field.

| Field | Default | Range | Meaning |
|---|---|---|---|
| `no_progress_limit` | 3 | integer 1–100 | consecutive "no progress" results of one Task before Core stops and asks the Owner |
| `prerequisite_check_interval_seconds` | 60 | integer 10–86400 | seconds between evaluations of one waiting Task's conditions |
| `prerequisite_max_wait_hours` | 72 | integer 1–8760 | hours a Task may wait; the deadline is fixed when the wait starts |
| `prerequisite_sync_base` | true | true / false | merge the base branch into the Work branch when a wait is released; applies only to a Work with a Project and a wait whose conditions include `work` or `base_branch` (a `task`- or `owner`-only wait never syncs) |
| `process_wait_max_count` | 3 | integer 0–20 | times a Worker may leave a long process running (`pending_process`) per Task line before Core asks the Owner via a Decision (the Task goes `judgement_waiting`; no failure is counted); 0 disables process waits |
| `process_wait_max_hours` | 6 | integer 1–72 | hours one process wait may last; the deadline is fixed when the wait starts |

**No-progress limit.** `tasks.no_progress_count` (migration 040) goes up by one each time a Task
fails into a Manager replan. It returns to 0 when the Task completes or the Owner answers its
Decision, and when the Owner resumes a prerequisite wait; it is kept when a wait starts and when a
wait is released by its conditions. When the count has reached `no_progress_limit`, Core does not
call the Manager or launch the Worker: the Task becomes `judgement_waiting` (and the Work too when no other Task can proceed), a Core
Decision is opened (choices: run again, or cancel the Work) and the Owner is notified. Answering
"run again" resets the count and passes the Owner's text to the next Worker.

**Entering a prerequisite wait.** When the Manager's replan of a failed Task carries `wait_for`
(reason plus conditions: `task` / `work` in another Work, `base_branch` with paths, or `owner`),
Core records it (`tasks.prerequisite_json`, migration 041) and the Task goes to `waiting`. The
Manager and the Worker are not started for it while it waits. All conditions must hold (AND).

**Leaving it.**
- Conditions hold: Core checks each waiting Task at most every `prerequisite_check_interval_seconds`,
  and at once when a Task or Work it names completes or a Work is merged into the base branch. When
  all conditions hold, the mark is cleared, the base branch is merged if `prerequisite_sync_base`
  allows (Project Work, and the wait has a `work` or `base_branch` condition), and the Task is an ordinary `waiting` Task again (it becomes `ready` once its `depends_on` are completed).
- Owner resume: `Core.resumePrerequisiteWait(taskId, …)` clears the mark, sets the count to 0 and
  passes the Owner's message to the next Worker; the same base sync rule applies first, and a conflict or failure aborts the resume and keeps the wait. A wait with an `owner` condition ends only this way.
  The HTTP route is `POST /api/v1/tasks/{id}/prerequisite/resume` (Owner only; optional `message`).
- Limit reached: when the deadline (`prerequisite_max_wait_hours`) passes, a condition can never be
  met (target cancelled or gone), or the base merge conflicts, Core opens a Decision, the Task and the
  Work (when nothing else can proceed) become `judgement_waiting` and the Owner is notified.

**Process wait.** A Worker that must run a long process (a dry-run, a long build) starts it detached,
writes a log and a done file inside the worktree, and reports `partial` with `pending_process`
(`description`, `command`, `log_path`, `done_path`, `pid`, `expected_minutes`). Core moves the Task
`running → waiting` (row 32c, `task.process_wait_started`) without calling the Manager, so
`no_progress_count`, the failure counters and `lineage_worker_runs` are not consumed; the run is
excluded from the lineage count. The `process` condition is released when the done file exists or the
pid is gone, then the Worker is relaunched with `context.process_wait` and its previous report. The
deadline (`process_wait_max_hours`) or `process_wait_max_count` bounds the restarts: past either one
the Owner is asked via a Decision (row 37; `wait_count` when the count is used up). Neither
increases a failure counter or `no_progress_count`, and the Worker is not relaunched.

**Unprovable acceptance criteria.** A criterion that nothing inside the Task can prove (for example a
before/after comparison of a live server or another Work) is sent back to the Manager instead of being
retried. A Worker marks it `unverifiable` in `verification.acceptance[].status`; a Reviewer returns
verdict `acceptance_defect` with `acceptance_defects` (`criterion_id`, `criterion`, `reason`,
`suggestion`). Either way Core records `task.acceptance_defect_reported` (`source` = `worker` or
`reviewer`), runs the Manager with `failure.kind = acceptance_defect`, and the Manager rewrites only
those criteria into checks the Task can run. This does not increase `no_progress_count`, the failure
counters or `review_limits`. The Worker run is still recorded as completed, so it is counted in
`lineage_worker_runs`, but the limit gates do not block the rewrite: the smallest limits still reach it.

### Minimum verification per Task type

Core verifies a Task's output by its type, independently of the Worker's claim
(`evaluateTaskTypePolicy` in `packages/core/src/task-verification-policy.ts`). A Work **without a
Project** has no Project verification plan, so these checks are the only ones ("sole" mode) and
**a check that cannot be run fails the Task**. A Work **with a Project** runs the Project plan,
and only the static checks and test runs below are added ("supplement" mode; `code` adds nothing).
`design` Tasks are not checked. In a `config` Task, lockfiles (`pnpm-lock.yaml`, `package-lock.json`,
`yarn.lock`, `Cargo.lock`, `go.sum` and similar; `LOCKFILE_PATTERNS`) are always excluded from the checks and left
to the frozen-lockfile check; a Task whose changed files are all lockfiles passes without a checker. For `code`, `doc`, `config` and `test`, a Task with no worktree, a
Task that changed no files, and a claimed change (report `changes[]`) missing from the worktree
fail.

| Type | Passes when | `error_key` on failure |
|---|---|---|
| `doc` | every changed file matching `doc.file_patterns` is non-empty and readable within `limits.max_read_bytes`; at least one file matches; and each section in `doc.required_sections` plus the Manager's `required_sections` is a heading (found with `doc.heading_pattern`, compared as `doc.section_match`) in **at least one** of those files — headings are pooled across all the changed documents, not required in each file | `doc_empty`, `doc_section_missing` |
| `config` | each changed file not in `config.skip_patterns` passes its `config.checkers` command, or parses as JSON if it matches `config.json_patterns`, or as YAML if it matches `config.yaml_patterns` | `config_parse_failed`; `config_unsupported_format` (no parser for a file, or every file is excluded) |
| `test` | each changed file matching a `test.runners` pattern runs and passes, and so does every Manager `required_tests` file | `test_failed`, `test_not_executed` (no file matched a runner), `test_required_not_executed` |
| `code` | (sole mode) each changed file that matches a `code.checkers` pattern passes the first matching command (files matching none are ignored, not failed), and changed test files run if `code.run_test_runners`; at least one check or test run must execute | `code_check_failed`, `code_unchecked` (nothing could be checked) |

More than `limits.max_files_per_check` files to check fails with `verification_limit_exceeded`
(sole mode). The Manager's `required_sections` / `required_tests` are stored with the Task
(`tasks.verification_spec_json`) and shown to the Manager when it replans. Other keys:
`verification_no_output`, `verification_claimed_change_missing`.

Settings key `verification_policy` (`packages/shared/src/verification-policy-settings.ts`; read by
`verificationPolicySettings`). There is no HTTP API or setter: change it by writing the JSON
into the `settings` table row with this key. A missing key silently uses the default; an invalid
key falls back to the default for that key only, with a warning in the log; a failed read uses all defaults.

| Field | Default | Invalid when |
|---|---|---|
| `doc.file_patterns` | `**/*.md`, `**/*.mdx`, `**/*.txt`, `**/*.rst`, `**/*.adoc` | not a list of non-empty strings |
| `doc.heading_pattern` | `^#{1,6}\s+(.*?)\s*#*\s*$` (group 1 = section name) | not a valid regular expression |
| `doc.section_match` | `folded` (NFKC, case-insensitive) | not `exact` / `folded` |
| `doc.required_sections` | `[]` | not a list of non-empty strings |
| `config.json_patterns` | `**/*.json` | not a list of non-empty strings |
| `config.yaml_patterns` | `**/*.yml`, `**/*.yaml` | not a list of non-empty strings |
| `config.checkers` | `[]` | not a list of `{ pattern, argv }` (argv non-empty strings; `{file}` is the path) |
| `config.skip_patterns` | `**/.env*` | not a list of non-empty strings |
| `test.runners` | `**/*.test.{mjs,js,cjs}` → `node --test {file}`; `**/{test_*,*_test}.py` → `python3 -m pytest -q {file}` | not a list of `{ pattern, argv }` |
| `code.checkers` | `**/*.{js,mjs,cjs}` → `node --check`; `**/*.py` → `python3 -c "import ast…"`; `**/*.sh` → `bash -n` | not a list of `{ pattern, argv }` |
| `code.run_test_runners` | `true` | not a boolean |
| `limits.timeout_seconds` | 120 | not an integer ≥ 1 |
| `limits.stdout_limit_bytes` / `stderr_limit_bytes` | 65536 / 65536 | not an integer ≥ 1 |
| `limits.max_files_per_check` | 50 | not an integer ≥ 1 |
| `limits.max_read_bytes` | 1048576 | not an integer ≥ 1 |
| `limits.env_allowlist` | `[]` | not a list of strings |

### Work integration verification

After every Task is merged into the Work branch and before the Final Manager, Core runs the
Project's verification plan on the whole Work branch (`runWorkIntegrationVerification` in
`packages/core/src/core.ts`). It is skipped (`not_applicable`) when disabled or when the Work has
no Project. A Work with a Project never skips it: if the Git gateway cannot verify the branch the
result is recorded as `error`. A pass lets the Final Manager go ahead. A `failed` or `error`
result goes to the Manager as a replan (the failing command and output are passed as
`work_verification`) up to `max_manager_repairs` times since the last Owner decision, then to the
Owner. Each run is recorded as `work.integration_verification_completed` with `routed_to`.

Settings key `work_verification` (`packages/shared/src/work-verification-settings.ts`; read by
`workVerification`). There is no HTTP API or setter: write the JSON into the `settings` table
row. A missing or invalid key falls back to its default, per key, with a warning.

| Field | Default | Invalid when |
|---|---|---|
| `enabled` | `true` | not a boolean |
| `max_manager_repairs` | 2 | not an integer from 0 to 10 |

### Plan quality check

When the Manager returns an initial plan or a replan, Core checks the new and revised Tasks
(`evaluatePlanQuality` in `packages/core/src/plan-quality.ts`; `design` Tasks are skipped). Ordinary
warnings never reject; a warning whose code is in `blocking_codes` (default `external_state_comparison`, `necessity_missing`, `heavy_check_unjustified`)
is rejected instead. Warning codes: `acceptance_items_over`, `acceptance_chars_over`,
`broad_scope` (a wide-scope keyword and no path, file name or identifier), `components_over`,
`verification_missing` (a Task of a type in `verification_required_types` whose acceptance has none of
`verification_keywords`). On a warning the Manager is asked to repair the plan up to
`max_repair_requests` times; after that the plan is accepted with the warnings only if none of them is
a blocking code, otherwise it is rejected. Each warning round
is recorded as `work.plan_quality_warned` (with `manager_agent_run_id` and whether it was
`repair_requested` or `accepted_with_warnings`).

Settings key `plan_quality` (`packages/shared/src/plan-quality-settings.ts`; read by
`planQualitySettings`). Change it with `Core.setPlanQualitySettings`, which needs all keys and
rejects an invalid value (`validatePlanQualitySettings`); there is no HTTP route. On read, a missing key
silently uses its default; an invalid key falls back to its default with a warning.

| Field | Default | Invalid when |
|---|---|---|
| `enabled` | `true` | not a boolean |
| `max_repair_requests` | 1 | not an integer ≥ 0 |
| `max_acceptance_items` | 8 | not an integer ≥ 1 |
| `max_acceptance_chars` | 1500 | not an integer ≥ 1 |
| `max_components` | 3 | not an integer ≥ 1 |
| `component_patterns` | `packages/[^/\s]+`, `apps/[^/\s]+` | not non-empty strings that compile as regular expressions |
| `broad_scope_keywords` | `all`, `every`, `entire`, `whole`, `everywhere`, and Japanese equivalents | not a list of non-empty strings |
| `verification_required_types` | `code`, `config`, `test` | not a list of non-empty strings |
| `verification_keywords` | `test`, `verify`, `verification`, `build`, `lint`, `typecheck`, `check`, `assert`, and Japanese equivalents | not a list of non-empty strings |
| `criterion_verification_patterns` | commands (`pnpm`, `node`, …), `*.test.mjs`, "how to check" wording | not non-empty strings that compile as regular expressions |
| `external_state_patterns` | production / running server / other Work wording (`production`, `other Works`, Japanese equivalents, …) | same |
| `state_comparison_patterns` | before-and-after / unchanged wording (`unchanged`, Japanese equivalents, …) | same |
| `external_state_exempt_patterns` | a copy or temp directory, or write-denial evidence | same |
| `heavy_check_patterns` | wording of heavy checks (`real model`, Japanese equivalents, 100+ items, 10+ minutes, a production copy, …) | not non-empty strings that compile as regular expressions |
| `blocking_codes` | `external_state_comparison`, `necessity_missing`, `heavy_check_unjustified` | not a list of known warning codes |
| `record_only_codes` | `acceptance_chars_over` | same; these warnings are recorded but never trigger a repair request or appear in its message |

Two more warning codes: `criterion_verification_missing` (one criterion names no way to check it) and
`external_state_comparison` (one criterion compares state that changes outside the Task, such as
production or another Work, before and after; text matching `external_state_exempt_patterns` is
ignored). A code in `blocking_codes` is still rejected after the repair requests are used up, so the
unprovable criterion goes back to the Manager instead of being accepted with a warning. A list that
starts with bullets counts one bullet as one criterion, however many `(1)`/`(2)` numbers it contains.

The Manager gives every Task a `necessity` (`serves`, `if_omitted`, and one `criteria` entry per acceptance criterion, in order, with `serves`, `if_omitted`, `check_weight` light/medium/heavy and `weight_reason`). `necessity_missing` fires when it is absent or has an empty field, an unreadable weight or the wrong number of entries (design Tasks too). `heavy_check_unjustified` fires when a criterion matches `heavy_check_patterns` or is declared `heavy` and has no `weight_reason`; it is blocking by default. Both apply to every item of a replan (retried and replacement Tasks), and the necessity is appended to the Task context as `Necessity (Manager plan):`.

### Review routing

Core decides after verification passes whether a Task needs the Reviewer
(`decideReviewRouting` in `packages/core/src/review-routing.ts`, called from `routeReview` in
`workflow-engine.ts`). The base decision, in order: a recorded `required` decision (`sticky_required`),
the Manager's `review` of `true` / `false` (`override_true` / `override_false`), then
`type_defaults[type]`. A `design` Task is required by default (`design_default`), because Tasks are planned from it; an unknown type is not required. Core only raises "not
required" to required, never lowers it, and once a Task is required it stays required.
A `design` Task changes no code, so none of the forcing conditions below apply to it; only a recorded
decision or the Manager's `review: true` makes its review required.

**Core forces "required"** (when the base is not required) if any of these holds, each recorded as a
reason with `code`, `detail`, measured value and threshold:

- `changed_lines_over`: added + deleted lines above `max_changed_lines`
- `changed_files_over`: changed files above `max_changed_files`
- `sensitive_path`: a changed path matches a `sensitive_paths` group
- `hybrid_delegation`: the Worker delegated, or ran with Hybrid Mode on (`force_on_hybrid_delegation`)
- `gate_failure_history`: an earlier completion gate failure (`force_on_gate_failure_history`)
- `rejection_history`: an earlier review rejection (`force_on_rejection_history`)

If the change **cannot be measured** (no diff statistics, no worktree or baseline, or the
measurement throws or a file cannot be read), the review is required with `changed_files_over`
and the reason in `detail`. A routing error also falls back to required.

A `research` Task is never reviewed: no forcing condition applies to it, and neither does a Manager `review` override.

**Checks that run even when the review is skipped:** the Worker's completion gate, Core's
per-type verification (and the Project plan), the merge of the Task into the Work branch, the
Work integration verification, and the Final Manager.

**Reason record and display:** the decision (`required`, `base`, `forced_reasons`, `skip_reason`,
`measured`, `thresholds`) is stored in `tasks.review_decision_json` and in the
`verification.completed` event as `review_routing`. `GET /api/v1/works/{id}/assurance`
returns each Task's skip reason and forcing reasons, the latest integration verification and the
plan quality warnings; the Work detail page shows them on the Task rows and in the
"verification and plan warnings" panel.

Settings key `review_routing` (`packages/shared/src/review-routing-settings.ts`; read by
`reviewRouting`; `GET` / `PUT /api/v1/settings/review-routing`, owner only; PUT takes the command
envelope with all keys as `payload` and rejects an invalid value; on read a missing or invalid key falls back
to its default with a warning):

| Field | Default | Invalid when |
|---|---|---|
| `type_defaults` | `code`: required, `config`: required, `doc`: not_required, `test`: required, `research`: not_required | not exactly these five keys, or a value other than `required` / `not_required` |
| `max_changed_lines` | 80 | not an integer from 0 to 100000 |
| `max_changed_files` | 3 | not an integer from 0 to 10000 |
| `sensitive_paths` | `migration`: `**/migrations/**`, `**/*.sql`; `config`: `**/package.json`, `**/pnpm-lock.yaml`, `**/tsconfig*.json`, `**/*.config.{js,cjs,mjs,ts}`, `.github/**`, `**/Dockerfile`, `**/.env*`; `auth`: `**/auth/**`, `**/*auth*.{ts,js,mjs,py}`, `**/*permission*.{ts,js,mjs,py}`, `**/*session*.{ts,js,mjs,py}`; `security`: `**/security/**`, `**/*secret*`, `**/*credential*`, `**/*sandbox*.{ts,js,mjs}`, `**/*csrf*.{ts,js,mjs}` | more than 50 groups, a group name not 1–100 characters, or a group that is not at most 200 non-empty globs (each ≤ 500 characters) that compile |
| `force_on_hybrid_delegation` | `true` | not a boolean |
| `force_on_gate_failure_history` | `true` | not a boolean |
| `force_on_rejection_history` | `true` | not a boolean |

### Measuring

`GET /api/v1/metrics/review` returns `reviewMetrics` (`packages/core/src/review-metrics.ts`,
`Core.getReviewMetrics`; 503 when the Core API is unavailable): `first_review_pass_rate`
(Tasks whose lowest-round review passed / reviewed Tasks, the main KPI), `reviews_per_task`,
`two_plus_roundtrip_rate`, `tokens_per_task`, `total_review_attempts` (Tasks, sum, max), `review_routing` (skipped Tasks; forced Tasks and their count by reason, counted from `verification.completed` events whose base was not required and whose routing forced "required"),
`tokens_per_task_any_review` (all Tasks, reviewed or not) and
`completion_gate_failures` (by `error_key`, counted from `task.failure.classified` and
`task.replan_requested` events that carry `gate_reasons`). Ratios are rounded to four decimals and are `null` when the denominator is 0.

## Required tests

- The list is `tests/required-tests.json` (per file; `flow` is one of work_lifecycle, decision_resume, agent_reports, remake_limits). It is not embedded in code.
- `pnpm test:required` reads the list and runs it. A test file named in the list that does not exist is reported on stderr and the run exits with code 2.
- `pnpm test:prepare` installs dependencies, copies the better-sqlite3 binding and builds. `pnpm test:gate` = prepare + required; `pnpm test:nightly` = prepare + every test (TAP).

## Backlog and draft Works

- **Repair backlog.** Each Project keeps a backlog of follow-up items (findings that were not fixed in a Work). Items are listed at `GET /api/v1/backlog`, shown on the `/owl/backlog` page and in each Work's backlog section (`GET /api/v1/works/{id}/backlog`). `POST /api/v1/backlog/dismiss` hides items, `POST /api/v1/backlog/delete` and `DELETE /api/v1/backlog/{item_id}` remove them, and `POST /api/v1/backlog/issue-work` turns items into a new Work. The Advisor can do the same through `create_work` with `backlog_item_ids` and `dismiss_backlog_item_ids`.
- **Draft Works.** A `create_work` Advisor action with `draft: true` creates the Work without starting it; the Owner starts it later. Without `draft`, the Work starts at once (a `small` Work goes straight to a Worker, others to the Manager).
- **`design_mode`.** `POST /api/v1/works` and `create_work` accept `design_mode`: `auto` (default; a design Task escalates to the Lead Designer only after the plan review rounds are used up) or `lead` (the Lead Designer handles the design from the start). Use `lead` only when the design is hard or the Owner asks for the strongest model.

## Advisor Work operations

Besides `create_work`, the Advisor can act on an existing Work through these actions: `send_work_instruction`, `update_work`, `pause_work`, `resume_work`, `cancel_work` and `delete_work`. The Advisor is given a list of recent Works to identify the one the operator means.

- **`send_work_instruction`** sends an extra instruction (up to 100,000 characters, optionally with attachments) to a Work that has started. It is posted as a message on the Work's web conversation and queues a Manager replan that takes the instruction into account; if the Work was `judgement_waiting`, the instruction answers the open Decisions and restarts it. A `completed` Work is reopened only when the action asks for it (`reopen`); a `cancelled` Work or one not yet started (`memo`/`ready`) is rejected.
- **`update_work`** changes only the Work's title (1–500 characters) and/or summary (up to 20,000 characters); at least one is required and the change is kept in the summary history. If the Work is `running`, `paused` or `judgement_waiting`, a replan is queued so the plan follows the new text; other states just store it.

- **Pause** stops new Task launches; Tasks waiting on a Decision (`judgement_waiting`) stay as they are. **Resume** continues the Work.
- **Cancel** needs a reason (1–1000 characters), stops running agents and removes the Work's worktrees and files. The Work stays in the database as `cancelled`.
- **Delete** works only on `completed` or `cancelled` Works with no open Decision. It removes the Work, its Tasks, runs, reports, events and conversations from the database, so the Work number becomes free again.

## Provider rate limits

When a provider answers with a rate limit (HTTP 429, overloaded, or a reported reset time), Core pauses that provider (`provider_pauses`). Tasks that need it wait in `ready` and start by themselves when the pause ends. The resume time is the reset time the provider reported, or an exponential backoff when none was reported; after the pause Core sends one probe run, and the pause clears when it succeeds. `GET /api/v1/providers/pauses` lists the pauses and `POST /api/v1/providers/pauses/{provider}/resume` (Owner only) lifts one early.

## Background work in Core

Core runs these steps itself, without an agent. The Work page shows the current one as Core activity: `integration_verification` (Project plan on the whole Work branch, see "Work integration verification"), `core_tests` (the related tests of a Task's changes), `merge_verification` (re-running the Project verification on the merge result before the base branch moves; a failure goes to the Manager or Owner and the base branch is untouched), `git_lane_wait` (waiting for the per-repository git lane because another merge is running) and `base_merge` (merging the base branch into a Work branch).

## Automatic build after merge

After a Work is merged into the base branch, Core runs the Project's post-merge command in the Project directory. The default `pnpm build` (real provider mode only) applies only to the Project whose directory is `OWL_ROOT` (Owl itself); any other Project runs nothing unless `post_merge_command` (and optionally `post_merge_install_command`) is set on it. Setting `post_merge_command` also overrides the default for the `OWL_ROOT` Project. When a dependency file (`package.json`, a lockfile such as `pnpm-lock.yaml`) changed in the merge, the install command runs first. Merges that arrive while a build runs are coalesced into one run, and each run has a 15-minute timeout. A failure of either step creates a `system.alert` for the Owner with the redacted output tail; success is recorded as `work.post_merge_command_succeeded`. The server is not restarted by this step.

## owl-memory

Knowledge lives as pages under `<OWL_ROOT>/knowledge`. A SQLite index (`memory-index.sqlite` in `OWL_DATA_DIR`) is rebuilt from those files and can be rebuilt on demand with `POST /api/v1/memory/reindex` (Owner only); embeddings are optional (see the README). Agents read it through the `owl-memory` stdio MCP server (`apps/server/src/memory-mcp.ts`), which exposes three read-only tools: `index` (overview), `page` (open a page) and `search`. The Librarian integrates pending pages (`GET /api/v1/memory/pages/pending`, `POST /api/v1/memory/pages/integrate`) and runs daily at the times in the knowledge automation settings (`librarian_times`).

## What rules are tracked in git

`.gitignore` ignores `knowledge/`, `skills/` and `rules/` except the shipped defaults: `rules/system/defaults.yaml`, `rules/system/safety.yaml`, `rules/system/owl-defaults.yaml` and `rules/role/advisor-defaults.yaml`. Any other rule file, skill or knowledge note is local state and is not committed; back it up with the rest of `OWL_ROOT`.
