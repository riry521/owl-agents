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

## Legacy knowledge migration

Run this procedure as Owner after deploying the migration endpoint. Send
`POST /api/v1/knowledge/migrate-legacy` in the standard command envelope, with the
payload set to `{"dry_run": true}` for the preview and `{"dry_run": false}` to run
the migration.

1. Send the dry run and review the counts. The response fields are `works_files`,
   `policies_files`, `notes_created`, `notes_updated`, `claims_added`,
   `rule_proposals_created`, `skipped` (`path`, `reason`), and `link_check`.
2. When the preview is understood, send the request with `{"dry_run": false}`.
3. Check the response's `link_check.dangling` and `link_check.one_way`; both must be
   empty. `link_check` reports `notes`, `links`, `dangling` entries (`note_id`,
   `target`), and `one_way` entries (`from`, `to`). It only checks links and does not
   repair them. Stop and resolve any reported links before continuing.
4. In the UI, review the migrated notes in Knowledge and the legacy rule proposals
   waiting for approval.
5. In `/owl/rules/approvals`, approve or reject each proposal after review.

The migration is idempotent. It records migrated paths in
`knowledge/notes/.migration.json`; rerunning it skips paths in the manifest. Source
files under `works/` and `policies/` are left in place and are not modified. The
Knowledge folder selector no longer lists `works` or `policies`, but their source
files remain available. A legacy policy tagged `owner-approved` is still sent for
approval again.

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
| Rule proposal source threshold (`RULE_PROPOSAL_MIN_SOURCES`) | 1 | If proposals with one source have a high rejection rate and create approval noise, raise the constant to 2. If useful proposals remain in `pending` waiting for sources, return it to 1. If code changes become burdensome, consider the settings API deferred in design item 15. |
| Knowledge injection limits (`settings.knowledge`) | `max_notes` 3 / `max_tokens` 1500 / `per_note_tokens` 600 / `max_characters` 4000 | If the difference in `TokenUsage.input_tokens` with and without injection greatly exceeds the estimate, review the multiplier (design item 12). If knowledge-related `remaining_issues`/`findings` are absent while costs increase, reduce the limits. If `render` consistently returns fewer `notes` than `select` because of truncation, increase them. |
| Injection hard caps (§6.1 limits) | 10 / 4000 / 1500 / 12000 | Reconsider if requested settings repeatedly reach these caps. |
| Relevance thresholds (`min_score`; topic match) | 3; 3 or more with a score difference of 2 | If unrelated injections or incorrect note merges become common in `Librarian.detectDuplicates` or manual review, raise the thresholds. If notes for the same topic fragment into many new notes, lower them. |

`RULE_PROPOSAL_MIN_SOURCES = 1` is a code constant: a validated proposal with one
source can immediately enter `awaiting_approval`. Approval remains an operator action;
the threshold does not install rules automatically.
