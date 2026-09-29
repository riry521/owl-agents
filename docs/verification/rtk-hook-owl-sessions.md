# RTK hook verification for Owl Claude sessions

実施日: 2026-09-28 (Asia/Tokyo)

## 結果

基準測定では、Owl が注入した環境変数を外した通常のシェル環境から、追加引数なしの Claude を起動した。rtk gain の前後差分は全体 145787 → 145788、rtk git status 413 → 414 で、Recent Commands に rtk git status -66% (42) が追加された。出力は Claude の通常の一行要約で、stream-json の tool_use は取得していない。

Owl の runExecutor、buildWorkArgv の Claude -p、Advisor --resume、新規 Advisor は、修正した Owl root と buildAgentEnv の実経路で直列に実行した。各実行で rtk git status が 1 件ずつ増え、各回の Recent Commands に rtk git status -66% (42) が加わった。rtk hook は基準と Owl の全モードで発火した。

前回の基準コマンドの余分な --output-format stream-json と --verbose は外した。Owl root に存在しない代用パスは使っていない。コード変更はなく、記録のみ更新した。ユーザーの ~/.claude/settings.json は編集せず、--setting-sources も使っていない。.env と secrets.json は直接読まず、秘密値は表示・記録していない。buildAgentEnv が実装上 .env を参照する処理は、そのまま実行して値は出力していない。

## コード経路と環境

確認した実装:

- apps/server/src/agent-env.ts の buildAgentEnv は owlRoot の .env にあるキーを除外し、CLAUDE_CODE_DISABLE_NONPROJECT_CLAUDE_MD=1 と OWL_ROOT を設定する。
- apps/server/src/agent-runner.ts の Executor runtime は resolveOwlRoot() の値を owlRoot として buildAgentEnv(process.env, { owlRoot, deny: customProviderApiKeyEnvNames(owlRoot), extra: { OWL_GUARD_API_BASE } }) に渡す。今回の owlRoot は /Users/ryo/owl-agents だった。
- packages/core/src/executor.ts の runExecutor は runtime.owlRoot と runtime.env から Claude の permission args を構成する。既定 config は Claude、JSON 出力、高 effort。
- packages/providers/argv.ts の buildWorkArgv と packages/shared/src/permission-args.ts の builder は Claude の -p と --settings を組み立てる。
- packages/agent-runtime/src/advisor-session-driver.ts は Advisor の新規・再開 argv を組み立てる。
- すべての Owl argv の --settings を確認し、claudeMdExcludes に /Users/ryo/.claude/CLAUDE.md、PreToolUse に matcher "*" と /Users/ryo/owl-agents/apps/server/dist/permission-hook.js が含まれていた。

環境は実際の Owl root /Users/ryo/owl-agents を指定し、createHybridExecutorRuntime から buildAgentEnv を呼ぶ経路で生成した。検証プロセスが引き継いだ一回ごとの OWL_AGENT_* と OWL_GUARD_TOKEN_FILE は base env 作成前に除外し、その後の child env には各モードの identity を加えた。extra の guard API base は http://127.0.0.1:3787。PATH から which rtk 相当で /opt/homebrew/bin/rtk が解決された。CLAUDE_CODE_DISABLE_NONPROJECT_CLAUDE_MD は 1 だった。

生成 env の非秘密な OWL_* は OWL_BIND=127.0.0.1、OWL_DATA_DIR=/Users/ryo/owl-agents/data、OWL_GUARD_API_BASE=http://127.0.0.1:3787、OWL_PORT=3787、OWL_ROOT=/Users/ryo/owl-agents。子プロセスには加えて OWL_AGENT_ROLE、OWL_AGENT_RUN_ID、OWL_AGENT_CWD と worker 用 guard token file が渡された。token file の値やパスは記録していない。

生成された PATH の各要素:

    /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-path
    /Users/ryo/owl-agents/bin
    /Users/ryo/.antigravity/antigravity/bin
    /Users/ryo/.local/bin/shogun-shims
    /Users/ryo/.local/bin
    /Users/ryo/.antigravity/antigravity/bin
    /Users/ryo/.pyenv/shims
    /Users/ryo/.pyenv/bin
    /opt/homebrew/bin
    /opt/homebrew/sbin
    /Users/ryo/.local/bin/shogun-shims
    /Users/ryo/.local/bin
    /Library/Frameworks/Python.framework/Versions/3.12/bin
    /Library/Frameworks/Python.framework/Versions/3.10/bin
    /usr/local/bin
    /System/Cryptexes/App/usr/bin
    /usr/bin
    /bin
    /usr/sbin
    /sbin
    /var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin
    /var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin
    /var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin
    /pkg/env/global/bin
    /Users/ryo/.codex/tmp/arg0/codex-arg0AhQ1wP
    /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-path
    /Users/ryo/owl-agents/bin
    /Users/ryo/.antigravity/antigravity/bin
    /Users/ryo/.pyenv/bin
    /Users/ryo/.lmstudio/bin
    /Users/ryo/.lmstudio/bin

現在の providerSelection は openai / codex-cli/v1、Claude executable は /Users/ryo/.local/bin/claude だった。runExecutor は Claude の既定 config で測定した。buildWorkArgv は今回の要件である Claude -p 経路を検証するため claude-cli/v1 を明示して構築した。よってこの buildWorkArgv の行は現在の openai/Codex の既定 AgentRunner 選択を示すものではない。provider やユーザー設定は変更していない。

## 直列測定

基準の argv は指定どおり次の引数だけだった。

    claude -p --permission-mode bypassPermissions 'Use the Bash tool to run git status exactly once, then report its result in one line.'

Owl 外・基準 (17:03) は実行直前 145787; rtk git status 413、直後 145788; 414。Recent Commands に追加された行は 09-28 17:03 ■ rtk git status -66% (42)。通常出力はブランチと untracked の docs/verification/ を示す一行だった。stream-json や追加の Claude 引数は使っていない。

Owl 実行はすべて逐次実行し、各 Claude 呼び出しの直前・直後に rtk gain --history を採取した。件数は「全体コマンド数; rtk git status の累計」。Advisor --resume のため、測定対象外として先に READY のみを返す session を用意した。この準備 session では Bash を依頼していない。

| モード | argv 要点 | gain 前 → 後 (全体; rtk git status) | 増分 | 追加された Recent Commands 行 | 結果 |
|---|---|---|---|---|---|
| Owl 外・基準 (17:03) | claude -p --permission-mode bypassPermissions <prompt> | 145787; 413 → 145788; 414 | +1; +1 | 09-28 17:03 ■ rtk git status -66% (42) | 発火 |
| Executor 新規 (17:10) | runExecutor; -p --output-format json、permission-mode bypassPermissions、Owl --settings、model claude-sonnet-5、effort high | 145806; 414 → 145807; 415 | +1; +1 | 09-28 17:10 ■ rtk git status -66% (42) | 発火 |
| buildWorkArgv の Claude -p (17:10) | -p --output-format json、同じ Owl --settings、model claude-sonnet-5、-- の後に prompt | 145807; 415 → 145808; 416 | +1; +1 | 09-28 17:10 ■ rtk git status -66% (42) | 発火 |
| Advisor --resume (17:10) | -p --output-format stream-json --input-format stream-json --verbose、Advisor permission args、--resume <session-id>、model claude-sonnet-5、effort low | 145808; 416 → 145809; 417 | +1; +1 | 09-28 17:10 ■ rtk git status -66% (42) | 発火 |
| Advisor 新規 (17:10) | 同じ Advisor argv、--session-id <generated-id> | 145809; 417 → 145810; 418 | +1; +1 | 09-28 17:10 ■ rtk git status -66% (42) | 発火 |

各 run の stdout は git status の結果を含む一行の要約だった。Advisor --resume と新規の argv には、実際の Driver が生成した --settings と claudeMdExcludes が入っている。PreToolUse の更新後コマンド自体は stream-json の tool event からは確認せず、gain 履歴の前後差分を観測根拠にした。

AdvisorSessionDriver には Advisor role の argv/settings を渡したが、この直接測定では現行 worker に発行済みの worker guard lease を再利用したため、子 env の OWL_AGENT_ROLE は worker だった。実セッションの Advisor role token issuer をこの検証プロセスから呼び出す経路はなく、Advisor 用 token までは再現していない。git status は worker scope で許可され、RTK hook の増分が記録された。role scope 自体は既存 guard test で確認した。

## Guard hook

全 Owl run の argv に guard の PreToolUse hook が含まれ、許可された git status が実行された。さらに build 後、既存の permission-hook 関連テストを実行した:

    node --test --test-reporter=spec apps/server/dist/permission-hook.test.js tests/permission-hook-integration.test.mjs tests/agent-permission-args.test.mjs
    20 tests, 20 pass, 0 fail

統合テストで危険な Bash JSON の deny、role/token scope の不一致の拒否、許可ケースを確認した。危険な git push 自体は実行しない。

## 最終チェック

- pnpm --silent build — exit 0。
- pnpm --silent typecheck — exit 0。
- pnpm --silent test — 1,076 pass、0 fail、0 skipped、exit 0。
- コードとユニットテストは変更なし。docs/verification/rtk-hook-owl-sessions.md の記録だけ更新した。
