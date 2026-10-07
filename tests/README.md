# tests/

Owl のテストの置き場所と、テストを足すときの決まり。

## どこに何を置くか

| 場所 | 置くもの |
|---|---|
| `tests/<機能>/*.test.mjs` | リポジトリ全体をまたぐテスト。機能別ディレクトリに置く（`work`・`task`・`agent`・`api`・`web`・`knowledge` など）。使える機能ディレクトリと、それぞれの持ち物は `tests/layout.json` の `directories` が定義する |
| `tests/helpers/` | 複数のテストが使う補助（一時ディレクトリ `temp.mjs`、Core・DB・コマンド封筒 `core.mjs`・`db.mjs`、待機 `wait.mjs`、git `git.mjs`、HTTP `http.mjs` など）。テストファイル（`*.test.mjs`）は置かない |
| `tests/fixtures/` | テストが読む入力データ。テストファイルは置かない |
| `packages/*/test/` | そのパッケージ 1 つの中で閉じる単体テスト。他パッケージや Core 全体を組み立てるテストは `tests/<機能>/` に置く |
| `tests/layout.json`・`tests/required-tests.json`・`tests/hardcode-checks.json` | `tests/` 直下に置いてよいのは、この 3 ファイルとこの README だけ。`tests/` 直下に `*.test.mjs` は置かない |

ファイル名に使えない語（番号だけ、`stage1`・`phase2`・`regression(s)`・`misc` など）も `tests/layout.json` の `forbidden_name_segments` で決まっている。

## 必須テストと全件テストの違い

| コマンド | 何を動かすか | いつ使うか |
|---|---|---|
| `pnpm test:required` | `tests/required-tests.json` に載せたテストだけ（`scripts/run-required-tests.mjs` が動かす） | マージ前の関門。落ちると統合できない。少なく保つ |
| `pnpm test` | `tests/**/*.test.mjs` すべて | 変更したあとの通常の確認 |
| `pnpm test:nightly` | `pnpm test:prepare` でチェックアウトを整えてから、`tests/**/*.test.mjs` を `tap` 形式で動かす | 夜間の全件確認。結果を機械で集計する |
| `pnpm test:gate` | `pnpm test:prepare` のあと `pnpm test:required` | 関門と同じ手順をローカルで再現する |
| `pnpm test:layout` | 置き場所チェック（`scripts/check-test-layout.mjs tests/layout.json`） | 下の決まりを守っているかの確認 |
| `pnpm test:hardcode` | 決め打ちチェック（`scripts/check-test-hardcode.mjs tests/hardcode-checks.json`） | 期待値に現在の値を写していないかの確認。数秒で終わる |

`packages/*/test` のテストは、各パッケージの `test` スクリプト（`pnpm --filter <パッケージ> test`）か、`node --test "packages/*/test/**/*.test.mjs"` で動かす。`pnpm test` には含まれない。

必須テストの一覧は `tests/required-tests.json`。テストを移動・改名・削除したら、この一覧のパスも直す。

## 新しくテストを足すときの決まり

1. まず既存の機能別ファイルに足す。同じ機能のファイルがあれば、そこに `test()` を加える。
2. 新しいファイルを作るのは、新しい機能のときだけ。置き場所は機能別ディレクトリ（新しい機能ならまず `tests/layout.json` の `directories` に追加する）で、`tests/` 直下には作らない。
3. 重複を見つけたら、増やさずに直す。同じ入力・同じ守りのテストは 1 つにまとめ、assert は捨てない。消した・統合した理由は PR や Task の報告に書く。
4. 一時ディレクトリ・Core・DB・待機・git・HTTP サーバー・コマンド封筒を自前で組み立てない。`tests/helpers/` のものを使う。足りないときは helpers に足す。
5. テスト名は英語で、仕様を言い切る。通し番号（`(a)`・`stage4` など）や `regression` は付けない。
6. 終えたら `pnpm test:layout` と `pnpm test:hardcode` が終了コード 0 で通ることを確かめる。

```sh
pnpm test:layout
pnpm test:hardcode
```

## テストの書き方（4 点）

1. 現在の値を写さず、性質で比べる（件数の下限、含むべき要素、形式、順序関係）。
2. 外から見える結果（API の応答、保存された状態、出力）を確かめる。内部の途中経過に依存しない。
3. 時刻・PATH・HOME・実行順に頼らない。必要なら引数や環境で固定する。
4. テスト名は「何を守るか」を 1 文で書く。

## テストの扱い

- **隔離**: base でも落ちるテストファイルは隔離され、Work 全体のテスト実行では飛ばされる。隔離されると Core が同じ Work に「落ちているテストを直す」Task をファイルごとに 1 件足す（Manager の再計画は通さず、本来の Task とは依存せず、失敗しても Work は止まらない。同じファイルの Task が既にあれば足し直さない）。足した直後は Final Manager に進まず、その Task を実行して Work ブランチに取り込んでから進む。コードの不具合ならコードを、テストが古ければテストを直し、テストを消すのは仕様自体がなくなったときだけ。
- **要求のないテストファイルの削除**: `kind: spec_test` の受け入れ条件がない Task（type は問わない）で増えたテストファイルは、Core がマージ前に削除する。作業確認のためだけのテストは残さない。
- **Reviewer**: テストを実行しない。Core が実行したテスト結果についての指摘はバックログに入らない。
- **決め打ちチェック**: `pnpm test:hardcode` は `tests/hardcode-checks.json` の規則で、64 桁のハッシュ値を期待値にした比較と、8 件以上の文字列一覧の丸ごと一致を探す。違反は `<path>:<line>: <rule-id>: <message>` で出て、終了コード 1 になる（設定エラーは 2）。性質で比べる形に直すのが基本。どうしても必要な行だけ、その行か直前の行に次の形で書いて除外する。理由が空だと除外にならない。

  ```js
  // hardcode-check-allow whole-list-equal: <理由>
  ```
- **`test_policy`**（Project 設定。Owner が `PATCH /api/v1/projects/<id>` で設定する。Worker は `check_commands` を報告前に実行する）:

  | キー | 意味 | 既定値 |
  |---|---|---|
  | `reviewer_denied_commands` | Reviewer に拒否する追加コマンド（前方一致） | `[]` |
  | `check_commands` | Core が検証で Task worktree で実行するチェックコマンド（argv の配列） | `[]` |

  例: `{"test_policy":{"check_commands":[["pnpm","test:hardcode"]]}}`
