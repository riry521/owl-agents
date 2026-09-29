# T8 Codex 実セッション再検証

## 範囲と準備

このサブタスクで実行した経路は D（Codex exec 新規）と E（D の thread ID を使う exec resume）です。argv はビルド済み [buildWorkArgv](../../packages/providers/argv.ts#L51)、基礎 env はビルド済み [buildAgentEnv](../../apps/server/src/agent-env.ts#L94)、Codex の CODEX_HOME は agentUserInstructionEnv("codex", env) から取得しました。D/E の実行に手書きの Codex argv は使っていません。Owl の provider runtime builder ([provider.ts](../../packages/agent-runtime/src/provider.ts#L152)) と guard 接続は [permission-args.ts](../../packages/shared/src/permission-args.ts)、[permission-hook.ts](../../apps/server/src/permission-hook.ts) でも確認しました。

準備コマンド pnpm install --frozen-lockfile --offline は成功し、postinstall build も成功しました。続けて実行した pnpm run build --silent は --silent が next build に渡り失敗したため、同じビルドを pnpm run build で再実行し、exit 0 を確認しました。

mktemp -d で作った一時 Git リポジトリの AGENTS.md に repo canary を置きました。canary の値はこの報告書に記載していません。検証前に ~/.codex/AGENTS.md は存在しないことが分かりました。そのため user canary は作成できず、指定された代替確認として Codex が受け取った指示ファイル一覧と Owl CODEX_HOME の実ファイル構成を確認しました。

子プロセスには /opt/homebrew/bin/codex（codex-cli 0.155.1）、model gpt-6-sol、一時リポジトリの cwd を使いました。Owl env は CODEX_HOME を ~/.owl/codex-home-overlays/owl-codex-home-5a5f33e6687e に切り替え、guard の loopback API URL、token file path、OWL_AGENT_ROLE / OWL_AGENT_RUN_ID / OWL_AGENT_CWD を追加しました。API token や guard token の値は記録していません。

## 経路ごとの結果

| 経路 | (2) user AGENTS.md | (3) repo canary | (4) 認証・応答 | (5) RTK hook | (6) superpowers | (7) MCP | (8) Owl guard |
|---|---|---|---|---|---|---|---|
| D: buildWorkArgv 新規 exec | N/A: ~/.codex/AGENTS.md 自体が不在。fallback 一覧は repo の AGENTS.md / repository のみ。overlay に AGENTS.md と AGENTS.override.md は無い。 | PASS: 最終応答に repo canary が一致。 | PASS: exit 0、Codex JSON 応答あり。 | N/A: Codex の RTK hook は見つからず。設定と history の根拠は下記。 | PASS: model が skill を available と回答。plugin list でも superpowers は installed/enabled、overlay 内に対象 SKILL.md がある。 | PASS: Owl CODEX_HOME で codex mcp list exit 0、5 server を列挙。 | PASS: harmless echo が Owl の PreToolUse で拒否され、rule message を stderr で確認。echo の出力イベントなし。 |
| E: D の ID で buildWorkArgv resume | N/A: D と同じ不在・overlay 構成。fallback 一覧は repo の AGENTS.md / repository のみ。 | PASS: resume 応答に repo canary が一致。thread.started の ID は D の ID と一致。 | PASS: exec resume exit 0、最終応答あり。 | N/A: D と同じ。E の測定窓では共有 history が +2 だが、Codex RTK hook の根拠にはならない。 | PASS（path fallback）: 最初の resume 応答は native skill list を unavailable と回答したが、続く同じ thread の resume で Owl CODEX_HOME 内の verification-before-completion/SKILL.md を読み、skill_name と read 出力を確認。plugin list は installed/enabled。 | PASS: D と同じ Owl CODEX_HOME の codex mcp list 結果。 | PASS: harmless echo が同じ Owl rule message で拒否され、コマンド出力イベントなし。 |

### 実 argv と env の要点

- D は実際に codex exec --json で起動しました。builder が --dangerously-bypass-hook-trust、--sandbox danger-full-access、approval_policy="never"、features.hooks=true、hooks.PreToolUse=...permission-hook.js、marketplaces.openai-bundled.source=...、--skip-git-repo-check、--model gpt-6-sol、-- <prompt> を生成しました。
- E は実際に codex exec resume --json で起動しました。D から得た session/thread ID を渡し、resume 用に --sandbox ではなく --config sandbox_mode="danger-full-access" が生成されました。他の hook / marketplace / approval の設定は D と同じです。resume のイベント ID と D の ID の一致も確認しました。
- MCP 確認では同じ Owl CODEX_HOME の codex mcp list を使い、code-review-graph、computer-use、local-mcp、node_repl、serena が現れました。
- model の指示一覧は D/E とも repository の AGENTS.md のみでした。CODEX_HOME overlay の root には config.toml、hooks.json、plugins、.tmp があり、config / hook / plugin directories は元の Codex home への symlink でした。AGENTS.md と AGENTS.override.md はありません。
- superpowers は codex plugin list --json で installed/enabled と表示され、overlay 経由で skills/verification-before-completion/SKILL.md を確認しました。resume の最初の問い合わせでは available=false でしたが、同じ resume thread で当該ファイルを直接読み取れました。

### (5) RTK hook の判定

Codex は PreToolUse hook をサポートします（[Codex hooks documentation](https://developers.openai.com/codex/hooks)）。この端末の ~/.codex/config.toml には [hooks] と features.hooks がなく、rtk 文字列もありません。~/.codex/hooks.json の4 event (PostToolUse, SessionStart, Stop, UserPromptSubmit) はすべて handler 数 0 で、rtk 参照もありません。Codex plugin cache の hook manifest は 0 件でした。従って Codex 経路に RTK hook はありません（該当なし）。Codex config/plugin の文書と hook 設定を確認した範囲で、RTK の起動設定は見つかりませんでした。

T6 の rtk gain --history 相当で総 command 数を実行直前・直後に確認しました。共有履歴は並行する Claude 検証でも変わるため、差分だけで個別コマンドの実行者は特定できません。

| 測定 | total commands 前 → 後 | 差 |
|---|---:|---:|
| Owl 外の素の Codex 対照（Owl 実行前） | 146356 → 146356 | 0 |
| D: Owl exec | 146356 → 146356 | 0 |
| E: Owl exec resume | 146357 → 146359 | +2 |
| Owl 外の素の Codex 対照（Owl 実行後） | 146371 → 146371 | 0 |

E の前後で共有履歴が増えましたが、Codex config / hook / plugin に RTK hook が無いこと、対象の shell request が harmless echo で guard に拒否されたことから、RTK hook 発火とは判定していません。直近の履歴には rtk git ... があり、並行 Claude 検証との切り分けはできません。

### (8) guard の実測と設計

buildWorkArgv が Codex に features.hooks=true と matcher * の hooks.PreToolUse と Owl permission-hook.js を渡します。実測では shell/Bash 呼び出しが hook に渡り、hook は /api/v1/guard/check を呼んで RuleStore の判定で拒否しました（[permission-args.ts](../../packages/shared/src/permission-args.ts#L48)、[permission-hook.ts](../../apps/server/src/permission-hook.ts#L92)、[rule-store.ts](../../packages/core/src/rule-store.ts#L367)）。

実測には一時 guard root と一時 RuleStore を用い、唯一の追加 block rule を echo OWL_T8_GUARD_PROBE にしました。これは出力のみで、ファイルや Git remote に触れない probe です。D/E の実セッション stderr にその rule の拒否理由が現れ、model も blocked_by_owl=true と回答しました。Codex JSONL には echo の実行結果イベントがありませんでした。D/E の双方で guard token を使って実サーバーの /api/v1/guard/check に到達しています。

## (9) Owl 外の対照と user files

Owl 実行前後に、Owl の CODEX_HOME / argv を使わず、通常環境から codex exec --json --skip-git-repo-check --model gpt-6-sol -- <prompt> を実行しました。実行環境の CODEX_HOME は未設定だったため、どちらも通常の ~/.codex を使いました。前後とも exit 0 で repo canary が一致しました。user canary は ~/.codex/AGENTS.md が当初から存在しないため比較対象なしです。

| user file | 検証前: mtime / SHA-256 | 検証後: mtime / SHA-256 | 判定 |
|---|---|---|---|
| ~/.claude/CLAUDE.md | 2026-04-12 15:27:48 JST / f041bf5d84479949f54517c536d98dd5980f6feb046f54c978c8baf7b609045f | 2026-04-12 15:27:48 JST / f041bf5d84479949f54517c536d98dd5980f6feb046f54c978c8baf7b609045f | PASS: 一致 |
| ~/.claude/settings.json | 2026-09-25 21:21:45 JST / 45f9775124a35105fdf518acd5964fde180974bf047ab70f56568fba1e85ffbd | 2026-09-25 21:21:45 JST / 45f9775124a35105fdf518acd5964fde180974bf047ab70f56568fba1e85ffbd | PASS: 一致 |
| ~/.codex/AGENTS.md | 不在 | 不在 | N/A: user canary 作成不可 |
| ~/.codex/config.toml | 2026-09-28 16:35:23 JST / 7dc4d85ca5c9a38375a121000bd45c91f64969f3072079c75590c0c172b781e4 | 2026-09-29 01:05:53 JST / b87193e6119c98531b9332a35b6b31e3952f7b63f7da84eb6236c0e0c097fd71 | **FAIL: mtime / hash が変化** |

検証では ~/.codex/config.toml を直接書き換えるコマンドは実行していません。検証後の確認中、mtime が同じ 01:05:53 JST のまま SHA-256 が da3b6a0beb82d7e8a7f20a467f55a1e33d411271d3e376db1cf744d1442f08c4 と b87193e6119c98531b9332a35b6b31e3952f7b63f7da84eb6236c0e0c097fd71 の2値で観測され、その後の再確認では後者が続きました。Codex exec / plugin list と Claude 側の並行検証が同じ時間帯にあり、どちらが変更したか、または一時書き込み中だったかは特定できません。ユーザーファイルは復元・編集していません。従って項目 (9) は config.toml の変更により未達です。

## 結果

- PASS: D/E の実 argv/env 起動、認証・応答、repo canary、Owl guard、MCP 表示、superpowers の path 参照。
- N/A: user canary（~/.codex/AGENTS.md 不在）、Codex RTK hook（設定・plugin hook に存在しない）。
- FAIL: 項目 (9) の ~/.codex/config.toml mtime / hash 不一致。変更元は未特定。
- ユーザーファイルは編集・移動していません。一時 mktemp ディレクトリは検証後に削除しました。
