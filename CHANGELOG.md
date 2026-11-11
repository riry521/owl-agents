## 0.17.0 - 2026-11-12

内部のコードを整理し、あわせていくつかの不具合を直しました。互換のない変更が 1 つあります。

- 古い executor 設定の API `/api/v1/settings/executor` を消した。子エージェントの既定の設定は `/api/v1/settings/child-runs` で読み書きする
- Advisor の会話にある `.md` へのリンクを、Markdown ビュアーで開くようにした
- Task の多い Work でも、最終チェックが Prompt is too long で止まらないようにした
- API のエラー文を、Owner の言語の設定に合わせるようにした
- 内部のコードを整理した（大きなファイルの分割、重複した処理の統一、使われないコードの削除）

## 0.16.1 - 2026-11-11

GitHub の CI が通るように、テストファイルの名前を規則に合わせました。利用者から見た動きの変化はありません。

## 0.16.0 - 2026-11-11

DB とデータフォルダが増え続けないように、使わなくなったデータを自動で消すようにしました。

### データの片付け

- 通ったテストの出力は DB に保存しないようにした。保存済みの分は、更新後の最初の起動で消し、DB を 1 回だけ詰め直す（VACUUM）。DB が大きいと、この起動には数分かかる
- Work が終わったとき（と起動時）に、終わった Work の後で読まないデータを消すようにした。送信済みの通知、レビューの検証レポート、Task ごとの最新以外の報告、一部のイベントの中身が対象。Work・Task・イベントの行そのものは残す
- `data/artifacts` の保存ファイルは、Work が終わってから 14 日たつと消すようにした（1 時間ごとに確認）
- Core とテストが `/tmp` に作る一時ファイルとフォルダを、使い終わったときかプロセスの終了時に消すようにした

### Advisor

- Advisor が `create_work` の `size` や `project_id` を `payload` の外に書いても、Core が `payload` の中に移して受け付けるようにした

## 0.15.0 - 2026-11-10

全件テストを流す場所が Work の最後に変わり、Owner が指定した受け入れ条件の扱いが明確になりました。あわせて、内部のコードを大きく整理しました。

### 全件テスト

- 全件テストは、Task の中ではなく Work の最後に Core が 1 回だけ流す。Worker は全件テストを流さず、自分が変えた範囲のテストだけを流す
- Advisor が書く受け入れ条件に、全件テストの実行を入れないようにした。Worker が時間切れの中で全件テストを流し、途中の結果を繰り返し直す問題を防ぐ
- Manager と Worker の指示にも、Work の最後に Core が全件を流すことを明記した

### Owner の受け入れ条件と目標

- Owner 指定の受け入れ条件として扱うのは、概要の「受け入れ条件:」「目標:」と、Owner の指示と Decision 回答からの引用だけにした。概要のそれ以外の文は条件として写さない
- Task の外にある状態（本番の状態や別の Work など）に頼る条件を Reviewer が見つけたときは、Manager に返して条件を直させる
- Manager が Owner の条件を外したときは、外したことと理由を記録する
- 目標（goal）の条件は、外の状態に頼ってよいものとして、その検査から外した
- 試行回数の上限（レビュー、作り直し、自動復旧、進捗ガードなど）を、`docs/operations.md` に一覧にした

### 内部の整理

- `core.ts` から Manager の進行と Advisor の操作を、ワークフローエンジンから複数の処理を、別ファイルへ分けた
- API を経路の表で持つようにし、OpenAPI の記述と照合するテストを足した
- 重複していた設定、プロセス、コネクタ、エラーの処理を 1 か所にまとめた
- 使われていないコードと、食い違っていた一覧の記述を削除・修正した
- 再計画の待ち行列と、設計・一時停止の印を、専用のテーブルへ移した
- 「原因を確かめ、既存の仕組みを使ってから足す」ルールを足した

## 0.14.0 - 2026-11-09

メモリ検索が、言い換えや別の言語で書いた資料も見つけられるようになりました。Advisor の会話の「要約を保存」は、やりとりの要約を保存するようになりました。

### メモリ検索

- 多言語の埋め込みモデル（既定は `Xenova/multilingual-e5-small`、約 130 MB）を使った意味検索を、`./setup.sh` で使えるようにした。setup はモデルを `data/models` にダウンロードし、埋め込みを有効にする。ダウンロードに失敗しても、警告を出して先へ進む
- `owl embeddings` コマンドを足した。モデルのダウンロード、埋め込みの有効化、ベクトルのない記事の埋め込みを行い、件数とかかった時間を表示する。2 回目以降は差分だけを埋め込む
- 埋め込みの対象は、既定で clipping と material の記事。モデル名や区切り方が変わったときは全件を作り直す
- 埋め込みが使えないとき（無効、モデルがない、読み込めない、時間切れなど）も、検索は言葉の一致だけで答える。理由は `/api/v1/memory/health` に出る。検索のときにモデルをダウンロードすることはない
- 埋め込みを使わないときは、setup の前に `.env` へ `OWL_MEMORY_EMBEDDINGS_ENABLED=false` を書く
- 保存する research の要約を改善し、検索に使うキーワードも保存するようにした

### Advisor

- 会話の「要約を保存」で、やりとりの要約を保存するようにした。ファイル名には、今の会話の ID と題名を使う
- 保存したことを知らせる表示は、数秒で消える

### ルール

- Web ページや GitHub リポジトリの本文は WebFetch で読むという既定のルールを足した

## 0.13.0 - 2026-11-08

Web UI で Markdown を読めるようになり、Advisor のチャットにファイルを添付できるようになりました。Advisor が送るファイルを Slack・Discord の窓のチャンネルへ届けられるようになり、サーバーを止められなくなったときの復旧手段も加わりました。

### Markdown ビュアー

- Work の詳細と最終報告に出る Markdown のファイルを、Owl の画面で読めるようにした。目次、表、画像に対応する
- 読めるのは、その Work のプロジェクトと materials フォルダにある `.md` ファイルだけ。シークレットを含みうるファイルと、2 MiB を超えるファイルは開けない
- Work がまだ統合されていないときは、Work のブランチの内容を表示する。完了するまでに変わる可能性があると画面に出す
- ファイルを開けないときは、理由（範囲外、見つからない、大きすぎる、読めない）を画面に出す

### Advisor

- Web のチャットの表示に、Advisor の状態（考え中、ツールの実行中、サブエージェントの実行中、バックグラウンドの実行数）が出るようにした
- Advisor のチャット欄と Work の指示欄に、ファイルを添付できる。ドラッグ＆ドロップ、貼り付け、クリップのボタンのどれでも添付できる。1 ファイルは 50 MiB まで、1 回のメッセージに 20 ファイルまで。実行できるファイルは隔離され、エージェントには渡らない
- 添付だけで、本文なしでも送れる
- Advisor の返答に出る materials と共有フォルダのファイルのパスを、リンクにした。押すと、そのファイルやフォルダの中身を新しいタブで開く。この 2 つのフォルダの外と、シークレットを含みうるファイルは開けない

### Slack・Discord へのファイル送信

- Web UI の Advisor が `send_file` で送るファイルを、Slack・Discord のチャンネルへ届けられるようにした。送信先は、その会話の窓に紐づいたチャンネルになる。送信の結果（送信中、送信済み、失敗、送らなかった理由）は、チャットに出る
- 窓に Slack と Discord の両方のチャンネルがあるときは、優先するプラットフォームに送る。優先を決めていないときは、何も送らず、その理由を返す
- 窓にチャンネルがない会話（全体の窓など）のために、既定の送信先を決められる
- 優先するプラットフォームと既定の送信先は、設定画面の「ファイルの送信先」で決める。既定の送信先は、会話チャンネルと窓のチャンネルから選ぶ

### サーバーの停止と起動

- サーバーの終了処理に期限を付けた。既定は 25 秒で、`OWL_SHUTDOWN_TIMEOUT_MS` で変えられる。期限を過ぎると、残った子プロセスを止めて終了する。終了中にもう一度シグナルを受けたときも、同じように終了する
- サーバーが生きているのに応答しないとき、`owl status` は `unresponsive` と出し、`owl stop --force` または `owl restart` で復旧できると案内する。`owl start` も、同じ案内を出して止まる
- `owl stop --force` は、`system/status` の応答を待たずに止める。`owl restart` は、SIGTERM、SIGINT、SIGKILL の順に強めて止めてから起動する
- `owl stop` の既定の待ち時間は、終了処理の期限に 5 秒を足した長さになった
- 状態ファイルの PID が Owl のサーバーでないときは、シグナルを送らずに止まる
- 起動が速くなった。起動時に完了した Work を調べる処理に索引を足した。無視されたファイルが残っていて片付けられない worktree は、同じ失敗を起動のたびに繰り返さない
- `server.log` の各行の先頭に、ISO 8601 形式の時刻を付けた

## 0.12.3 - 2026-11-03

軽微修正。

### 修正

- 依存パッケージの脆弱性に対応した（next を 15.5.28 に更新し、undici と follow-redirects を修正版に固定）。

## 0.12.2 - 2026-11-03

軽微修正。

### 修正

- エージェントを同時に起動しても Serena の設定ファイルの中身が欠けないように、Owl が起動の前に worktree を Serena に登録するようにした

### ルール

- 同梱の基本ルールに「目の前の1件だけに合わせず、汎用的な作りを優先する」を足した

## 0.12.1 - 2026-11-03

軽微修正。アプリの動作は変わりません。

## 0.12.0 - 2026-11-03

失敗の知らせ・定期の見回り・GitHub の Issue や PR コメントをきっかけに、Work を自動で作れるようになりました。Advisor の停止ボタンとクリアボタンも使いやすくなりました。

### Work の自動作成

- 失敗の知らせ（監視中のプロセスやログの失敗、`POST /api/v1/auto-work/notices`）、定期の見回り、GitHub の Issue と PR コメントをきっかけに、Work を自動で作る。既定ではオフで、設定 → Auto Work creation でプロジェクトごとに切り替える
- 設定は `rules/auto-work/defaults.json`（git 管理）と、git に入れない `local.json`・`projects/<project_id>.json` に置く。履歴タブで、何が起きたか、なぜそうなったかを確かめられる

### Advisor

- 停止ボタンが透明になって見えなかった問題を直し、送信ボタンと同じ赤いグラデーションにした
- 会話のクリアを、メニューの中からゴミ箱ボタンに出した。1回の操作で押せる

### Worker

- 道具の中で動く agent CLI を、integration_check の対象から外した

## 0.11.0 - 2026-11-01

ルール・Advisor・計画の扱いが広がりました。プロジェクト別のルール、Advisor の停止ボタンと未読の点、大きな画面変更の前の画面設計が加わりました。

### ルール

- プロジェクトごとのルール（`rules/project/{project_id}.yaml`）を足した。そのプロジェクトの Work の各役割と、そのプロジェクトの窓の Advisor にだけ届く。このファイルには instruction のルールだけを書ける
- 注意を受け入れ条件に入れないためのルールを標準で同梱した。Advisor が既存のルールと重なる禁止事項を足し続け、Manager がそれを全 Task の受け入れ条件へ写して「証明できない条件」の Decision で止まる問題を防ぐ。同梱するルールの文は最初の一文に絞った

### Advisor

- Advisor のウィンドウに、まだ読んでいないメッセージがあるとき点を出す。既読の状態はサーバーが持つので、端末が違っても同じ点が出る
- Advisor がターンを処理している間に、停止ボタンでそのターンを中断できる。Claude と Codex のどちらでも使える

### 計画と Decision

- 受け入れ条件そのものを変える Decision の回答は、Manager による計画のやり直しへ回す
- Project の `screen_paths` に画面のファイルを登録すると、大きな画面変更を含む計画には画面設計の Task が必須になる。設計のない Task が画面ファイルを新しく作ろうとすると書き込みが止まり、画面設計が必要だと報告される

### Fixer と Reviewer

- 同じ箇所のやり直しが繰り返されるときは、Fixer に渡す前に止める。レビューの観点のルールも書き直した

### ドキュメント

- README と docs/operations.md に、プロジェクト別のルール、Advisor の未読の点と停止ボタン、画面のファイルの登録を足した

## 0.10.0 - 2026-10-28

ボードとアーカイブをプロジェクト別に見られるようになり、完了した Work に最終報告の要約が付きました。Advisor と計画のやり直しの不具合も直しました。

### 画面

- ボードとアーカイブで、Work をプロジェクトごとの見出しにまとめて表示するようにした。ボードの見出しには区切り線とプロジェクトごとの件数を付け、アーカイブも同じ見た目にした
- 完了した Work の詳細の先頭に、Manager が書いた最終報告を表示するようにした

### Advisor

- Advisor のセッションは、ターンが完了したあとにだけ再開し、失敗したときは1回だけ送り直すようにした
- owl-actions が失敗したときに、Advisor がもう1ターンだけ動いて対処するようにした

### 修正

- Reviewer が受け入れ条件の不備を報告したとき、Manager が条件を書き直しても毎回却下され、計画のやり直しが止まらなかった不具合を直した。Manager への指示を直し、Core でも不足している `criteria_relaxations` の項目を補うようにした
- 受け入れ条件の不備で止まった Decision に、失敗の理由が「no failure reason recorded」と出ていた表示を、実際の理由が出るように直した

## 0.9.0 - 2026-10-27

テストを、準備したディレクトリから、動かせる最も細かい単位で動かせるようになりました。

### テスト

- `test_run` の `cwd` を、`per_file` モードでも "." 以外にできるようにした
- `per_file` モードで、1回のコマンドが対象とする単位を `unit`（`file`・`folder`・`package`）で選べるようにした。`folder` と `package` は `unit_argv`（`{unit}` を1つ含む）で動かし、`package` は `unit_markers` に一致するファイルがあるフォルダを単位にする
- テストの準備を調べる Agent は、`unit` を `file`、`folder`、`package` の順に試し、動いた最も細かい単位を保存する

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
