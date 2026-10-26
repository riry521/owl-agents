## 0.8.0 - 2026-10-27

Slack のチャンネルへ Owner を招待するボタンと、Advisor ウィンドウの並べ替えが加わり、レート制限、テストの準備、clone の置き場の扱いが改善されました。

### Advisor と連携

- 既存の Slack のウィンドウチャンネルに Owner を招待するボタンを、チャンネルのパネルと 設定 → 連携 に足した
- プロジェクトの Advisor ウィンドウを、一覧でドラッグして並べ替えられる。並びは保存される

### レート制限

- エラーコードも使用量上限のメッセージもない 429 を、一時的な上限として扱う。まず同じ実行の中で数回やり直し、それでも続くときに provider を一時停止する
- provider が返したエラーの原文を記録し、原因を後から調べられるようにした

### Fixer とテスト

- 検証の不合格を、Reviewer の差し戻しと合わせて Fixer への切り替えの回数に数える
- テストの既定のモードを per_file にした。準備の手順は、依存するファイルが変わっていなければ飛ばす
- テストを whole モードで動かすプロジェクトでは、各 Task の検証で全件テストを動かさない。全件テストは Work の検証で1回動かす

### clone とルール

- Worker は外部リポジトリの clone をプロジェクトの外に置く。Owl が置き場を選んで Worker に伝える。clone をプロジェクトの中に置いた Task や、clone に手を加えた Task は、検証で失敗になる
- 外部リポジトリの clone を、プロジェクトの外に取ったまま手を加えずに扱うルールを、標準のルールに足した

### ドキュメント

- README と docs/operations.md を、これらの変更に合わせて更新した

## 0.7.0 - 2026-10-26

Advisor が全体用とプロジェクト別のウィンドウに分かれ、Decision の説明と対処、止まった Agent の扱いが大きく改善されました。

### Advisor

- Advisor を、全体用のウィンドウとプロジェクトごとのウィンドウに分けた。全体用の名前は Owl になった
- プロジェクトのウィンドウをオンにすると、そのプロジェクト用の Slack / Discord チャンネルが自動で作られる
- Advisor ウィンドウの画面を作り直した。サイドバーとシートを備え、画面に合わせて収まるレイアウトになった
- 入力欄の動きが滑らかになり、送信した直後に入力が消える。表示も速くなった
- owl-action に send_file を追加した。ファイルを Slack / Discord へアップロードできる
- 状況を尋ねる発言の判定を絞り込み、通常の依頼を状況確認と取り違えにくくした。状況の返信は Core にも記録される

### Decision

- すべての Decision が「なぜ止まったか」と「どうすればよいか」の二つに分けて説明される
- 失敗の説明を書き直した。うまく説明できない場合は決まった形式で表示する
- Owner が Decision の画面から直し方を選べる。Manager が計画そのものを修復することもできる
- 止まった作業が終わると、未確認の停止を示す Decision は自動で消える

### 受け入れ基準と実行の制御

- 受け入れ基準を「必須」と「目標」に分けた。目標が未達でも、必須を満たしていれば完了できる
- 一時停止や Owner からの指示があると、実行中の Agent を止めて計画を立て直す

### その他

- 古い Claude モデルを、既定のモデル候補から外した
- Librarian へ渡すページ一覧をスコープごとに一度だけ送るようにし、入力が上限を超えないようにした

## 0.6.1 - 2026-10-22

Work の前提条件を設定でき、直せる失敗は自動で再試行されるようになりました。

### Work の前提条件

- Work に前提となる Work を設定できる。前提がすべて完了すると、その Work が自動で始まる
- Work の詳細画面に前提条件の欄が加わり、確認や追加、削除ができる

### 失敗時の自動復旧

- 直せる失敗は、Decision を開く前に自動で再試行される。Owner への確認が必要になる場面が減る
- 自動復旧の動きは設定画面から調整できる
- 一部完了の繰り返しや、報告形式の不備、レビューの失敗などでの復旧が安定した

### ルール

- 必要な場合に限り、テストの全件実行を許可するルールを追加した

## 0.6.0 - 2026-10-21

止まった Decision の説明が詳しくなり、Web UI の再接続や Work の削除・番号付けなど、日々の使い勝手が良くなりました。

### Decision と Worker の報告

- 止まった Decision に、原因（作業・条件・外部のどれか）、直し方の選択肢、おすすめの答えが付くようになった
- 一部だけ終わった Worker の報告は、失敗ではなく「一部完了」として記録される。失敗回数には数えず、続くときだけ別の上限で止めて Owner に確認する

### Design

- すべての design Task が HTML モックを保存して表示できる。担当 Designer による制限はなくなった

### Web UI と Work

- Web UI の WebSocket が切れても自動で再接続する
- memo と ready の Work は、アーカイブせずにそのまま削除できる
- Work の番号は、これまでの最大番号 + 1 で振る。途中で空いた番号は再利用しないので、ブランチ名やコミットに書いた `#N` が別の Work を指さない

### 安全性

- outbound guard は、`allowed_internal` に書いた host:port と一致する宛先だけ内部アドレスへの接続を許可する。稼働中の画面（127.0.0.1:4400 など）を閲覧できるが、ホスト単位の許可はない
- ルールファイルの読み込み時に `outbound.yaml` を誤って読まないようにした

# Changelog

## 0.5.0 - 2026-10-17

opencode can now run every role and every child, and the Advisor can finish its own work in a Git workspace.

### Executors

- opencode can be chosen as the model harness for every role, next to Claude and Codex
- Child tasks can also run on opencode
- Settings now choose one executor harness for all children, with its own model and effort, whatever harness the parent Worker uses
- The old per-parent default and allowed model lists for children are gone
- `owl doctor` checks that opencode is installed and logged in, and lists what opencode cannot enforce as strongly as Claude and Codex
- opencode children now answer permission prompts correctly, so they no longer fail in real Works
- When a child fails, its original error is kept (with secrets hidden) and shown in the Task

### Advisor

- The Advisor can finish a direct job: Owl merges its commits into the base branch and removes the worktree and branch
- If the merge cannot be done safely, nothing is changed and the Advisor tells you the reason
- Unused Advisor worktrees are cleaned up by their content, so work that has not reached the base is not lost

## 0.4.0 - 2026-10-16

Setup finds `claude` and `codex` on its own, and `owl advisor` works as a plain terminal conversation.

### Setup

- `setup.sh` searches for the `claude` and `codex` commands and writes their paths to the settings automatically
- `owl doctor` warns when a provider command is missing or cannot run

### CLI

- `owl advisor` shows only the replies to the message you sent, so you can talk with the Advisor from the terminal alone

## 0.3.0 - 2026-10-16

Design mock previews with per-Task Designer assignment, automatic Project registration for new repositories, and sturdier Codex and verification handling.

### Projects

- New repositories that Works start in are registered as Projects automatically
- A Work that has no Project can be moved to a Project from the Work detail page (backed by a new API)
- The external worktree no longer follows Python virtualenv symlinks out of the checkout

### Workflow

- The Manager assigns a Lead Designer to each design Task, and HTML design mocks can be previewed on the Work detail page
- Design Tasks are no longer retried when the design document is unchanged or the same error repeats
- Verification policy settings can be updated, and a TOML checker validates TOML files
- File tests use the Project's `test_run` setting, and test setup retries resume where they stopped

### Providers

- Codex resumes after a rate limit wait with minute precision plus a 90-second grace period
- Provider output schemas list every property of closed objects, as Codex requires

### Knowledge

- Page columns are recomputed when rules change, and oversized page items are skipped
- Web research done by the Advisor and its subagents is saved to research notes
- A new `materials/` folder in the vault is excluded from the Librarian and from indexes

## 0.2.0 - 2026-10-11

Per-Project test setup that the agent investigates and verifies, a Fixer role for repeatedly rejected Tasks, and a per-Project commit language.

### Projects

- The agent now investigates which test method suits each Project, confirms it runs, and saves it (on registration, on change, and when a run fails because of the environment)
- The investigation can install what it needs itself, accepts partial test failures and records them as known failures, and cleans up test leftovers
- A "re-investigate" button in the Project edit form (backed by a new API) reruns the investigation manually
- Checkout snapshots used by the investigation exclude gitignored files
- A Project can set `commit_language` (ja / en); for en Projects, Work completion commits are written in English

### Workflow

- A Worker Task rejected twice in review is promoted to a higher-model Fixer role, which makes the fix
- When test running is turned off for a Project, Task verification no longer runs the test runner either

### Advisor

- Fixed a bug where already-delivered `owl-action-results` were attached again to the Advisor's next turn

## 0.1.3 - 2026-10-10

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
- Knowledge organizing (#144) removes the `owl:new` mark from new lines the model judged already placed, and a run with zero changes is no longer treated as a failure
- The `memory_librarian` setting is removed (#145): knowledge organizing and the other curation runs use the Librarian and Curator role settings, and all default models move to the 5.5 generation
- Knowledge organizing no longer writes page backups under `data/backups/memory-pages/` on every run; a failed run is still rolled back from the original text kept in memory

## 0.1.2 - 2026-10-09

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

## 0.1.1 - 2026-10-08

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

## 0.1.0 - 2026-10-07

First public release. It establishes the safety and installability needed for public use and ships the full feature set below.

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
