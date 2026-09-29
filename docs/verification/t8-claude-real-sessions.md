# T8 実セッション再検証（Claude 全経路・Codex exec/resume）

実施日: 2026-09-29 (Asia/Tokyo)

## 検証方法

- `pnpm install --frozen-lockfile --offline` は exit 0。続けて `pnpm --silent build` も exit 0。
- 一時 Git repository を作り、`CLAUDE.md` と `AGENTS.md` にランダムな repo canary を置いた。各 resume の直前に別の canary へ更新・commit し、会話履歴の再利用だけで成功扱いしないようにした。repository に remote は設定していない。
- Owl root は `/Users/ryo/owl-agents`。build 済み `buildAgentEnv` で env を作り、`OWL_ROOT`、`CLAUDE_CODE_DISABLE_NONPROJECT_CLAUDE_MD=1`、role/CWD、RTK を含む PATH を確認した。guard API は同じ Owl の build 済み HTTP route と RuleStore を使う loopback の一時サーバーに向け、各子プロセスに role 対応 token lease を渡した。
- A は build 済み `packages/providers/dist/argv.js` の `buildWorkArgv`、B/C は build 済み `provider.ts` の `createSession` から `AdvisorSessionDriver`、D/E は build 済み `provider.ts` の `createCliProvider.execute` が実際に組み立てた argv/env を spawn 時に記録した。prompt、session ID、token、認証値は報告に含めない。
- 実行 CLI は Claude `/Users/ryo/.local/bin/claude`、Codex `/opt/homebrew/bin/codex`、RTK `/opt/homebrew/bin/rtk`。Claude model は `claude-sonnet-5`、Codex model は build 済み harness の default `gpt-5.6-terra`。

## 経路別結果

| 経路 | (1) Claude 全体設定を除外 | (2) Codex 全体 AGENTS を除外 | (3) repo canary | (4) 認証・応答 | (5) RTK hook | (6) superpowers | (7) MCP | (8) guard block |
|---|---|---|---|---|---|---|---|---|
| A. Claude `-p` / `buildWorkArgv` | **FAIL** — user canary が応答または出力ログに一致 | — | PASS | PASS — exit 0 | PASS — Recent Commands に `rtk git status` を1件確認 | PASS — model inquiry で `using-superpowers` の利用可を確認 | **FAIL / 未達** — MCP への言及はあったが、server 名/init/tool-use event を確認できず | PASS — route の env で hook が deny。実行応答にも deny が現れた |
| B. Advisor 新規 `stream-json` / `--session-id` | **FAIL** — user canary が応答または出力ログに一致 | — | PASS | PASS — turn completed | PASS — Recent Commands に1件追加 | PASS — init の skill list と `superpowers:using-superpowers` 呼び出しを確認 | PASS — init に6 server、`mcp__serena__list_dir` 呼び出しを確認 | PASS — hook が deny。実行応答にも deny が現れた |
| C. Advisor `--resume` / B と同じ session ID | **FAIL** — user canary が応答または出力ログに一致 | — | PASS — resume 前に回転した新 canary に一致 | PASS — turn completed | PASS — Recent Commands に1件追加 | PASS — init の skill list と skill 呼び出しを確認 | PASS — init に6 server、MCP tool-use を確認 | PASS — hook が deny。実行応答にも deny が現れた |
| D. Codex `exec` / `provider.ts` | — | **FAIL / 未検証** — `~/.codex/AGENTS.md` が検証前から存在しない | PASS | PASS — exit 0 | **FAIL** — 前後で RTK status row の追加なし | PASS — model inquiry positive | **FAIL / 未達** — MCP への言及はあったが、server 名/init/tool-use event を確認できず | PASS — route の env で hook が deny。実行応答にも deny が現れた |
| E. Codex `exec resume` / D と同じ thread ID | — | **FAIL / 未検証** — `~/.codex/AGENTS.md` が検証前から存在しない | PASS — resume 前に回転した新 canary に一致 | PASS — exit 0、D と同じ thread ID | **FAIL** — 前後で RTK status row の追加なし | PASS — model inquiry positive | **FAIL / 未達** — MCP への言及はあったが、server 名/init/tool-use event を確認できず | PASS — hook が deny。実行応答にも deny が現れた |

Claude A/B/C では argv に `--settings <Owl permission-hook と claudeMdExcludes>` が入り、env にも `CLAUDE_CODE_DISABLE_NONPROJECT_CLAUDE_MD=1` がありました。それでも RTK.md 内の user canary が3経路すべての応答または出力ログに一致したため、(1) は修正後も未達です。値そのものはここに転記していません。

B/C の Advisor init は `mcp_servers` に6 server を示し、MCP tool-use も確認しました。A と Codex の exec/resume は JSON 出力に init/tool-use event がなく、server を特定できる証拠を保存できなかったため (7) を failure としました。

## argv の要点

以下は spawn 時に採取した実 argv の要約です。JSON 設定本文、prompt、session ID は省略しています。

- A: `claude -p --output-format json --permission-mode bypassPermissions --settings <hook + claudeMdExcludes> --model claude-sonnet-5 -- <prompt>`。
- B: `claude -p --output-format stream-json --input-format stream-json --verbose --permission-mode bypassPermissions --settings <hook + claudeMdExcludes> --session-id <redacted> --model claude-sonnet-5 --effort low --append-system-prompt <omitted>`。
- C: B と同じ Advisor argv で、`--session-id` の代わりに `--resume <same redacted ID>`。
- D: `codex exec --json --dangerously-bypass-hook-trust --sandbox danger-full-access --config approval_policy="never" --config features.hooks=true --config hooks.PreToolUse=... --config marketplaces.openai-bundled.source=... --skip-git-repo-check --model gpt-5.6-terra --config model_reasoning_effort=medium -- -`。
- E: D の `exec` を `exec resume` にし、resume 用 `--config sandbox_mode="danger-full-access"` と同じ thread ID を使用。resume argv に `--sandbox` はありません。

各 Owl child env は `OWL_ROOT=/Users/ryo/owl-agents`、`OWL_AGENT_CWD=<一時 repository>`、適切な `OWL_AGENT_ROLE`、一時 guard token file、loopback guard API を持ち、PATH から `/opt/homebrew/bin/rtk` が解決されました。Codex では `CODEX_HOME` overlay も使われました。

## RTK 前後差分

T6 の `rtk gain --history` を各実行の直前・直後に呼び、Recent Commands の差分を比較しました。各経路は直列で、測定区間に他の command row の追加はありませんでした。

| 実行 | Recent Commands 前 → 後 | 差分 |
|---|---:|---|
| Owl 外の raw `claude -p --permission-mode bypassPermissions` 基準 | 2 → 3 | `rtk git status` +1 |
| A. `buildWorkArgv` | 3 → 3* | `rtk git status` +1 |
| B. Advisor 新規 | 3 → 4 | `rtk git status` +1 |
| C. Advisor resume | 4 → 5 | `rtk git status` +1 |
| D. Codex exec | 5 → 5 | 追加なし |
| E. Codex exec resume | 5 → 5 | 追加なし |

\* Recent Commands は rolling list です。A の区間は新しい status row が1件加わり、古い row が表示範囲から落ちたため、表示行数は同じでした。追加 row は `rtk git status`、区間内の別 command row はありません。したがって RTK は raw Claude 基準と Claude 3経路で発火し、Codex 2経路では確認できませんでした。

## guard hook

`git push -f` は remote のない一時 repository で要求しました。各 route の実 spawn env/token を使って build 済み `apps/server/dist/permission-hook.js` に PreToolUse 入力を渡したところ、すべて `permissionDecision=deny`。build 済み RuleStore の照合結果も `blocked=true`, rule ID `no_force_push` でした。実際の push は行っていません。

## Owl 外の基準とユーザーファイル

素の Claude は T6 の基準 argv `claude -p --permission-mode bypassPermissions <prompt>` で実行し、repo canary と global Claude/RTK canary の両方を応答で確認しました。素の Codex `codex exec --json --skip-git-repo-check --model gpt-5.6-terra -- <prompt>` は exit 0 で repo canary を返しましたが、`~/.codex/AGENTS.md` は存在しなかったため、Codex global canary を確認する基準にはできませんでした。

検証直前・直後に `stat` と `shasum -a 256` を取得しました。

| ファイル | 検証前 stat / SHA-256 | 検証後 stat / SHA-256 | 結果 |
|---|---|---|---|
| `~/.claude/CLAUDE.md` | 2026-04-12T15:27:48+0900, 8 bytes<br>`f041bf5d84479949f54517c536d98dd5980f6feb046f54c978c8baf7b609045f` | 同一 | unchanged |
| `~/.claude/settings.json` | 2026-09-25T21:21:45+0900, 4803 bytes<br>`45f9775124a35105fdf518acd5964fde180974bf047ab70f56568fba1e85ffbd` | 同一 | unchanged |
| `~/.codex/AGENTS.md` | missing | missing | file absent before and after; content exclusion cannot be verified |
| `~/.codex/config.toml` | 2026-09-28T16:35:23+0900, 7579 bytes<br>`7dc4d85ca5c9a38375a121000bd45c91f64969f3072079c75590c0c172b781e4` | 2026-09-29T01:05:53+0900, 7738 bytes<br>`b87193e6119c98531b9332a35b6b31e3952f7b63f7da84eb6236c0e0c097fd71` | **changed** |

Codex config の変更原因は特定できませんでした。検証中に素の Codex 基準と Owl の Codex exec/resume を実行しており、並行した Codex 側検証もあり得ます。Owl が使った `CODEX_HOME` overlay の `config.toml` は元の `~/.codex/config.toml` への symlink でした。そのため Codex CLI が overlay 経由で書いた可能性がありますが、どのプロセスの書き込みかは切り分けられません。ファイルを直接編集・復元していません。

## 結果

- 成功: build、5経路の認証応答、5経路の repo canary、Advisor の同一 ID resume、Claude A/B/C の RTK row、5経路の guard deny、Advisor の superpowers/MCP init。
- failure: Claude A/B/C の user canary 除外、MCP の直接確認 (A/D/E)、Codex D/E の RTK row、Codex global AGENTS の確認（対象ファイルなし）、`~/.codex/config.toml` の不変性。
- A と Codex D/E の superpowers は model inquiry で positive でした。Codex の superpowers plugin directory も存在しましたが、これらの JSON 出力では init/tool-use event はありません。

検証用に `mktemp` で作成した一時ディレクトリは終了後に削除しました。

ソースコードは変更していません。

## 統合レビュー注記

- Codex D/E の (5) RTK と (7) MCP は、別報告 [t8-codex-real-sessions.md](t8-codex-real-sessions.md) の調査を優先する。`~/.codex/config.toml` と `hooks.json` に RTK hook の設定がないため、(5) は Owl の不具合ではなく該当なし（N/A）。(7) は Owl の `CODEX_HOME` での `codex mcp list` が5 server を列挙した。この報告の D/E の (5) FAIL と (7) FAIL は、JSON 出力に event がなかったことだけを根拠にしている。
- `~/.claude/CLAUDE.md` は 8 bytes で、実体は RTK.md への参照のみ。(1) の FAIL は canary が応答または出力ログに一致したという判定で、どの出力に現れたかの切り分けを保存していない。原因の確定には、出力元（応答本文か hook 出力か）を分けた再測定が必要。
- `~/.codex/config.toml` の変化は、両報告で同じ時間帯（2026-09-29 01:05:53 JST）に観測され、書き込み元は未特定。

## 残課題（未解決・バックログ行き）

- 問題: Owl 経由の Claude 3経路（`-p`/`buildWorkArgv`、Advisor 新規 `--session-id`、Advisor `--resume`）で、`~/.claude/CLAUDE.md`（RTK.md を含む）が除外されたことは実セッションで確定していない。根拠: T8 の経路別結果 A/B/C の (1) はすべて **FAIL**（user canary が応答または出力ログに一致）だが、T5R では合格と判定され、結果が食い違っている。関連記録 [rtk-hook-owl-sessions.md](rtk-hook-owl-sessions.md) でも三経路の `--settings` に `claudeMdExcludes` が含まれることを確認している。T8 の統合レビュー注記のとおり応答本文か hook 出力かを分けて保存しておらず、user canary も hook 出力や `rtk` の help に出る文字列だったため、誤検知の可能性がある。次にやること: 一意な canary を使い、最終応答の1行だけで判定し、応答本文・tool_result・hook 出力のログを出力元ごとに分けて保存し、素の `claude` と除外なしの対照を取る。→ 再検証結果は「残課題の再検証」(1) を参照。
- 問題: 検証の前後で `~/.codex/config.toml` の mtime と SHA-256 が変わり、書き込み元は特定できていない。根拠: T8 の表では mtime が 2026-09-28 16:35:23 JST から 2026-09-29 01:05:53 JST に変化し、[t8-codex-real-sessions.md](t8-codex-real-sessions.md) も変更元未特定と記録している。CODEX_HOME overlay 内の `config.toml` は元の `~/.codex/config.toml` への symlink だったため、Owl 経由の Codex が書いた可能性がある。次にやること: 素の `codex exec` と Owl 経由を1回ずつ単独で実行して前後のハッシュを比べ、Owl 経由だけで変わる場合は overlay の `config.toml` をコピーにする。→ 再検証結果は「残課題の再検証」(2) を参照。
- 問題: Claude の `-p` 経路（`buildWorkArgv`）で MCP が使えることの直接の証拠がない。根拠: T8 の経路別結果 A の (7) は **FAIL / 未達**で、server 名、init、tool-use event を確認できていない。次にやること: `stream-json` の init イベントにある `mcp_servers` を記録する。→ 再検証結果は「残課題の再検証」(3) を参照。

## 残課題の再検証

実施日: 2026-09-29（Asia/Tokyo、12:25〜12:30 JST 頃）。Claude 2.1.284。ユーザー設定（`~/.claude/*`、`~/.codex/AGENTS.md`）は読むだけで、編集していない。`~/.codex/config.toml` は codex の実行で変わったが、元に戻していない（観測結果として記録する）。ログはすべて `/tmp/owl-d2b/logs/`（この Worker の環境上の一時領域。リポジトリには含めない）。

前提と限界:
- `apps/server/dist/permission-hook.js` がこの worktree では未ビルドで、`buildAgentPermissionArgs` は例外になる。そのため argv は `packages/shared/src/permission-args.ts`、`packages/providers/argv.ts`、`packages/agent-runtime/src/advisor-session-driver.ts` の `buildStartArgv` から、除外に関わる部分（`--permission-mode bypassPermissions`、`--settings {"claudeMdExcludes":[<CLAUDE_CONFIG_DIR>/CLAUDE.md]}`、`--session-id`/`--resume`、`--append-system-prompt`）だけを手で再現した。hooks は入れていない（除外の判定に関係しない）。Owl のプロセス自体は起動していない。
- `~/.claude/CLAUDE.md` は編集しない方針のため、一時 `CLAUDE_CONFIG_DIR=/tmp/owl-d2b/cfg`（認証ファイルは一時的にコピーし、終了後に削除）に user canary 入りの `CLAUDE.md`、一時 git リポジトリ `/tmp/owl-d2b/repo` に repo canary 入りの `CLAUDE.md` を置いた。検証しているのは除外の仕組みであり、実際の `~/.claude/CLAUDE.md`（8 bytes、`@RTK.md`）そのものではない。

### (1) Claude 3経路のユーザー設定除外

canary: user=`OWL_USER_CANARY_c41d7e9b`、repo=`OWL_REPO_CANARY_*`（`-p` は 88a2f0d3、Advisor 新規は 5b19e6a7、`--resume` の前に e07c3d92 へ変更してコミット）。プロンプトは「`user_canary=PRESENT|ABSENT, repo_canary=PRESENT|ABSENT` の1行だけを返す」。判定は最終応答（`*.final.txt`）の1行のみ。ログは `*.jsonl`（生）、`*.final.txt`、`*.assistant.txt`、`*.tool_result.txt`、`*.hook.txt` に出力元ごとに分けて保存。すべて `--model haiku`。

対照（先に実行、同じ cwd と env）:

| 対照 | コマンド（要旨） | 最終応答の1行 |
| --- | --- | --- |
| 素の claude（除外なし） | `claude -p --output-format stream-json --verbose --model haiku <prompt>`（`ctrl1`） | `user_canary=PRESENT, repo_canary=PRESENT` |
| Owl の -p argv から除外だけ外す | `claude -p --output-format json --permission-mode bypassPermissions --settings '{}' --model haiku -- <prompt>`（`ctrl2`） | `user_canary=PRESENT, repo_canary=PRESENT` |
| Advisor 新規から除外だけ外す | 下記 Advisor argv で `--settings '{}'`（`advctrl`） | `user_canary=PRESENT, repo_canary=PRESENT` |
| Advisor `--resume` から除外だけ外す | 別セッション `advctrl2` を `--settings '{}'` で作り、同じ設定で `--resume`（`Rctrl`） | `user_canary=PRESENT, repo_canary=PRESENT` |

対照はすべて user=PRESENT で、canary の設定は有効。

Owl 経路（`CLAUDE_CONFIG_DIR=/tmp/owl-d2b/cfg`、cwd=`/tmp/owl-d2b/repo`）:

| 経路 | ログ名 | コマンド（要旨） | 最終応答の1行 | 判定 |
| --- | --- | --- | --- | --- |
| `-p`（`buildWorkArgv`） | `P` | `claude -p --output-format json --permission-mode bypassPermissions --settings '{"claudeMdExcludes":["/tmp/owl-d2b/cfg/CLAUDE.md"]}' --model haiku -- <prompt>` | `user_canary=ABSENT, repo_canary=PRESENT` | PASS |
| Advisor 新規 `--session-id` | `N` | `claude -p --output-format stream-json --input-format stream-json --verbose --permission-mode bypassPermissions --settings '<同上>' --session-id <uuid> --model haiku --append-system-prompt <text>`（プロンプトは stdin の stream-json 1行） | `user_canary=ABSENT, repo_canary=PRESENT` | PASS |
| Advisor `--resume` | `R` | 上と同じで `--session-id` を `--resume <N の session id>` に置換（repo canary を変更してコミット後） | `user_canary=ABSENT, repo_canary=PRESENT` | PASS |

canary が現れたログ種別: 全8本の生 jsonl と分割ログで `OWL_USER_CANARY` の文字列は 0 件（モデルは PRESENT/ABSENT だけを返し、canary の値は出力していない）。hook 出力や tool_result に由来する誤検知は起きない構成で、判定は最終応答の1行だけに基づく。

結論: 3経路とも PASS（除外が効き、repo は維持）。T8 の FAIL は、hook 出力や rtk の help にも出る文字列を canary にして出力ログ全体で判定したための誤検知と考えられるが、当時のログが残っていないため T8 の原因の断定は未確定。制約として、hooks 抜きの argv を手で再現しており、Owl 本体の起動は含まない。`--resume` の対照は「別セッションを除外なしで作って resume」であり、除外ありで作ったセッションの resume との対比ではない。

### (2) `~/.codex/config.toml` の書き込み元

実行前に他の codex プロセスがないこと（`ps` で 0 件）を確認し、単独で1回ずつ実行した。コマンドと結果:

| 順 | 実行 | 前 SHA-256（先頭12桁）/ mtime | 後 SHA-256（先頭12桁）/ mtime | 変化 |
| --- | --- | --- | --- | --- |
| 1 | 素の codex: `cd /tmp/owl-d2b/repo; codex exec --json --skip-git-repo-check -- "Reply with the single word OK."` | b87193e6119c / 1790611553（2026-09-29 01:05:53） | b95f4dc8807c / 1790652437（12:27:17） | **変化あり** |
| 2 | Owl 相当: 同じ `/tmp/owl-d2b/repo` で `CODEX_HOME=~/.owl/codex-home-overlays/owl-codex-home-5a5f33e6687e codex exec --json --dangerously-bypass-hook-trust --sandbox danger-full-access --config 'approval_policy="never"' --skip-git-repo-check -- "Reply with the single word OK."` | b95f4dc8807c / 1790652437 | b95f4dc8807c / 1790652437 | 変化なし |
| 3 | Owl 相当を新しい cwd `/tmp/owl-d2b/repo2` で1回 | b95f4dc8807c / 1790652437 | 07ec0b08fb4f / 1790652459 | **変化あり** |

- 変化の内容: 実行後の `config.toml` に `[projects."/private/tmp/owl-d2b/repo"]`（105行目）と `[projects."/private/tmp/owl-d2b/repo2"]`（108行目）が追加されていた。codex CLI が、初めて使う cwd をプロジェクトとして `config.toml` に書き込む。書き込み元は codex CLI 自体で、素の実行（1）でも Owl 相当（3）でも起きる。同じ cwd の再実行（2）では変化しない。
- overlay の `config.toml`: `~/.owl/codex-home-overlays/owl-codex-home-5a5f33e6687e/config.toml` は **symlink**（`-> /Users/ryo/.codex/config.toml`）。Owl 経由の codex の書き込みは元の `~/.codex/config.toml` に届く（3 で確認）。
- 結論: 変化の原因は codex CLI の「新しい cwd の trust 記録」で、素の実行と Owl 経由の両方で起きる。Owl 固有の書き込みではない。ただし Owl 経由でも overlay の symlink 経由で `~/.codex/config.toml` が変わるため、「ユーザーのファイルを変えない」方針なら overlay 側で `config.toml` をコピーにする対応が要る（未実施。この Task の範囲外）。2026-09-28 16:35:23 → 01:05:53 の過去の変化も同種と推測されるが、当時の差分は残っておらず未確定。
- Owl 相当の argv は hooks の `--config`、`--model`、`marketplaces.openai-bundled.source` を省いている（`permission-hook.js` 未ビルドのため）。

### (3) Claude `-p` 経路での MCP の直接の証拠

実行（ユーザーの実 `~/.claude` を読むだけ。cwd はこの worktree）: `claude -p --output-format stream-json --verbose --permission-mode bypassPermissions --settings '{"claudeMdExcludes":["/Users/ryo/.claude/CLAUDE.md"]}' --model haiku -- "Use the mcp__serena__list_queryable_projects tool once ..."`。ログ: `/tmp/owl-d2b/logs/mcp.jsonl`。

- init イベントの `mcp_servers`: `serena`=connected、`claude.ai Claude Docs`=connected、`claude.ai Canva`=needs-auth、`claude.ai Gmail`=connected、`claude.ai Google Calendar`=connected、`claude.ai Google Drive`=connected。
- MCP tool 呼び出し: `mcp__serena__list_queryable_projects` を1回呼び、tool_result に project 一覧が返った（最終応答 `mcp_call=OK`）。**PASS**。
- 補足: Advisor 形式（stream-json 入力、`N` のログ）の init では、同じ server が `pending`（Canva は `needs-auth`）で、接続完了前の値だった。Advisor 経路の MCP 呼び出しは試しておらず未確定。Owl の `-p`（`buildWorkArgv`）の argv そのものでの MCP 呼び出しも未実施（上の実行は同等の `--permission-mode`/`--settings` を使った `claude -p`）。
