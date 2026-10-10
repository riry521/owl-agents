# Changelog

## 1.0.3 - 2026-10-10

Knowledge that stays organized, curation that runs on its own, and stronger handling of external data.

### Knowledge

- Notes no longer pile up in the catch-all "other notes" page: a new theme can be created at write time, and an overflowing page is split into theme pages instead of creating a numbered "(2)" page
- Pages no longer grow too large, and spelling variants of a page name no longer create separate pages
- The Librarian's page reorganization converges: moves into existing pages, no page mix-ups, size limits are respected, and it keeps going until done
- The Advisor can write decisions from a conversation directly into a Project's knowledge, following the page template

### Curation

- Rule curation and skill curation run on a schedule with the same settings as the Librarian, so duplicate or stale rule proposals and unused trial skills no longer linger
- Duplicate and conflicting rules are judged by meaning with a model instead of text similarity, so paraphrases (including Japanese) are merged
- Rule proposals are limited to general-purpose rules: they are rephrased, project-specific items are routed to Project knowledge, conflicts and duplicates are dropped, and personal rules go to personal files
- Curation Slack notifications are combined into one plain-language message without internal details, and adding a rule sends a notification

### Safety

- Web search results and imported data (clips, attachments, knowledge from external sources) are treated as reference data, never as instructions

### Prompts

- Rules enforced mechanically at run time are left out of the prompt text, and each rule appears only once

### Fixes

- Attachments sent from Slack (such as images) now reach the Advisor
- Flaky tests that occasionally failed on GitHub CI are made deterministic
- Acceptance criteria over the length limit are only recorded instead of sending the Manager back to rewrite them

## 1.0.2 - 2026-10-09

Fewer stuck Works and rejected curation operations, a more capable Advisor, and a batch of small fixes.

### Advisor

- The Advisor uses a single shared worktree, prepared only when it needs to write files and synced to the latest configured base branch (`/api/v1/advisor/workspace`); if it holds uncommitted changes or commits not yet integrated into the base, it is left as is and not synced
- The Advisor can call the Owl API directly; irreversible operations go through approval-gated `owl-actions`, and the results are passed to the next turn

### Works and merging

- Fewer Works wait for a decision when integrating into the base branch: the uncommitted-changes check now matches git, conflicts automatically create a resolution Task, and a base-branch move during verification triggers automatic re-verification and retry
- A Work's worktree whose git registration disappeared is repaired automatically instead of stalling the Work
- After a merge, if dependency files (`package.json`, lockfiles) changed, Owl runs install in the main checkout before building

### Reliability

- Knowledge curation operations are no longer rejected for small variations in model output; shared shape normalization plus fixes for the remaining rejection causes, and rejected operations are logged to find causes
- Report format errors no longer restart the whole run: inconsistencies are fixed in code, the schema is stricter, and resubmission works correctly
- Claude "OAuth session expired" is classified as an authentication error instead of a confusing run-configuration error

### Fixes

- Token list layout on phones and hover styling
- Clearer startup-recovery warning text
- Keychain timeout detection for plan usage
- Slack and Discord connector entrypoint detection

## 1.0.1 - 2026-10-08

Whole-codebase review and fixes after the first public release, plus Worker and review-loop improvements.

### Fixes from the full review

- Reviewed every area (core lifecycle, git/workspace, knowledge/rules/skills/learning, memory, Advisor, agent-runtime/providers, server, web, connectors) and fixed bugs, safety issues, and code-quality problems
- Knowledge `update` without `tags` keeps the original tag lines as written instead of re-serializing parsed values, so body-only edits no longer change tags
- Memory Librarian and router no longer roll back appends written by another writer between routes

### Workers and reviews

- Workers can use Haiku 5.5 as a dispatch child (wraps up at 70k tokens and restarts automatically) and a read-only research helper (Haiku 5.5 for Claude, gpt-6-luna for Codex)
- Workers no longer report "partially done" before their subagents finish; such partial reports are retried automatically
- Pre-report checks no longer hard-code commands; they come from per-project settings, auto-detection, and docs
- When reviews keep flagging new edge cases in the same place, the Manager is asked to change the approach early, and part of the review budget is restored after a replan (configurable, with a cap)
- Added a default rule that Works must finish generated build outputs before completing

## 1.0.0 - 2026-10-07

First public release. It establishes the safety and installability needed for v1 and ships the full feature set below.

### Safety and installation

- Auto-load `.env`, with explicit process environment variables taking precedence
- `OWL_BIND`, loopback default, and a required Bearer token for external bind / Tailscale Serve
- Made Tailscale Serve an explicit opt-in
- Made the stub provider require no external CLI, and cleaned up doctor/setup provider detection into a selectable form
- Made `OWL_DATA_DIR` the common root for the DB, logs, settings, and the connector Vault
- Made the legacy `.owl-data` backward-compatible via a safe missing-file-only migration
- Treat the doctor check on a fresh data directory as a `not_initialized` warning
- Documented the macOS/Linux support range, Windows unsupported/experimental status, backup/restore, and known limitations
- Added root typecheck/test/audit scripts and CI


### Providers and connectors

- `codex` provider alongside Claude, with Codex session drivers and plan-usage reporting
- Slack and Discord connectors (`@owl/connector-slack`, `@owl/connector-discord`) and the `@owl/plugin-sdk` package for plugins loaded via `OWL_PLUGINS_FILE`
- When a provider returns 429, Owl pauses that provider and resumes automatically

### Web UI

- Pages for the board, backlog, decisions, knowledge, rules and approvals, skills, tokens, activity, agents, projects, archive, and settings, plus an Advisor chat page

### Works and planning

- Per-project repair backlog (`/backlog` API): link, dismiss, delete, and issue a Work from an item
- Draft Works that are created but not started until confirmed
- `design_mode` and the Lead Designer role for design Tasks
- The Advisor can operate Works (including cancel and delete), and the `owl advisor` command talks to it from the terminal
- Defined behavior for cancelling and deleting Works
- The web UI shows Core's background processing: integration verification, re-verification before merge, and waiting for merge
- Automatic build after merge
- Remake limits (`remake_limits` setting), including Reviewer rejections of Lead Designer output (`lead_review_rejections`)
- Task prerequisite resume API (`/tasks/:id/prerequisite/resume`)

### Knowledge and rules

- owl-memory: an MCP server, an index, and a Librarian that curates knowledge pages
- Default rule files under `rules/` (system and role defaults) are tracked in git; other rule files stay local

Known limitations are documented in [README.md](README.md) and [docs/operations.md](docs/operations.md).
